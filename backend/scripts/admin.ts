/**
 * CLI super admin (dijalankan operator di server, bukan lewat web):
 *   docker compose exec api node dist/scripts/admin.js promote <email>     → jadikan super admin + rahasia TOTP baru
 *   docker compose exec api node dist/scripts/admin.js reset-totp <email>  → ganti rahasia TOTP (HP hilang)
 *   docker compose exec api node dist/scripts/admin.js demote <email>      → cabut peran super admin
 *
 * Akun harus sudah terdaftar di aplikasi dengan kata sandi (login Google saja tidak cukup untuk panel).
 * URI otpauth dicetak SEKALI ke terminal; pindai dengan aplikasi authenticator lalu bersihkan layar.
 * Setiap perintah tercatat di admin_audit_log (pelaku: CLI).
 */
import pg from 'pg';
import { audit, totpAad } from '../src/admin/admin-auth.service.js';
import { generateTotpSecret, totpUri } from '../src/admin/totp.js';
import { FieldCrypto } from '../src/crypto/field-crypto.js';

const [command, email] = process.argv.slice(2);
const { DATABASE_URL, DATA_ENCRYPTION_KEY, BLIND_INDEX_KEY } = process.env;
if (!command || !email || !['promote', 'reset-totp', 'demote'].includes(command)) {
  console.error('Pakai: admin.js <promote|reset-totp|demote> <email>');
  process.exit(2);
}
if (!DATABASE_URL || !DATA_ENCRYPTION_KEY || !BLIND_INDEX_KEY) {
  console.error('DATABASE_URL, DATA_ENCRYPTION_KEY, dan BLIND_INDEX_KEY wajib diatur');
  process.exit(2);
}

const crypto = new FieldCrypto(DATA_ENCRYPTION_KEY, BLIND_INDEX_KEY);
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });

try {
  const { rows } = await pool.query<{ id: string; status: string; password_hash: string | null; display_name: string }>(
    'SELECT id, status, password_hash, display_name FROM users WHERE email_bidx = $1',
    [crypto.blindIndex('email', email)],
  );
  const user = rows[0];
  if (!user || user.status !== 'active') throw new Error('Akun aktif dengan email itu tidak ditemukan');

  if (command === 'demote') {
    await pool.query(`UPDATE users SET role = 'user', totp_secret_enc = NULL WHERE id = $1`, [user.id]);
    await pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND admin_session AND revoked_at IS NULL', [user.id]);
    await audit(pool, null, 'cli.demote', { type: 'user', id: user.id });
    console.log(`Peran super admin dicabut dari ${user.display_name}. Sesi panelnya dicabut (token akses lama berlaku maks. 15 menit).`);
  } else {
    if (!user.password_hash) throw new Error('Akun ini belum punya kata sandi. Atur kata sandi di aplikasi dulu (Lupa kata sandi)');
    const secret = generateTotpSecret();
    await pool.query(`UPDATE users SET role = 'super_admin', totp_secret_enc = $2 WHERE id = $1`, [user.id, crypto.encrypt(secret, totpAad(user.id))]);
    await pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND admin_session AND revoked_at IS NULL', [user.id]);
    await audit(pool, null, command === 'promote' ? 'cli.promote' : 'cli.reset_totp', { type: 'user', id: user.id });
    console.log(`${user.display_name} sekarang super admin. Daftarkan ke aplikasi authenticator:`);
    console.log(totpUri(secret, user.display_name));
    console.log(`Atau masukkan kunci manual: ${secret}`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
