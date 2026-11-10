import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { burnPasswordCheck, verifyPassword } from '../auth/password.js';
import { TokenService } from '../auth/token.service.js';
import type { Queryable } from '../common/db.js';
import { ApiError, type AuthedRequest } from '../common/http.js';
import { PG_POOL, REDIS } from '../core.module.js';
import { FieldCrypto } from '../crypto/field-crypto.js';
import { UsersRepository } from '../users/users.repository.js';
import { verifyTotp } from './totp.js';

export const totpAad = (userId: string) => `users.totp:${userId}`;
const MAX_FAILURES = 5;
const LOCK_S = 15 * 60;

/** Catat tindakan super admin. Tabel hanya bisa ditambah (trigger menolak UPDATE/DELETE). Jangan simpan data pribadi di metadata. */
export async function audit(
  db: Queryable,
  actorId: string | null,
  action: string,
  target?: { type: string; id: string },
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await db.query('INSERT INTO admin_audit_log (actor_id, action, target_type, target_id, metadata) VALUES ($1, $2, $3, $4, $5)', [
    actorId,
    action,
    target?.type ?? null,
    target?.id ?? null,
    JSON.stringify(metadata),
  ]);
}

/**
 * Login panel super admin: email + kata sandi + kode TOTP. Semua kegagalan memberi pesan yang sama
 * (tidak membocorkan faktor mana yang salah). 5 kali gagal → akun panel dikunci 15 menit.
 * Kode TOTP tidak bisa dipakai dua kali. Token yang dihasilkan bertanda `adm` dan sesinya maks. 12 jam.
 */
@Injectable()
export class AdminAuthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly users: UsersRepository,
    private readonly tokens: TokenService,
    private readonly crypto: FieldCrypto,
  ) {}

  async login(input: { email: string; password: string; code: string }) {
    const fail = () => new ApiError(401, 'invalid_credentials', 'Email, kata sandi, atau kode salah');
    const user = await this.users.findByEmail(input.email);
    const pwOk = user?.password_hash ? await verifyPassword(user.password_hash, input.password) : await burnPasswordCheck(input.password);
    if (!user) throw fail();

    const failKey = `admin:fail:${user.id}`;
    if (Number((await this.redis.get(failKey)) ?? 0) >= MAX_FAILURES) {
      await audit(this.pool, user.id, 'admin.login_locked');
      throw new ApiError(429, 'admin_locked', 'Terlalu banyak percobaan. Coba lagi dalam 15 menit');
    }

    const { rows } = await this.pool.query<{ totp_secret_enc: Buffer | null }>('SELECT totp_secret_enc FROM users WHERE id = $1', [user.id]);
    const secretEnc = rows[0]?.totp_secret_enc;
    let step: number | null = null;
    if (pwOk && user.role === 'super_admin' && user.status === 'active' && secretEnc) {
      step = verifyTotp(this.crypto.decryptString(secretEnc, totpAad(user.id)), input.code);
      // Kode yang sama tidak boleh dipakai lagi (mis. disadap saat diketik).
      if (step !== null && (await this.redis.set(`admin:totp:${user.id}:${step}`, '1', 'EX', 120, 'NX')) !== 'OK') step = null;
    }
    if (step === null) {
      const n = await this.redis.incr(failKey);
      if (n === 1) await this.redis.expire(failKey, LOCK_S);
      if (user.role === 'super_admin') await audit(this.pool, user.id, 'admin.login_failed');
      throw fail();
    }
    await this.redis.del(failKey);
    await audit(this.pool, user.id, 'admin.login');
    const pair = await this.tokens.issue(user.id, 'super_admin', 'Panel admin', { admin: true });
    return { ...pair, admin: { id: user.id, displayName: user.display_name } };
  }
}

/** Endpoint /v1/admin: wajib token sesi panel (kata sandi + TOTP), peran super_admin, dan akun aktif. */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const u = req.user;
    if (!u || u.role !== 'super_admin' || !u.admin) throw new ApiError(403, 'admin_only', 'Khusus super admin lewat panel');
    const { rows } = await this.pool.query<{ role: string; status: string }>('SELECT role, status FROM users WHERE id = $1', [u.id]);
    if (rows[0]?.role !== 'super_admin' || rows[0].status !== 'active') throw new ApiError(403, 'admin_only', 'Khusus super admin lewat panel');
    return true;
  }
}
