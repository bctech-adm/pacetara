import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { audit } from '../admin/admin-auth.service.js';
import { ApiError } from '../common/http.js';
import { ENV, type Env } from '../config/env.js';
import { PG_POOL, REDIS } from '../core.module.js';
import { MAINTENANCE_JOBS, QUEUES } from '../worker/queues.js';
import { EventScraper } from './event-scraper.js';

/** Jeda minimum antar putaran manual: situs sumber tidak boleh dibebani (sopan, sesuai robots/ketentuan). */
export const MANUAL_SCRAPE_COOLDOWN_S = 15 * 60;
const COOLDOWN_KEY = 'event-scrape:manual';

/**
 * Tombol "Jalankan sekarang" di panel: menaruh satu putaran scraping di antrean maintenance (diproses worker,
 * sama dengan jadwal berkala). Dibatasi sekali per 15 menit untuk seluruh panel dan tercatat di admin_audit_log.
 */
@Injectable()
export class ScrapeTrigger implements OnModuleDestroy {
  private queue?: Queue;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly scraper: EventScraper,
  ) {}

  async run(adminId: string): Promise<{ queued: true; nextAllowedInS: number }> {
    if (!this.scraper.enabled) throw new ApiError(503, 'not_configured', 'Belum ada sumber scraping (EVENT_SCRAPE_SOURCES kosong)');
    const ok = await this.redis.set(COOLDOWN_KEY, adminId, 'EX', MANUAL_SCRAPE_COOLDOWN_S, 'NX');
    if (!ok) {
      const ttl = await this.redis.ttl(COOLDOWN_KEY);
      throw new ApiError(429, 'scrape_cooldown', `Putaran manual baru saja dijalankan. Coba lagi dalam ${Math.ceil(Math.max(ttl, 1) / 60)} menit`, {
        retryAfterS: Math.max(ttl, 1),
      });
    }
    try {
      await this.enqueue();
    } catch (err) {
      await this.redis.del(COOLDOWN_KEY);
      throw err;
    }
    await audit(this.pool, adminId, 'event_scrape.run', undefined, { sources: this.scraper.sources.map((s) => s.id) });
    return { queued: true, nextAllowedInS: MANUAL_SCRAPE_COOLDOWN_S };
  }

  /** Dipisah agar tes bisa menggantinya tanpa Redis antrean. */
  async enqueue(): Promise<void> {
    this.queue ??= new Queue(QUEUES.maintenance, { connection: { url: this.env.REDIS_URL, maxRetriesPerRequest: null } });
    // jobId tetap: klik ganda saat job masih menunggu tidak membuat putaran kedua.
    await this.queue.add(MAINTENANCE_JOBS.eventScrape, {}, { jobId: 'event-scrape-manual', attempts: 1, removeOnComplete: true, removeOnFail: 20 });
  }

  async onModuleDestroy() {
    await this.queue?.close();
  }
}
