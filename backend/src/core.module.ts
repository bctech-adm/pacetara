import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import pg from 'pg';
import { ENV, type Env, loadEnv } from './config/env.js';
import { FieldCrypto } from './crypto/field-crypto.js';

export const PG_POOL = Symbol('PG_POOL');
export const REDIS = Symbol('REDIS');

/** Penyedia bersama untuk API dan worker: konfigurasi, Postgres, Redis, enkripsi kolom. */
@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    {
      provide: PG_POOL,
      inject: [ENV],
      useFactory: (env: Env) =>
        new pg.Pool({ connectionString: env.DATABASE_URL, max: 10, idleTimeoutMillis: 30_000 }),
    },
    {
      provide: REDIS,
      inject: [ENV],
      useFactory: (env: Env) => new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }),
    },
    {
      provide: FieldCrypto,
      inject: [ENV],
      useFactory: (env: Env) => new FieldCrypto(env.DATA_ENCRYPTION_KEY, env.BLIND_INDEX_KEY),
    },
  ],
  exports: [ENV, PG_POOL, REDIS, FieldCrypto],
})
export class CoreModule implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.pool.end(), this.redis.quit()]);
  }
}
