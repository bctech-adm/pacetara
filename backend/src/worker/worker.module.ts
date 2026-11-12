import { Inject, Logger, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { type Job, Queue, Worker } from 'bullmq';
import type pg from 'pg';
import { expireChatImages } from '../chat/chat-expiry.js';
import { ENV, type Env } from '../config/env.js';
import { CoreModule, PG_POOL } from '../core.module.js';
import { archivePastEvents, expireStaleSubmissions } from '../events/event-archive.js';
import { EventsService } from '../events/events.service.js';
import { EventScraper } from '../event-engine/event-scraper.js';
import { EventSubmissionsService } from '../event-engine/event-submissions.service.js';
import { ScrapeHttp } from '../event-engine/scrape-http.js';
import { FieldCrypto } from '../crypto/field-crypto.js';
import { ImportQueue } from '../imports/import-queue.js';
import { ImportWriter } from '../imports/import-writer.js';
import { ImportsService } from '../imports/imports.service.js';
import { ProviderHttp } from '../imports/provider-http.js';
import type { ImportJob } from '../imports/types.js';
import { TokenService } from '../auth/token.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { BadgesService } from '../passport/badges.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { FcmSender, type PushJob, PushQueue, sendPushJob } from '../notifications/push.js';
import { StorageService } from '../storage/storage.service.js';
import { PubSubOidcVerifier } from '../subscriptions/oidc.js';
import { PlayApi } from '../subscriptions/play-api.js';
import { type SubscriptionJob, SubscriptionQueue } from '../subscriptions/subscription-queue.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import { LeagueService } from '../league/league.service.js';
import { expireKycReviews } from '../kyc/kyc-expiry.js';
import { MarketOrderSync } from '../market/market-orders.js';
import { XenditApi } from '../market/xendit.js';
import { MidtransApi } from '../payments/midtrans.js';
import { PaymentsService } from '../payments/payments.service.js';
import { SchedulesService } from '../schedules/schedules.service.js';
import { IMPORT_JOB, MAINTENANCE_JOBS, PUSH_JOB, QUEUES, SUBSCRIPTION_JOB } from './queues.js';

/**
 * Tugas latar. Modul berikutnya menambah prosesor: kedaluwarsa gambar chat (1.6),
 * arsip event (1.7), notifikasi (1.9), impor Garmin/Strava (2.3), scraping event (2.4), langganan Play (2.5).
 */
@Module({
  imports: [CoreModule],
  // Impor (modul 2.3) butuh penulis lari + lencana (+ notifikasi). RealtimeService tanpa server HTTP hanya
  // menerbitkan sinyal lewat Redis.
  providers: [
    StorageService,
    TokenService,
    RealtimeService,
    PushQueue,
    NotificationsService,
    BadgesService,
    ProviderHttp,
    ImportWriter,
    ImportQueue,
    ImportsService,
    // Engine event (modul 2.4): scraping terjadwal ke antrean event_submissions.
    EventsService,
    EventSubmissionsService,
    ScrapeHttp,
    EventScraper,
    // Langganan (modul 2.5): sinkron RTDN dan rekonsiliasi berkala.
    PlayApi,
    PubSubOidcVerifier,
    SubscriptionQueue,
    SubscriptionsService,
    // Modul 2.6: pembentukan sesi jadwal rutin + pengingat, snapshot liga.
    SchedulesService,
    LeagueService,
    // Modul 3.2/3.3: sinkron pesanan Xendit dan pembayaran Midtrans.
    XenditApi,
    MarketOrderSync,
    MidtransApi,
    PaymentsService,
  ],
})
export class WorkerModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Worker');
  private queue?: Queue;
  private worker?: Worker;
  private pushWorker?: Worker;
  private importWorker?: Worker;
  private subscriptionWorker?: Worker;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly storage: StorageService,
    private readonly crypto: FieldCrypto,
    private readonly imports: ImportsService,
    private readonly scraper: EventScraper,
    private readonly subscriptions: SubscriptionsService,
    private readonly schedules: SchedulesService,
    private readonly league: LeagueService,
    private readonly marketOrders: MarketOrderSync,
    private readonly payments: PaymentsService,
  ) {}

  async onModuleInit() {
    const connection = { url: this.env.REDIS_URL, maxRetriesPerRequest: null };
    this.queue = new Queue(QUEUES.maintenance, { connection });
    await this.queue.upsertJobScheduler(
      'heartbeat-every-5m',
      { every: 5 * 60_000 },
      { name: MAINTENANCE_JOBS.heartbeat, opts: { removeOnComplete: 10, removeOnFail: 50 } },
    );

    // Gambar chat > 6 bulan dihapus dari penyimpanan (PRD 1.6). Tiap jam, maksimal 500 per putaran.
    await this.queue.upsertJobScheduler(
      'chat-image-expiry-hourly',
      { every: 60 * 60_000 },
      { name: MAINTENANCE_JOBS.chatImageExpiry, opts: { removeOnComplete: 10, removeOnFail: 50 } },
    );

    // Event diarsipkan sehari setelah tanggalnya (PRD 1.7). Tiap jam.
    await this.queue.upsertJobScheduler(
      'event-archive-hourly',
      { every: 60 * 60_000 },
      { name: MAINTENANCE_JOBS.eventArchive, opts: { removeOnComplete: 10, removeOnFail: 50 } },
    );

    // Scraping event (modul 2.4). Hanya jika pemilik mengisi EVENT_SCRAPE_SOURCES; selain itu jadwal dihapus.
    if (this.scraper.enabled) {
      await this.queue.upsertJobScheduler(
        'event-scrape',
        { every: this.env.EVENT_SCRAPE_INTERVAL_HOURS * 3_600_000 },
        { name: MAINTENANCE_JOBS.eventScrape, opts: { removeOnComplete: 10, removeOnFail: 50, attempts: 1 } },
      );
      this.logger.log(`Scraping event aktif: ${this.scraper.sources.map((s) => s.id).join(', ')}`);
    } else {
      await this.queue.removeJobScheduler('event-scrape');
    }

    // Langganan (modul 2.5): paket yang lewat masa berlaku diturunkan, langganan bermasalah/mendekati habis disinkronkan
    // ke Google, refund yang terlewat dicek. Selalu dijadwalkan karena pemberian paket manual juga berakhir.
    await this.queue.upsertJobScheduler(
      'subscription-reconcile',
      { every: 30 * 60_000 },
      { name: MAINTENANCE_JOBS.subscriptionReconcile, opts: { removeOnComplete: 10, removeOnFail: 50, attempts: 1 } },
    );

    // Modul 2.6: sesi dari jadwal rutin dibentuk 28 hari ke depan dan pengingat 2 jam sebelum sesi. Tiap 15 menit.
    await this.queue.upsertJobScheduler(
      'community-sessions',
      { every: 15 * 60_000 },
      { name: MAINTENANCE_JOBS.communitySessions, opts: { removeOnComplete: 10, removeOnFail: 50, attempts: 1 } },
    );
    // Snapshot liga antar komunitas (bulan berjalan + bulan lalu sampai tanggal 3). Tiap jam.
    await this.queue.upsertJobScheduler(
      'league-snapshot-hourly',
      { every: 60 * 60_000 },
      { name: MAINTENANCE_JOBS.leagueSnapshot, opts: { removeOnComplete: 10, removeOnFail: 50, attempts: 1 } },
    );

    // Modul 3.1: tinjauan verifikasi KTP > 30 hari kedaluwarsa (data tinjauan dihapus). Tiap jam.
    await this.queue.upsertJobScheduler(
      'kyc-review-expiry-hourly',
      { every: 60 * 60_000 },
      { name: MAINTENANCE_JOBS.kycReviewExpiry, opts: { removeOnComplete: 10, removeOnFail: 50, attempts: 1 } },
    );

    // Modul 3.2/3.3: pemeliharaan marketplace + rekonsiliasi pembayaran Midtrans. Tiap 15 menit.
    await this.queue.upsertJobScheduler(
      'market-maintenance',
      { every: 15 * 60_000 },
      { name: MAINTENANCE_JOBS.marketMaintenance, opts: { removeOnComplete: 10, removeOnFail: 50, attempts: 1 } },
    );

    this.worker = new Worker(QUEUES.maintenance, (job) => this.process(job), { connection, concurrency: 2 });
    this.worker.on('failed', (job, err) => this.logger.error(`Job ${job?.name ?? '?'} gagal: ${err.message}`));

    // Push FCM (modul 1.9). Tanpa FCM_SERVICE_ACCOUNT_B64 job tetap diambil tetapi tidak mengirim apa pun.
    const fcm = new FcmSender(this.env.FCM_SERVICE_ACCOUNT_B64);
    if (!fcm.enabled) this.logger.log('FCM belum dikonfigurasi; push dimatikan');
    this.pushWorker = new Worker(
      QUEUES.notifications,
      (job: Job<PushJob>) => (job.name === PUSH_JOB ? sendPushJob(this.pool, this.crypto, fcm, job.data) : Promise.reject(new Error(`Job tidak dikenal: ${job.name}`))),
      { connection, concurrency: 4 },
    );
    this.pushWorker.on('failed', (job, err) => this.logger.warn(`Push gagal (percobaan ${job?.attemptsMade ?? '?'}): ${err.message}`));

    // Impor Garmin/Strava (modul 2.3). Concurrency kecil: batas laju API penyedia.
    this.importWorker = new Worker(
      QUEUES.imports,
      (job: Job<ImportJob>) => (job.name === IMPORT_JOB ? this.imports.process(job.data) : Promise.reject(new Error(`Job tidak dikenal: ${job.name}`))),
      { connection, concurrency: 2 },
    );
    // Hanya jenis job dan pesan galat (tanpa token/isi); pesan ProviderHttpError hanya berisi host + status.
    // Sinkron langganan dari RTDN (modul 2.5). Pesan galat hanya status HTTP Google (tanpa token).
    this.subscriptionWorker = new Worker(
      QUEUES.subscriptions,
      (job: Job<SubscriptionJob>) => (job.name === SUBSCRIPTION_JOB ? this.subscriptions.processJob(job.data) : Promise.reject(new Error(`Job tidak dikenal: ${job.name}`))),
      { connection, concurrency: 2 },
    );
    this.subscriptionWorker.on('failed', (job, err) => this.logger.warn(`Sinkron langganan gagal (percobaan ${job?.attemptsMade ?? '?'}): ${err.message}`));
    this.importWorker.on('failed', (job, err) => this.logger.warn(`Impor ${job?.data?.kind ?? '?'} gagal (percobaan ${job?.attemptsMade ?? '?'}): ${err.message}`));
  }

  private process(job: Job): Promise<unknown> {
    switch (job.name) {
      case MAINTENANCE_JOBS.heartbeat:
        return Promise.resolve({ at: new Date().toISOString() });
      case MAINTENANCE_JOBS.chatImageExpiry:
        return expireChatImages(this.pool, this.storage).then((expired) => ({ expired }));
      case MAINTENANCE_JOBS.eventArchive:
        return Promise.all([archivePastEvents(this.pool), expireStaleSubmissions(this.pool)]).then(([archived, expiredSubmissions]) => ({ archived, expiredSubmissions }));
      case MAINTENANCE_JOBS.eventScrape:
        return this.scraper.runAll().then((stats) => ({ stats }));
      case MAINTENANCE_JOBS.subscriptionReconcile:
        return this.subscriptions.reconcile();
      case MAINTENANCE_JOBS.communitySessions:
        return this.schedules.runJobs();
      case MAINTENANCE_JOBS.leagueSnapshot:
        return this.league.runJob();
      case MAINTENANCE_JOBS.marketMaintenance:
        return Promise.all([this.marketOrders.maintenance(), this.payments.reconcile()]).then(([market, payments]) => ({ market, payments }));
      case MAINTENANCE_JOBS.kycReviewExpiry:
        return expireKycReviews(this.pool).then((expired) => ({ expired }));
      default:
        return Promise.reject(new Error(`Job tidak dikenal: ${job.name}`));
    }
  }

  async onApplicationShutdown() {
    await this.worker?.close();
    await this.pushWorker?.close();
    await this.importWorker?.close();
    await this.subscriptionWorker?.close();
    await this.queue?.close();
  }
}
