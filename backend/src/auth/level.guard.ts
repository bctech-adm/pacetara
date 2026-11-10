import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type pg from 'pg';
import { ApiError, type AuthedRequest } from '../common/http.js';
import { PG_POOL } from '../core.module.js';

const REQUIRED_LEVEL = 'requiredLevel';

/** Wajib tingkat verifikasi minimal (PRD: Level 1 untuk semua pengguna, Level 2 untuk pemilik/penjual/sponsor). */
export const RequireLevel = (level: 1 | 2) => SetMetadata(REQUIRED_LEVEL, level);

@Injectable()
export class LevelGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const level = this.reflector.getAllAndOverride<number | undefined>(REQUIRED_LEVEL, [ctx.getHandler(), ctx.getClass()]);
    if (!level) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user) throw new ApiError(401, 'unauthorized', 'Perlu login');
    const { rows } = await this.pool.query<{ verification_level: number; status: string }>(
      'SELECT verification_level, status FROM users WHERE id = $1',
      [req.user.id],
    );
    const row = rows[0];
    if (!row || row.status !== 'active') throw new ApiError(401, 'unauthorized', 'Perlu login');
    if (row.verification_level < level) {
      throw new ApiError(403, 'verification_required', 'Verifikasi email dan nomor HP dulu untuk memakai fitur ini', {
        requiredLevel: level,
      });
    }
    return true;
  }
}
