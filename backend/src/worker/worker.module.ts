import { Inject, Logger, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { type Job, Queue, Worker } from 'bullmq';
import type pg from 'pg';
import { expireChatImages } from '../chat/chat-expiry.js';
import { ENV, type Env } from '../config/env.js';
import { CoreModule, PG_POOL } from '../core.module.js';
import { archivePastEvents } from '../events/event-archive.js';
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
import { IMPORT_JOB, MAINTENANCE_JOBS, PUSH_JOB, QUEUES } from './queues.js';

/**
 * Tugas latar. Modul berikutnya menambah prosesor: kedaluwarsa gambar chat (1.6),
 * arsip event (1.7), notifikasi (1.9), impor Garmin/Strava (2.3), engine event (2.4).
 */
@Module({
  imports: [CoreModule],
  // Impor (modul 2.3) butuh penulis lari + lencana (+ notifikasi). RealtimeService tanpa server HTTP hanya
  // menerbitkan sinyal lewat Redis.
  providers: [StorageService, TokenService, RealtimeService, PushQueue, NotificationsService, BadgesService, ProviderHttp, ImportWriter, ImportQueue, ImportsService],
})
export class WorkerModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Worker');
  private queue?: Queue;
  private worker?: Worker;
  private pushWorker?: Worker;
  private importWorker?: Worker;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly storage: StorageService,
    private readonly crypto: FieldCrypto,
    private readonly imports: ImportsService,
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
    this.importWorker.on('failed', (job, err) => this.logger.warn(`Impor ${job?.data?.kind ?? '?'} gagal (percobaan ${job?.attemptsMade ?? '?'}): ${err.message}`));
  }

  private process(job: Job): Promise<unknown> {
    switch (job.name) {
      case MAINTENANCE_JOBS.heartbeat:
        return Promise.resolve({ at: new Date().toISOString() });
      case MAINTENANCE_JOBS.chatImageExpiry:
        return expireChatImages(this.pool, this.storage).then((expired) => ({ expired }));
      case MAINTENANCE_JOBS.eventArchive:
        return archivePastEvents(this.pool).then((archived) => ({ archived }));
      default:
        return Promise.reject(new Error(`Job tidak dikenal: ${job.name}`));
    }
  }

  async onApplicationShutdown() {
    await this.worker?.close();
    await this.pushWorker?.close();
    await this.importWorker?.close();
    await this.queue?.close();
  }
}
