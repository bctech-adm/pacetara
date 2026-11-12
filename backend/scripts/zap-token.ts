/**
 * Khusus pemindaian ZAP di CI (database sekali pakai): buat pengguna uji Level 1 lalu cetak token aksesnya ke stdout.
 * Menolak berjalan tanpa ZAP_SCAN=1, agar tidak dipakai di server sungguhan secara tidak sengaja.
 *
 *   ZAP_SCAN=1 node dist/scripts/zap-token.js
 */
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Redis } from 'ioredis';
import { hashPassword } from '../src/auth/password.js';
import { TokenService } from '../src/auth/token.service.js';
import { loadEnv } from '../src/config/env.js';
import { FieldCrypto } from '../src/crypto/field-crypto.js';

if (process.env.ZAP_SCAN !== '1') {
  console.error('Skrip ini hanya untuk pemindaian ZAP di CI (setel ZAP_SCAN=1).');
  process.exit(2);
}
const env = loadEnv();
const crypto = new FieldCrypto(env.DATA_ENCRYPTION_KEY, env.BLIND_INDEX_KEY);
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
try {
  const id = randomUUID();
  const email = `zap-${id}@example.invalid`;
  const phone = `+62819${String(Date.now()).slice(-8)}`;
  await pool.query(
    `INSERT INTO users (id, email_enc, email_bidx, email_verified_at, phone_enc, phone_bidx, phone_verified_at, password_hash, display_name, privacy_accepted_at, privacy_version)
     VALUES ($1, $2, $3, now(), $4, $5, now(), $6, 'Pemindai ZAP', now(), 'zap')`,
    [
      id,
      crypto.encrypt(email, `users.email:${id}`),
      crypto.blindIndex('email', email),
      crypto.encrypt(phone, `users.phone:${id}`),
      crypto.blindIndex('phone', phone),
      // Kata sandi acak yang tidak disimpan di mana pun (kolom wajib: users_login_method).
      await hashPassword(randomBytes(24).toString('base64url')),
    ],
  );
  // Redis tidak dipakai saat menerbitkan token (hanya saat pencabutan).
  const tokens = await new TokenService(env, pool as unknown as pg.Pool, null as unknown as Redis).issue(id, 'user', 'zap');
  process.stdout.write(tokens.accessToken);
} finally {
  await pool.end();
}
