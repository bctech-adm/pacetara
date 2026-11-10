import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const valid = () => ({
  DATABASE_URL: 'postgres://u:p@postgres:5432/pacetara',
  REDIS_URL: 'redis://:pw@redis:6379',
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  BLIND_INDEX_KEY: randomBytes(32).toString('base64'),
  WA_OTP_URL: 'http://wa-otp:4000',
  WA_OTP_SHARED_SECRET: 'x'.repeat(32),
  S3_ENDPOINT: 'http://minio:9000',
  S3_ACCESS_KEY: 'pacetara',
  S3_SECRET_KEY: 'supersecret',
  S3_BUCKET: 'pacetara',
  JWT_SECRET: randomBytes(32).toString('base64'),
});

describe('loadEnv', () => {
  it('menerima konfigurasi lengkap dan mengisi bawaan', () => {
    const env = loadEnv(valid());
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
  });

  it('menolak kunci enkripsi yang bukan 32 byte tanpa membocorkan nilainya', () => {
    const bad = { ...valid(), DATA_ENCRYPTION_KEY: 'rahasia-pendek' };
    expect(() => loadEnv(bad)).toThrow(/DATA_ENCRYPTION_KEY/);
    expect(() => loadEnv(bad)).not.toThrow(/rahasia-pendek/);
  });

  it('menolak kunci enkripsi dan blind index yang sama', () => {
    const v = valid();
    expect(() => loadEnv({ ...v, BLIND_INDEX_KEY: v.DATA_ENCRYPTION_KEY })).toThrow(/harus berbeda/);
  });

  it('menolak variabel wajib yang hilang', () => {
    const { DATABASE_URL: _omit, ...rest } = valid();
    expect(() => loadEnv(rest)).toThrow(/DATABASE_URL/);
  });
});
