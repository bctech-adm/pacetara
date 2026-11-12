import { z } from 'zod';

const base64Key = (name: string) =>
  z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, {
      message: `${name} harus 32 byte dalam base64 (openssl rand -base64 32)`,
    });

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /** Origin yang boleh memanggil API dari browser (panel admin). Dipisah koma. */
  CORS_ORIGINS: z.string().default(''),
  /** Jumlah proxy di depan API (Caddy = 1) agar IP klien untuk rate limit benar. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  DATA_ENCRYPTION_KEY: base64Key('DATA_ENCRYPTION_KEY'),
  BLIND_INDEX_KEY: base64Key('BLIND_INDEX_KEY'),

  WA_OTP_URL: z.string().url(),
  WA_OTP_SHARED_SECRET: z.string().min(32),

  S3_ENDPOINT: z.string().url(),
  S3_ACCESS_KEY: z.string().min(3),
  S3_SECRET_KEY: z.string().min(8),
  S3_BUCKET: z.string().min(3),

  /** Kunci HMAC token akses (openssl rand -base64 32). */
  JWT_SECRET: base64Key('JWT_SECRET'),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),

  /** Client ID OAuth Google (Android + Web) yang boleh menjadi `aud` ID token. Kosong = login Google mati. */
  GOOGLE_CLIENT_IDS: z.string().default(''),

  /** SMTP untuk OTP email. SMTP_HOST kosong = email tidak bisa dikirim (endpoint menjawab 503). */
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  MAIL_FROM: z.string().default('PaceTara <noreply@bimacreative.tech>'),

  /** Akun layanan Firebase (JSON di-base64) untuk push FCM. Kosong = push mati, notifikasi di aplikasi tetap jalan. */
  FCM_SERVICE_ACCOUNT_B64: z.string().default(''),

  PRIVACY_POLICY_VERSION: z.string().min(1).default('2026-11-10'),
  PRIVACY_POLICY_URL: z.string().url().default('https://pace.bimacreative.tech/privasi'),
  /** Situs publik; dipakai untuk tautan undangan komunitas (`/j/<kode>`). */
  PUBLIC_WEB_URL: z.string().url().default('https://pace.bimacreative.tech'),

  /**
   * URL publik API (https://domain[:port]) untuk alamat callback OAuth impor (modul 2.3). Kosong = dibentuk
   * dari API_DOMAIN. Keduanya kosong = OAuth Garmin/Strava mati.
   */
  API_PUBLIC_URL: z.union([z.literal(''), z.string().url()]).default(''),
  API_DOMAIN: z.string().default(''),

  /** Garmin Connect Developer Program (modul 2.3). Aktif hanya jika ketiganya diisi. */
  GARMIN_CLIENT_ID: z.string().default(''),
  GARMIN_CLIENT_SECRET: z.string().default(''),
  /** Kunci acak di alamat endpoint push Garmin (/v1/imports/garmin/push/<kunci>), min. 32 karakter. */
  GARMIN_PUSH_KEY: z.union([z.literal(''), z.string().min(32, 'GARMIN_PUSH_KEY minimal 32 karakter')]).default(''),
  /** Akses Starter Garmin: maks. 1.000 pengguna terhubung. */
  GARMIN_MAX_USERS: z.coerce.number().int().min(1).default(1000),

  /** Strava API (modul 2.3). Aktif hanya jika client id dan secret diisi. */
  STRAVA_CLIENT_ID: z.string().default(''),
  STRAVA_CLIENT_SECRET: z.string().default(''),
  /** Token verifikasi langganan webhook Strava. Kosong = webhook mati (sinkron manual tetap jalan). */
  STRAVA_WEBHOOK_VERIFY_TOKEN: z.string().default(''),
  /** Id langganan webhook Strava; jika diisi, event dengan id lain ditolak. */
  STRAVA_WEBHOOK_SUBSCRIPTION_ID: z.string().default(''),

  /**
   * Sumber scraping event (modul 2.4), JSON array `[{"id","name","urls":[...],"parser"?}]`. Kosong (bawaan) =
   * scraping mati. Isi hanya setelah ketentuan layanan + robots.txt situs diperiksa (lihat README).
   */
  EVENT_SCRAPE_SOURCES: z.string().default(''),
  /** Jarak antar putaran scraping (jam). */
  EVENT_SCRAPE_INTERVAL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  /** Jeda minimal antar permintaan ke host yang sama (ms); Crawl-delay robots.txt yang lebih besar menang. */
  EVENT_SCRAPE_DELAY_MS: z.coerce.number().int().min(1000).max(60_000).default(5000),

  /**
   * Langganan Google Play (modul 2.5). Aktif hanya jika nama paket + akun layanan diisi (pola #117); tanpa itu
   * endpoint langganan menjawab 503 not_configured dan aplikasi menampilkan "Langganan belum tersedia".
   */
  GOOGLE_PLAY_PACKAGE_NAME: z.union([z.literal(''), z.string().regex(/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/, 'Nama paket Android tidak valid')]).default(''),
  /** Akun layanan Google Cloud (JSON di-base64) yang diberi izin di Play Console (lihat README). */
  PLAY_SERVICE_ACCOUNT_B64: z.string().default(''),
  /** Product ID langganan di Play Console. Harga diatur di Play Console, tidak di kode. */
  PLAY_PRODUCT_PREMIUM: z.string().regex(/^[a-z0-9][a-z0-9._]{0,98}$/).default('pacetara_premium'),
  PLAY_PRODUCT_PRO: z.string().regex(/^[a-z0-9][a-z0-9._]{0,98}$/).default('pacetara_community_pro'),
  PLAY_PRODUCT_PRO_UNLIMITED: z.string().regex(/^[a-z0-9][a-z0-9._]{0,98}$/).default('pacetara_community_pro_unlimited'),
  /**
   * Real-time Developer Notifications lewat Pub/Sub push. Token OIDC dari Pub/Sub wajib ber-`aud` ini dan
   * ber-`email` akun layanan push ini. Keduanya kosong = endpoint RTDN menjawab 503 (rekonsiliasi berkala tetap jalan).
   */
  PLAY_RTDN_AUDIENCE: z.string().max(500).default(''),
  PLAY_RTDN_SERVICE_ACCOUNT_EMAIL: z.union([z.literal(''), z.string().email()]).default(''),

  /** Manifest APK terbaru (dibuat CI di GitHub Releases) dan awalan URL APK yang diizinkan. */
  APP_UPDATE_MANIFEST_URL: z
    .string()
    .url()
    .default('https://github.com/bctech-adm/pacetara/releases/latest/download/latest.json'),
  APP_UPDATE_APK_URL_PREFIX: z.string().url().default('https://github.com/bctech-adm/pacetara/releases/download/'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // Hanya nama variabel dan pesan; nilai tidak pernah dicetak.
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Konfigurasi environment tidak valid:\n${issues}`);
  }
  const keys = [parsed.data.DATA_ENCRYPTION_KEY, parsed.data.BLIND_INDEX_KEY, parsed.data.JWT_SECRET];
  if (new Set(keys).size !== keys.length) {
    throw new Error('DATA_ENCRYPTION_KEY, BLIND_INDEX_KEY, dan JWT_SECRET harus berbeda satu sama lain');
  }
  const products = [parsed.data.PLAY_PRODUCT_PREMIUM, parsed.data.PLAY_PRODUCT_PRO, parsed.data.PLAY_PRODUCT_PRO_UNLIMITED];
  if (new Set(products).size !== products.length) {
    throw new Error('PLAY_PRODUCT_PREMIUM, PLAY_PRODUCT_PRO, dan PLAY_PRODUCT_PRO_UNLIMITED harus berbeda');
  }
  return parsed.data;
}

export const ENV = Symbol('ENV');
