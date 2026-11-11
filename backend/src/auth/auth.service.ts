import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { withTx } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { ENV, type Env } from '../config/env.js';
import { PG_POOL, REDIS } from '../core.module.js';
import { FieldCrypto, normalizeEmail } from '../crypto/field-crypto.js';
import { phoneAad, type UserRow, UsersRepository } from '../users/users.repository.js';
import { GoogleVerifier, Mailer, WhatsAppOtp } from './channels.js';
import { CodesService } from './codes.service.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from './password.js';
import { type TokenPair, TokenService } from './token.service.js';

export interface AuthResult extends TokenPair {
  user: ReturnType<UsersRepository['toMyProfile']>;
}

/** Login aplikasi: maks. gagal per email dalam jendela kunci (selain batas per IP). */
const LOGIN_MAX_FAILURES = 10;
const LOGIN_LOCK_S = 15 * 60;

@Injectable()
export class AuthService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly users: UsersRepository,
    private readonly tokens: TokenService,
    private readonly codes: CodesService,
    private readonly mailer: Mailer,
    private readonly whatsapp: WhatsAppOtp,
    private readonly google: GoogleVerifier,
    private readonly crypto: FieldCrypto,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // ---------- Daftar & masuk ----------

  async register(input: {
    email: string;
    password: string;
    displayName: string;
    privacyVersion: string;
    device?: string;
  }): Promise<AuthResult> {
    this.assertPrivacyVersion(input.privacyVersion);
    if (await this.users.findByEmail(input.email)) {
      throw new ApiError(409, 'email_taken', 'Email sudah terdaftar. Silakan masuk');
    }
    const passwordHash = await hashPassword(input.password);
    let user: UserRow;
    try {
      user = await this.users.create(this.pool, {
        id: randomUUID(),
        email: input.email,
        emailVerified: false,
        passwordHash,
        displayName: input.displayName,
        privacyVersion: input.privacyVersion,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ApiError(409, 'email_taken', 'Email sudah terdaftar. Silakan masuk');
      throw err;
    }
    // Kirim kode verifikasi email langsung; kegagalan kirim tidak membatalkan pendaftaran.
    await this.sendEmailCode(user.id).catch(() => undefined);
    return this.session(user, input.device);
  }

  async login(input: { email: string; password: string; device?: string }): Promise<AuthResult> {
    // Batas per akun (selain per IP): menahan tebak kata sandi dari banyak IP. Kunci = blind index email,
    // dihitung juga untuk email tidak terdaftar sehingga tidak membocorkan keberadaan akun.
    const failKey = `login:fail:${this.crypto.blindIndex('email', input.email).toString('hex')}`;
    if (Number((await this.redis.get(failKey)) ?? 0) >= LOGIN_MAX_FAILURES) {
      throw new ApiError(429, 'too_many_attempts', 'Terlalu banyak percobaan masuk. Coba lagi dalam 15 menit atau atur ulang kata sandi');
    }
    const user = await this.users.findByEmail(input.email);
    const ok = user?.password_hash ? await verifyPassword(user.password_hash, input.password) : await burnPasswordCheck(input.password);
    // Pesan sama untuk email tidak terdaftar dan kata sandi salah (mencegah enumerasi akun).
    if (!user || !ok) {
      const n = await this.redis.incr(failKey);
      if (n === 1) await this.redis.expire(failKey, LOGIN_LOCK_S);
      throw new ApiError(401, 'invalid_credentials', 'Email atau kata sandi salah');
    }
    await this.redis.del(failKey);
    return this.session(await this.assertActive(user), input.device);
  }

  async loginWithGoogle(input: {
    idToken: string;
    privacyVersion?: string;
    device?: string;
  }): Promise<AuthResult & { created: boolean }> {
    const g = await this.google.verify(input.idToken);

    const bySub = await this.users.findByGoogleSub(g.sub);
    if (bySub) {
      return { ...(await this.session(await this.assertActive(bySub), input.device)), created: false };
    }

    const byEmail = await this.users.findByEmail(g.email);
    if (byEmail) {
      // Menautkan Google ke akun email yang sudah ada hanya jika Google menjamin email itu
      // (email_verified). Tanpa ini, orang lain bisa mengambil alih akun lewat akun Google palsu.
      if (!g.emailVerified) throw new ApiError(409, 'email_taken', 'Email sudah terdaftar. Masuk dengan kata sandi');
      await this.assertActive(byEmail);
      await this.pool.query(
        `UPDATE users SET google_sub = $2, email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1`,
        [byEmail.id, g.sub],
      );
      const linked = (await this.users.findById(byEmail.id))!;
      return { ...(await this.session(linked, input.device)), created: false };
    }

    // Akun baru: persetujuan kebijakan privasi wajib sebelum akun dibuat.
    if (!input.privacyVersion) {
      throw new ApiError(428, 'privacy_required', 'Setujui kebijakan privasi untuk membuat akun');
    }
    this.assertPrivacyVersion(input.privacyVersion);
    const user = await this.users.create(this.pool, {
      id: randomUUID(),
      email: g.email,
      emailVerified: g.emailVerified,
      googleSub: g.sub,
      displayName: (g.name ?? g.email.split('@')[0] ?? 'Pelari').slice(0, 60),
      privacyVersion: input.privacyVersion,
    });
    if (!g.emailVerified) await this.sendEmailCode(user.id).catch(() => undefined);
    return { ...(await this.session(user, input.device)), created: true };
  }

  refresh(refreshToken: string): Promise<TokenPair> {
    return this.tokens.rotate(refreshToken);
  }

  logout(userId: string, refreshToken: string | undefined, sessionId: string): Promise<void> {
    return refreshToken ? this.tokens.revokeByRefreshToken(refreshToken, userId) : this.tokens.revokeFamily(sessionId);
  }

  logoutAll(userId: string): Promise<void> {
    return this.tokens.revokeAllForUser(userId);
  }

  // ---------- Verifikasi email ----------

  async sendEmailCode(userId: string): Promise<{ channel: 'email'; expiresInMinutes: number }> {
    const user = await this.requireUser(userId);
    if (user.email_verified_at) throw new ApiError(409, 'already_verified', 'Email sudah terverifikasi');
    const email = this.users.decryptEmail(user);
    if (!email) throw new ApiError(400, 'no_email', 'Akun belum punya email');
    await this.codes.assertCanSend(userId, 'email_verify');
    const code = await this.codes.create(userId, 'email_verify', 'email', { context: 'email', value: email });
    await this.mailer.sendCode(email, 'email_verify', code, 10);
    return { channel: 'email', expiresInMinutes: 10 };
  }

  async verifyEmail(userId: string, code: string) {
    const target = await this.codes.consume(userId, 'email_verify', code);
    const user = await this.requireUser(userId);
    // Pastikan kode dibuat untuk email yang masih sama dengan email akun saat ini.
    if (normalizeEmail(this.users.decryptEmail(user) ?? '') !== normalizeEmail(target)) {
      throw new ApiError(400, 'code_expired', 'Kode sudah tidak berlaku. Minta kode baru');
    }
    await this.pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [userId]);
    return this.users.toMyProfile((await this.users.findById(userId))!);
  }

  // ---------- Verifikasi nomor HP ----------

  /**
   * Kirim OTP lewat WhatsApp; jika wa-otp gagal (nomor diblokir, sesi putus, bukan pengguna WA),
   * otomatis kirim ke email akun yang sudah terverifikasi.
   */
  async sendPhoneCode(userId: string, phone: string): Promise<{ channel: 'whatsapp' | 'email'; expiresInMinutes: number }> {
    const user = await this.requireUser(userId);
    if (await this.users.phoneTakenByOther(phone, userId)) {
      throw new ApiError(409, 'phone_taken', 'Nomor HP sudah dipakai akun lain');
    }
    await this.codes.assertCanSend(userId, 'phone_verify');

    const waCode = await this.codes.create(userId, 'phone_verify', 'whatsapp', { context: 'phone', value: phone });
    if (await this.whatsapp.send(phone, waCode)) return { channel: 'whatsapp', expiresInMinutes: 5 };

    const email = user.email_verified_at ? this.users.decryptEmail(user) : null;
    if (!email) {
      throw new ApiError(503, 'otp_unavailable', 'Kode WhatsApp gagal dikirim. Verifikasi email dulu agar kode bisa dikirim lewat email');
    }
    // Kode baru khusus kanal email (kode WhatsApp di atas otomatis dibatalkan).
    const mailCode = await this.codes.create(userId, 'phone_verify', 'email', { context: 'phone', value: phone });
    await this.mailer.sendCode(email, 'phone_verify', mailCode, 10);
    return { channel: 'email', expiresInMinutes: 10 };
  }

  async verifyPhone(userId: string, code: string) {
    const phone = await this.codes.consume(userId, 'phone_verify', code);
    try {
      await this.pool.query(
        `UPDATE users SET phone_enc = $2, phone_bidx = $3, phone_verified_at = now() WHERE id = $1`,
        [userId, this.crypto.encrypt(phone, phoneAad(userId)), this.crypto.blindIndex('phone', phone)],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new ApiError(409, 'phone_taken', 'Nomor HP sudah dipakai akun lain');
      throw err;
    }
    return this.users.toMyProfile((await this.users.findById(userId))!);
  }

  // ---------- Lupa kata sandi ----------

  /** Selalu sukses dari sisi klien (tidak membocorkan apakah email terdaftar). */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (!user || user.status !== 'active') return;
    try {
      await this.codes.assertCanSend(user.id, 'password_reset');
      const code = await this.codes.create(user.id, 'password_reset', 'email', { context: 'email', value: email });
      await this.mailer.sendCode(this.users.decryptEmail(user)!, 'password_reset', code, 10);
    } catch {
      // Batas laju/gagal kirim disembunyikan agar respons tetap seragam.
    }
  }

  async resetPassword(input: { email: string; code: string; newPassword: string }): Promise<void> {
    const user = await this.users.findByEmail(input.email);
    if (!user || user.status !== 'active') throw new ApiError(400, 'code_expired', 'Kode sudah tidak berlaku. Minta kode baru');
    await this.codes.consume(user.id, 'password_reset', input.code);
    const hash = await hashPassword(input.newPassword);
    await withTx(this.pool, async (db) => {
      // Reset lewat email juga membuktikan kepemilikan email.
      await db.query(
        'UPDATE users SET password_hash = $2, email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1',
        [user.id, hash],
      );
      await this.tokens.revokeAllForUser(user.id, db);
    });
  }

  async changePassword(userId: string, currentPassword: string | undefined, newPassword: string, sessionId: string): Promise<void> {
    const user = await this.requireUser(userId);
    if (user.password_hash && !(currentPassword && (await verifyPassword(user.password_hash, currentPassword)))) {
      throw new ApiError(401, 'invalid_credentials', 'Kata sandi saat ini salah');
    }
    await this.pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, await hashPassword(newPassword)]);
    // Cabut sesi lain; sesi yang sedang dipakai tetap berjalan.
    const { rows } = await this.pool.query<{ family_id: string }>(
      'SELECT DISTINCT family_id FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL AND family_id <> $2',
      [userId, sessionId],
    );
    for (const r of rows) await this.tokens.revokeFamily(r.family_id);
  }

  // ---------- Bantuan ----------

  /**
   * Banding (PRD 1.8): akun yang ditangguhkan/diblokir tidak bisa login, jadi kredensialnya
   * (kata sandi atau ID token Google) diverifikasi di sini. Pesan galat sama dengan login.
   */
  async userForAppeal(input: { email: string; password: string } | { googleIdToken: string }): Promise<UserRow> {
    let user: UserRow | undefined;
    if ('googleIdToken' in input) {
      user = await this.users.findByGoogleSub((await this.google.verify(input.googleIdToken)).sub);
    } else {
      const found = await this.users.findByEmail(input.email);
      const ok = found?.password_hash ? await verifyPassword(found.password_hash, input.password) : await burnPasswordCheck(input.password);
      user = ok ? found : undefined;
    }
    if (!user) throw new ApiError(401, 'invalid_credentials', 'Email atau kata sandi salah');
    if (user.status !== 'suspended' && user.status !== 'banned') throw new ApiError(409, 'not_suspended', 'Akun ini tidak sedang ditangguhkan');
    return user;
  }

  private async session(user: UserRow, device?: string): Promise<AuthResult> {
    const pair = await this.tokens.issue(user.id, user.role, device);
    return { ...pair, user: this.users.toMyProfile(user) };
  }

  private async requireUser(userId: string): Promise<UserRow> {
    const user = await this.users.findById(userId);
    if (!user) throw new ApiError(401, 'unauthorized', 'Perlu login');
    return this.assertActive(user);
  }

  /**
   * Akun harus aktif. Penangguhan sementara yang sudah lewat dipulihkan otomatis di sini.
   * Akun ditangguhkan/diblokir mendapat kode yang bisa diajukan banding (PRD 1.8).
   */
  private async assertActive(user: UserRow): Promise<UserRow> {
    if (user.status === 'suspended' && user.suspended_until && user.suspended_until.getTime() <= Date.now()) {
      await this.pool.query(`UPDATE users SET status = 'active', suspended_until = NULL WHERE id = $1 AND status = 'suspended'`, [user.id]);
      return { ...user, status: 'active', suspended_until: null };
    }
    if (user.status === 'suspended') {
      throw new ApiError(403, 'account_suspended', 'Akun sedang ditangguhkan', {
        until: user.suspended_until?.toISOString() ?? null,
        appealable: true,
      });
    }
    if (user.status === 'banned') throw new ApiError(403, 'account_banned', 'Akun diblokir', { appealable: true });
    if (user.status !== 'active') throw new ApiError(403, 'account_disabled', 'Akun tidak aktif');
    return user;
  }

  private assertPrivacyVersion(version: string) {
    if (version !== this.env.PRIVACY_POLICY_VERSION) {
      throw new ApiError(428, 'privacy_outdated', 'Kebijakan privasi sudah diperbarui. Baca dan setujui versi terbaru', {
        currentVersion: this.env.PRIVACY_POLICY_VERSION,
      });
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

