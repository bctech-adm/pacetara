import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { jwtVerify, SignJWT } from 'jose';
import type pg from 'pg';
import { withTx } from '../common/db.js';
import { ApiError, type AuthUser } from '../common/http.js';
import { ENV, type Env } from '../config/env.js';
import { PG_POOL, REDIS } from '../core.module.js';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Detik sampai token akses kedaluwarsa. */
  expiresIn: number;
}

const ISSUER = 'pacetara';
const revokedKey = (sessionId: string) => `auth:revoked:${sessionId}`;
const sha256 = (v: string) => createHash('sha256').update(v).digest();

/**
 * Token akses: JWT HS256 berumur pendek berisi `sid` (id family sesi).
 * Token penyegar: string acak, hanya hash-nya disimpan, dirotasi setiap dipakai.
 * Memakai ulang token penyegar lama = indikasi pencurian → seluruh family dicabut.
 * Sesi yang dicabut dicatat di Redis selama umur token akses, sehingga token akses yang
 * masih berlaku ikut ditolak (logout benar-benar mencabut semuanya).
 */
@Injectable()
export class TokenService {
  private readonly key: Uint8Array;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    this.key = Buffer.from(env.JWT_SECRET, 'base64');
  }

  async issue(userId: string, role: AuthUser['role'], deviceLabel?: string): Promise<TokenPair> {
    const familyId = randomUUID();
    const refreshToken = randomBytes(32).toString('base64url');
    await this.pool.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, device_label, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`,
      [userId, familyId, sha256(refreshToken), deviceLabel?.slice(0, 80) ?? null, this.env.REFRESH_TOKEN_TTL_DAYS],
    );
    return { accessToken: await this.signAccess(userId, familyId, role), refreshToken, expiresIn: this.env.ACCESS_TOKEN_TTL_SEC };
  }

  async rotate(refreshToken: string): Promise<TokenPair> {
    const outcome = await withTx(this.pool, async (db) => {
      const { rows } = await db.query<{
        id: string;
        user_id: string;
        family_id: string;
        device_label: string | null;
        expired: boolean;
        revoked_at: Date | null;
        role: AuthUser['role'];
        status: string;
      }>(
        `SELECT t.id, t.user_id, t.family_id, t.device_label, t.expires_at < now() AS expired,
                t.revoked_at, u.role, u.status
           FROM refresh_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = $1
          FOR UPDATE OF t`,
        [sha256(refreshToken)],
      );
      const row = rows[0];
      if (!row) return { kind: 'invalid' as const };
      if (row.revoked_at) return { kind: 'reused' as const, familyId: row.family_id };
      if (row.expired || row.status !== 'active') return { kind: 'invalid' as const };

      const next = randomBytes(32).toString('base64url');
      const { rows: inserted } = await db.query<{ id: string }>(
        `INSERT INTO refresh_tokens (user_id, family_id, token_hash, device_label, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(days => $5)) RETURNING id`,
        [row.user_id, row.family_id, sha256(next), row.device_label, this.env.REFRESH_TOKEN_TTL_DAYS],
      );
      await db.query('UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1', [
        row.id,
        inserted[0]!.id,
      ]);
      return { kind: 'ok' as const, next, row };
    });

    if (outcome.kind === 'reused') {
      await this.revokeFamily(outcome.familyId);
      throw new ApiError(401, 'token_reused', 'Sesi tidak valid, silakan masuk lagi');
    }
    if (outcome.kind === 'invalid') throw new ApiError(401, 'invalid_refresh_token', 'Sesi berakhir, silakan masuk lagi');

    const { row, next } = outcome;
    return {
      accessToken: await this.signAccess(row.user_id, row.family_id, row.role),
      refreshToken: next,
      expiresIn: this.env.ACCESS_TOKEN_TTL_SEC,
    };
  }

  /** Logout satu perangkat: cabut family milik token ini. Diam saja jika token tidak dikenal. */
  async revokeByRefreshToken(refreshToken: string, userId: string): Promise<void> {
    const { rows } = await this.pool.query<{ family_id: string }>(
      'SELECT family_id FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2',
      [sha256(refreshToken), userId],
    );
    if (rows[0]) await this.revokeFamily(rows[0].family_id);
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [
      familyId,
    ]);
    await this.redis.set(revokedKey(familyId), '1', 'EX', this.env.ACCESS_TOKEN_TTL_SEC + 60);
  }

  async revokeAllForUser(userId: string, db: Pick<pg.Pool, 'query'> = this.pool): Promise<void> {
    const { rows } = await db.query<{ family_id: string }>(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL RETURNING family_id`,
      [userId],
    );
    const families = [...new Set(rows.map((r) => r.family_id))];
    if (families.length === 0) return;
    const multi = this.redis.multi();
    for (const f of families) multi.set(revokedKey(f), '1', 'EX', this.env.ACCESS_TOKEN_TTL_SEC + 60);
    await multi.exec();
  }

  /** Memverifikasi token akses. Melempar 401 jika tidak valid, kedaluwarsa, atau sesinya dicabut. */
  async verifyAccess(token: string): Promise<AuthUser> {
    let payload: { sub?: string; sid?: unknown; role?: unknown };
    try {
      ({ payload } = await jwtVerify(token, this.key, { issuer: ISSUER, algorithms: ['HS256'] }));
    } catch {
      throw new ApiError(401, 'invalid_access_token', 'Token akses tidak valid atau kedaluwarsa');
    }
    const { sub, sid, role } = payload;
    if (typeof sub !== 'string' || typeof sid !== 'string' || (role !== 'user' && role !== 'super_admin')) {
      throw new ApiError(401, 'invalid_access_token', 'Token akses tidak valid');
    }
    if (await this.redis.exists(revokedKey(sid))) {
      throw new ApiError(401, 'session_revoked', 'Sesi sudah berakhir, silakan masuk lagi');
    }
    return { id: sub, sessionId: sid, role };
  }

  private signAccess(userId: string, familyId: string, role: AuthUser['role']): Promise<string> {
    return new SignJWT({ sid: familyId, role })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime(`${this.env.ACCESS_TOKEN_TTL_SEC}s`)
      .sign(this.key);
  }
}
