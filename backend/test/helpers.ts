import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import pg from 'pg';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { type GoogleIdentity, GoogleVerifier, Mailer, WhatsAppOtp } from '../src/auth/channels.js';
import { ApiError } from '../src/common/http.js';
import { ENV, type Env, loadEnv } from '../src/config/env.js';
import { configureApp } from '../src/http/configure-app.js';
import { StorageService } from '../src/storage/storage.service.js';
import { type PushJob, PushQueue } from '../src/notifications/push.js';

/**
 * Tes integrasi butuh Postgres+PostGIS dan Redis sungguhan:
 *   TEST_DATABASE_URL=postgres://...  TEST_REDIS_URL=redis://...
 * Tanpa keduanya, suite e2e dilewati (tes unit tetap berjalan).
 */
export const hasTestInfra = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL);

export class FakeMailer {
  enabled = true;
  sent: { to: string; kind: string; code: string }[] = [];
  async sendCode(to: string, kind: string, code: string) {
    this.sent.push({ to, kind, code });
  }
  lastCode(to: string, kind?: string): string {
    const m = [...this.sent].reverse().find((s) => s.to === to && (!kind || s.kind === kind));
    if (!m) throw new Error(`Tidak ada email untuk ${to}`);
    return m.code;
  }
}

export class FakeWhatsApp {
  up = true;
  sent: { phone: string; code: string }[] = [];
  async send(phone: string, code: string) {
    if (!this.up) return false;
    this.sent.push({ phone, code });
    return true;
  }
}

export class FakeGoogle {
  enabled = true;
  identities = new Map<string, GoogleIdentity>();
  async verify(token: string) {
    const id = this.identities.get(token);
    if (!id) throw new ApiError(401, 'invalid_google_token', 'Login Google gagal, coba lagi');
    return id;
  }
}

export class MemoryStorage {
  objects = new Map<string, { body: Buffer; contentType: string }>();
  async put(key: string, body: Buffer, contentType: string) {
    this.objects.set(key, { body, contentType });
  }
  async get(key: string) {
    const o = this.objects.get(key);
    return o ? { stream: Readable.from(o.body), contentType: o.contentType, length: o.body.length } : undefined;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

/** Antrean push palsu: mencatat job, tidak ada Redis/FCM. */
export class FakePushQueue {
  jobs: PushJob[] = [];
  async enqueue(job: PushJob) {
    if (job.userIds.length) this.jobs.push(job);
  }
  /** Job untuk satu pengguna (urut kirim). */
  to(userId: string) {
    return this.jobs.filter((j) => j.userIds.includes(userId));
  }
}

export interface TestApp {
  app: NestExpressApplication;
  http: ReturnType<NestExpressApplication['getHttpServer']>;
  env: Env;
  pool: pg.Pool;
  redis: Redis;
  mailer: FakeMailer;
  whatsapp: FakeWhatsApp;
  google: FakeGoogle;
  storage: MemoryStorage;
  push: FakePushQueue;
  close(): Promise<void>;
}

export async function createTestApp(): Promise<TestApp> {
  const key = () => randomBytes(32).toString('base64');
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    REDIS_URL: process.env.TEST_REDIS_URL,
    DATA_ENCRYPTION_KEY: key(),
    BLIND_INDEX_KEY: key(),
    JWT_SECRET: key(),
    WA_OTP_URL: 'http://wa-otp.invalid',
    WA_OTP_SHARED_SECRET: 'x'.repeat(32),
    S3_ENDPOINT: 'http://s3.invalid',
    S3_ACCESS_KEY: 'test',
    S3_SECRET_KEY: 'testtest',
    S3_BUCKET: 'test',
  } as NodeJS.ProcessEnv);

  const mailer = new FakeMailer();
  const whatsapp = new FakeWhatsApp();
  const google = new FakeGoogle();
  const storage = new MemoryStorage();
  const push = new FakePushQueue();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(Mailer)
    .useValue(mailer)
    .overrideProvider(WhatsAppOtp)
    .useValue(whatsapp)
    .overrideProvider(GoogleVerifier)
    .useValue(google)
    .overrideProvider(StorageService)
    .useValue(storage)
    .overrideProvider(PushQueue)
    .useValue(push)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app, env);
  await app.init();

  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const redis = new Redis(env.REDIS_URL);
  return {
    app,
    http: app.getHttpServer(),
    env,
    pool,
    redis,
    mailer,
    whatsapp,
    google,
    storage,
    push,
    async close() {
      await app.close();
      await pool.end();
      redis.disconnect();
    },
  };
}

/** Kosongkan data antar tes (skema tetap). */
export async function resetData(t: TestApp) {
  await t.pool.query('TRUNCATE users, refresh_tokens, verification_codes CASCADE');
  await t.redis.flushdb();
}

export const silence = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

let ipCounter = 1;
/** IP sumber unik per permintaan agar batas laju per-IP tidak mengganggu tes lain. */
export const freshIp = () => {
  const n = ipCounter++;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
};
