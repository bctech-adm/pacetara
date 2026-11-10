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
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // Hanya nama variabel dan pesan; nilai tidak pernah dicetak.
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Konfigurasi environment tidak valid:\n${issues}`);
  }
  if (parsed.data.DATA_ENCRYPTION_KEY === parsed.data.BLIND_INDEX_KEY) {
    throw new Error('DATA_ENCRYPTION_KEY dan BLIND_INDEX_KEY harus berbeda');
  }
  return parsed.data;
}

export const ENV = Symbol('ENV');
