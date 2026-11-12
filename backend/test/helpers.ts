import { createHash, randomBytes } from 'node:crypto';
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
import { ImportQueue } from '../src/imports/import-queue.js';
import { ImportsService } from '../src/imports/imports.service.js';
import { assertAllowedUrl, ProviderHttp, type ProviderRequest } from '../src/imports/provider-http.js';
import type { ImportJob } from '../src/imports/types.js';
import { KycEngine } from '../src/kyc/kyc-engine.js';
import type { KycAnalysis } from '../src/kyc/ktp.js';
import { XenditApi, type XenditAccount, type XenditInvoice } from '../src/market/xendit.js';
import { MidtransApi, midtransSignatureOk, type MidtransStatus } from '../src/payments/midtrans.js';

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
  sos: { phone: string; sos: { name: string; lat: number; lng: number; accuracyM?: number; at: Date } }[] = [];
  async send(phone: string, code: string) {
    if (!this.up) return false;
    this.sent.push({ phone, code });
    return true;
  }
  async sendSos(phone: string, sos: { name: string; lat: number; lng: number; accuracyM?: number; at: Date }) {
    if (!this.up) return false;
    this.sos.push({ phone, sos });
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

/**
 * HTTP penyedia impor palsu (Garmin/Strava). Tetap memakai pemeriksaan allowlist yang sama dengan
 * ProviderHttp asli, lalu menjawab dari [routes] (pola regex atas "METHOD url"). Semua panggilan dicatat.
 */
export class FakeProviderHttp {
  calls: { method: string; url: string; bearer?: string; form?: Record<string, string> }[] = [];
  routes: { pattern: RegExp; handler: (url: URL, req: ProviderRequest) => unknown }[] = [];
  on(pattern: RegExp, handler: (url: URL, req: ProviderRequest) => unknown) {
    this.routes.unshift({ pattern, handler });
  }
  reset() {
    this.calls = [];
    this.routes = [];
  }
  async request<T = unknown>(rawUrl: string, req: ProviderRequest = {}): Promise<T> {
    const url = assertAllowedUrl(rawUrl);
    const method = req.method ?? (req.form ? 'POST' : 'GET');
    this.calls.push({ method, url: url.toString(), bearer: req.bearer, form: req.form });
    const key = `${method} ${url.toString()}`;
    const route = this.routes.find((r) => r.pattern.test(key));
    if (!route) throw new Error(`FakeProviderHttp: tidak ada rute untuk ${key}`);
    return (await route.handler(url, req)) as T;
  }
}

/** Antrean impor palsu: mencatat job; tes menjalankannya dengan drain(). */
export class FakeImportQueue {
  jobs: ImportJob[] = [];
  service?: ImportsService;
  async enqueue(job: ImportJob) {
    this.jobs.push(job);
  }
  /** Jalankan semua job yang menunggu (seperti worker). */
  async drain() {
    const results: unknown[] = [];
    while (this.jobs.length) results.push(await this.service!.process(this.jobs.shift()!));
    return results;
  }
}

/**
 * Mesin verifikasi KTP palsu (modul 3.1): tes mengatur hasil analisis berikutnya. Mesin asli (worker thread OCR +
 * wajah) tidak pernah dijalankan di tes; diuji lewat scripts/kyc-smoke.
 */
export class FakeKycEngine {
  enabled = true;
  calls = 0;
  /** Ukuran gambar yang diterima, untuk memastikan berkas sampai ke mesin. */
  sizes: number[] = [];
  next: KycAnalysis = FakeKycEngine.good('3174011205900001', 'BUDI SANTOSO');
  static good(nik: string, name: string): KycAnalysis {
    return { ocr: { nik, name, confidence: 85 }, ktpFaces: 1, selfieFaces: 1, faceSimilarity: 0.72, selfieReal: 0.9, selfieLive: 0.95 };
  }
  async analyze(ktp: Buffer, selfie: Buffer): Promise<KycAnalysis> {
    if (!this.enabled) throw new ApiError(503, 'not_configured', 'Verifikasi KTP belum tersedia');
    this.calls++;
    this.sizes.push(ktp.length, selfie.length);
    return structuredClone(this.next);
  }
}

/** Xendit xenPlatform palsu (modul 3.2): akun, split rule, dan invoice di memori. */
export class FakeXendit {
  enabled = true;
  static TOKEN = 'cb-token-uji-1234567890';
  accounts = new Map<string, { email: string; status: string }>();
  invoices = new Map<string, XenditInvoice & { forUserId: string; splitRuleId: string | null }>();
  splitRules: { id: string; percent: number; flat: number; destinationAccountId: string }[] = [];
  private seq = 0;
  async createManagedAccount(email: string): Promise<XenditAccount> {
    const id = `acc_${++this.seq}`;
    this.accounts.set(id, { email, status: 'INVITED' });
    return { id, status: 'INVITED' };
  }
  async getAccount(id: string): Promise<XenditAccount> {
    const a = this.accounts.get(id);
    if (!a) throw new Error('akun tidak ada');
    return { id, status: a.status };
  }
  async createSplitRule(input: { percent: number; flat: number; destinationAccountId: string }) {
    const rule = { id: `splitru_${++this.seq}`, ...input };
    this.splitRules.push(rule);
    return { id: rule.id };
  }
  async createInvoice(forUserId: string, splitRuleId: string | null, body: { externalId: string; amount: number }): Promise<XenditInvoice> {
    const id = `inv_${++this.seq}`;
    const inv = { id, external_id: body.externalId, amount: body.amount, status: 'PENDING', invoice_url: `https://checkout.xendit.co/web/${id}`, forUserId, splitRuleId };
    this.invoices.set(id, inv);
    return inv;
  }
  async getInvoice(forUserId: string, id: string): Promise<XenditInvoice> {
    const inv = this.invoices.get(id);
    if (!inv || inv.forUserId !== forUserId) throw new Error('invoice tidak ada');
    return { ...inv };
  }
  async expireInvoice(forUserId: string, id: string) {
    const inv = this.invoices.get(id);
    if (inv && inv.forUserId === forUserId) inv.status = 'EXPIRED';
  }
  verifyCallbackToken(t: unknown) {
    return t === FakeXendit.TOKEN;
  }
}

/** Midtrans palsu (modul 3.2/3.3): Snap dan status transaksi di memori; signature memakai fungsi asli. */
export class FakeMidtrans {
  enabled = true;
  static KEY = 'SB-Mid-server-uji';
  snaps: { orderId: string; amount: number; itemName: string; finishUrl: string }[] = [];
  statuses = new Map<string, MidtransStatus>();
  async createSnap(input: { orderId: string; amount: number; itemName: string; finishUrl: string }) {
    this.snaps.push(input);
    this.statuses.set(input.orderId, { order_id: input.orderId, transaction_status: 'pending', status_code: '201', gross_amount: `${input.amount}.00` });
    return { token: `tok-${input.orderId}`, redirectUrl: `https://app.sandbox.midtrans.com/snap/v4/redirection/tok-${input.orderId}` };
  }
  async status(orderId: string): Promise<MidtransStatus> {
    return this.statuses.get(orderId) ?? { status_code: '404' };
  }
  verifyNotification(body: Record<string, unknown>) {
    return midtransSignatureOk(FakeMidtrans.KEY, body);
  }
  /** Set status lalu kembalikan body notifikasi bertanda tangan sah. */
  settle(orderId: string, transaction_status = 'settlement', gross?: string) {
    const st = this.statuses.get(orderId)!;
    const gross_amount = gross ?? st.gross_amount!;
    const status_code = transaction_status === 'settlement' ? '200' : '201';
    this.statuses.set(orderId, { ...st, transaction_status, status_code, gross_amount, payment_type: 'qris' });
    return { order_id: orderId, status_code, gross_amount, transaction_status, signature_key: createHash('sha512').update(`${orderId}${status_code}${gross_amount}${FakeMidtrans.KEY}`).digest('hex') };
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
  providerHttp: FakeProviderHttp;
  imports: FakeImportQueue;
  kyc: FakeKycEngine;
  xendit: FakeXendit;
  midtrans: FakeMidtrans;
  close(): Promise<void>;
}

/**
 * [envOverrides] untuk mengaktifkan fitur opsional (mis. GARMIN_*, STRAVA_*). [providers] mengganti provider lain
 * (mis. klien Google Play dan verifier OIDC palsu di tes langganan).
 */
export async function createTestApp(envOverrides: Record<string, string> = {}, providers: { token: unknown; value: unknown }[] = []): Promise<TestApp> {
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
    // Tes modul lain membuat komunitas dengan pengguna Level 1; syarat Level 2 (3.1) diuji di kyc.e2e.spec.ts.
    COMMUNITY_OWNER_MIN_LEVEL: '1',
    ...envOverrides,
  } as NodeJS.ProcessEnv);

  const mailer = new FakeMailer();
  const whatsapp = new FakeWhatsApp();
  const google = new FakeGoogle();
  const storage = new MemoryStorage();
  const push = new FakePushQueue();
  const providerHttp = new FakeProviderHttp();
  const imports = new FakeImportQueue();
  const kyc = new FakeKycEngine();
  const xendit = new FakeXendit();
  const midtrans = new FakeMidtrans();

  let builder = Test.createTestingModule({ imports: [AppModule] })
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
    .overrideProvider(ProviderHttp)
    .useValue(providerHttp)
    .overrideProvider(ImportQueue)
    .useValue(imports)
    .overrideProvider(KycEngine)
    .useValue(kyc)
    .overrideProvider(XenditApi)
    .useValue(xendit)
    .overrideProvider(MidtransApi)
    .useValue(midtrans);
  for (const p of providers) builder = builder.overrideProvider(p.token).useValue(p.value);
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app, env);
  await app.init();
  imports.service = app.get(ImportsService);

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
    providerHttp,
    imports,
    kyc,
    xendit,
    midtrans,
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
