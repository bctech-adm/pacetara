import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ENV, type Env } from '../config/env.js';
import { QUEUES, SUBSCRIPTION_JOB } from '../worker/queues.js';

/**
 * Job sinkron satu purchaseToken. Token di antrean Redis dienkripsi FieldCrypto (AAD `play_job`), seperti data
 * push Garmin (#166). [revoke] = refund/pencabutan (voidedPurchaseNotification, SUBSCRIPTION_REVOKED).
 */
export interface SubscriptionJob {
  tokenEnc: string;
  revoke: boolean;
}

@Injectable()
export class SubscriptionQueue implements OnModuleDestroy {
  private queue?: Queue;

  constructor(@Inject(ENV) private readonly env: Env) {}

  async enqueue(job: SubscriptionJob): Promise<void> {
    this.queue ??= new Queue(QUEUES.subscriptions, { connection: { url: this.env.REDIS_URL, maxRetriesPerRequest: null } });
    await this.queue.add(SUBSCRIPTION_JOB, job, { attempts: 6, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: true, removeOnFail: 200 });
  }

  async onModuleDestroy() {
    await this.queue?.close();
  }
}
