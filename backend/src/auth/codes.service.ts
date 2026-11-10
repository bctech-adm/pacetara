import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { withTx } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { ENV, type Env } from '../config/env.js';
import { PG_POOL, REDIS } from '../core.module.js';
import { type BlindIndexContext, FieldCrypto } from '../crypto/field-crypto.js';

export type CodePurpose = 'email_verify' | 'phone_verify' | 'password_reset';
export type CodeChannel = 'email' | 'whatsapp';

export const CODE_LENGTH = 6;
const TTL_MIN: Record<CodeChannel, number> = { email: 10, whatsapp: 5 };
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SEC = 60;
const MAX_PER_HOUR = 5;

/**
 * Kode verifikasi 6 digit. Disimpan sebagai HMAC berkunci (bukan kode mentah), sekali pakai,
 * maksimal 5 kali salah, jeda kirim ulang 60 detik, dan maksimal 5 kode per jam per tujuan.
 */
@Injectable()
export class CodesService {
  private readonly hmacKey: Buffer;

  constructor(
    @Inject(ENV) env: Env,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly crypto: FieldCrypto,
  ) {
    // Turunkan kunci khusus agar tidak memakai kunci blind index secara langsung.
    this.hmacKey = createHmac('sha256', Buffer.from(env.BLIND_INDEX_KEY, 'base64')).update('otp-codes').digest();
  }

  /** Memeriksa batas kirim. Dipanggil sebelum membuat kode agar gagal cepat. */
  async assertCanSend(userId: string, purpose: CodePurpose): Promise<void> {
    const cooldown = `otp:cooldown:${purpose}:${userId}`;
    const ttl = await this.redis.ttl(cooldown);
    if (ttl > 0) {
      throw new ApiError(429, 'code_cooldown', `Tunggu ${ttl} detik sebelum meminta kode baru`, { retryAfter: ttl });
    }
    const hourly = `otp:hourly:${purpose}:${userId}`;
    const count = Number((await this.redis.get(hourly)) ?? 0);
    if (count >= MAX_PER_HOUR) {
      throw new ApiError(429, 'code_limit', 'Terlalu banyak permintaan kode. Coba lagi dalam 1 jam');
    }
  }

  /** Membuat kode baru (kode lama untuk tujuan yang sama dibatalkan) dan mengembalikan kode mentah untuk dikirim. */
  async create(
    userId: string,
    purpose: CodePurpose,
    channel: CodeChannel,
    target: { context: BlindIndexContext; value: string },
  ): Promise<string> {
    const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
    const id = randomUUID();
    await withTx(this.pool, async (db) => {
      await db.query(
        'UPDATE verification_codes SET consumed_at = now() WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL',
        [userId, purpose],
      );
      await db.query(
        `INSERT INTO verification_codes (id, user_id, purpose, channel, target_enc, target_bidx, code_hmac, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(mins => $8))`,
        [
          id,
          userId,
          purpose,
          channel,
          this.crypto.encrypt(target.value, `verification_codes.target:${id}`),
          this.crypto.blindIndex(target.context, target.value),
          this.hmac(id, code),
          TTL_MIN[channel],
        ],
      );
    });

    const hourly = `otp:hourly:${purpose}:${userId}`;
    await this.redis
      .multi()
      .set(`otp:cooldown:${purpose}:${userId}`, '1', 'EX', RESEND_COOLDOWN_SEC)
      .incr(hourly)
      .expire(hourly, 3600, 'NX')
      .exec();
    return code;
  }

  /**
   * Memverifikasi dan menghabiskan kode dalam transaksinya sendiri (hitungan percobaan salah
   * selalu tersimpan). Mengembalikan target (email/HP) yang diverifikasi.
   */
  async consume(userId: string, purpose: CodePurpose, code: string): Promise<string> {
    const result = await withTx(this.pool, async (db) => {
      const { rows } = await db.query<{ id: string; target_enc: Buffer; code_hmac: Buffer; attempts: number; expired: boolean }>(
        `SELECT id, target_enc, code_hmac, attempts, expires_at < now() AS expired
           FROM verification_codes
          WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL
          ORDER BY created_at DESC LIMIT 1
          FOR UPDATE`,
        [userId, purpose],
      );
      const row = rows[0];
      if (!row || row.expired || row.attempts >= MAX_ATTEMPTS) return { ok: false as const, left: -1 };
      const match = /^\d+$/.test(code) && timingSafeEqual(row.code_hmac, this.hmac(row.id, code));
      if (!match) {
        await db.query('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
        return { ok: false as const, left: MAX_ATTEMPTS - row.attempts - 1 };
      }
      await db.query('UPDATE verification_codes SET consumed_at = now() WHERE id = $1', [row.id]);
      return { ok: true as const, target: this.crypto.decryptString(row.target_enc, `verification_codes.target:${row.id}`) };
    });

    if (result.ok) return result.target;
    if (result.left < 0) throw new ApiError(400, 'code_expired', 'Kode sudah tidak berlaku. Minta kode baru');
    throw new ApiError(400, 'code_invalid', result.left > 0 ? `Kode salah. Sisa ${result.left} percobaan` : 'Kode salah. Minta kode baru', {
      attemptsLeft: Math.max(0, result.left),
    });
  }

  private hmac(id: string, code: string): Buffer {
    return createHmac('sha256', this.hmacKey).update(`${id}:${code}`).digest();
  }
}
