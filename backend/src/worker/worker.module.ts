import { Inject, Logger, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { type Job, Queue, Worker } from 'bullmq';
import { ENV, type Env } from '../config/env.js';
import { CoreModule } from '../core.module.js';
import { MAINTENANCE_JOBS, QUEUES } from './queues.js';

/**
 * Tugas latar. Modul berikutnya menambah prosesor: kedaluwarsa gambar chat (1.6),
 * arsip event (1.7), notifikasi (1.9), impor Garmin (2.3), engine event (2.4).
 */
@Module({ imports: [CoreModule] })
export class WorkerModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Worker');
  private queue?: Queue;
  private worker?: Worker;

  constructor(@Inject(ENV) private readonly env: Env) {}

  async onModuleInit() {
    const connection = { url: this.env.REDIS_URL, maxRetriesPerRequest: null };
    this.queue = new Queue(QUEUES.maintenance, { connection });
    await this.queue.upsertJobScheduler(
      'heartbeat-every-5m',
      { every: 5 * 60_000 },
      { name: MAINTENANCE_JOBS.heartbeat, opts: { removeOnComplete: 10, removeOnFail: 50 } },
    );

    this.worker = new Worker(QUEUES.maintenance, (job) => this.process(job), { connection, concurrency: 2 });
    this.worker.on('failed', (job, err) => this.logger.error(`Job ${job?.name ?? '?'} gagal: ${err.message}`));
  }

  private process(job: Job): Promise<unknown> {
    switch (job.name) {
      case MAINTENANCE_JOBS.heartbeat:
        return Promise.resolve({ at: new Date().toISOString() });
      default:
        return Promise.reject(new Error(`Job tidak dikenal: ${job.name}`));
    }
  }

  async onApplicationShutdown() {
    await this.worker?.close();
    await this.queue?.close();
  }
}
