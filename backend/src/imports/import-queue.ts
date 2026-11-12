import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ENV, type Env } from '../config/env.js';
import { IMPORT_JOB, QUEUES } from '../worker/queues.js';
import type { ImportJob } from './types.js';

/** Antrean impor di sisi API. Pengolahan (tarik data penyedia, simpan lari) dilakukan worker. */
@Injectable()
export class ImportQueue implements OnModuleDestroy {
  private queue?: Queue;

  constructor(@Inject(ENV) private readonly env: Env) {}

  /** [jobId] membuat job idempoten (notifikasi ganda dari penyedia hanya diproses sekali selama job masih ada). */
  async enqueue(job: ImportJob, jobId?: string): Promise<void> {
    this.queue ??= new Queue(QUEUES.imports, { connection: { url: this.env.REDIS_URL, maxRetriesPerRequest: null } });
    await this.queue.add(IMPORT_JOB, job, {
      jobId,
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: 100,
    });
  }

  async onModuleDestroy() {
    await this.queue?.close();
  }
}
