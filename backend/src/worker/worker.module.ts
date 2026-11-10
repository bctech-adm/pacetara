import { Inject, Logger, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { type Job, Queue, Worker } from 'bullmq';
import type pg from 'pg';
import { expireChatImages } from '../chat/chat-expiry.js';
import { ENV, type Env } from '../config/env.js';
import { CoreModule, PG_POOL } from '../core.module.js';
import { archivePastEvents } from '../events/event-archive.js';
import { StorageService } from '../storage/storage.service.js';
import { MAINTENANCE_JOBS, QUEUES } from './queues.js';

/**
 * Tugas latar. Modul berikutnya menambah prosesor: kedaluwarsa gambar chat (1.6),
 * arsip event (1.7), notifikasi (1.9), impor Garmin (2.3), engine event (2.4).
 */
@Module({ imports: [CoreModule], providers: [StorageService] })
export class WorkerModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Worker');
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly storage: StorageService,
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
    await this.queue?.close();
  }
}
