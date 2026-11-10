import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { Public } from '../common/http.js';
import { PG_POOL, REDIS } from '../core.module.js';

type Check = 'ok' | 'down';

@Controller('health')
@Public()
@SkipThrottle()
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Liveness: proses hidup. Dipakai healthcheck container. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: dependensi utama bisa dijangkau. Tidak membocorkan detail galat. */
  @Get()
  async ready() {
    const [database, redis] = await Promise.all([
      this.check(() => this.pool.query('SELECT 1')),
      this.check(() => this.redis.ping()),
    ]);
    const body = { status: database === 'ok' && redis === 'ok' ? 'ok' : 'degraded', database, redis };
    if (body.status !== 'ok') throw new ServiceUnavailableException(body);
    return body;
  }

  private async check(fn: () => Promise<unknown>): Promise<Check> {
    try {
      await withTimeout(fn(), 2000);
      return 'ok';
    } catch {
      return 'down';
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
