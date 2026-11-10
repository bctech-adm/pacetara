import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ModerationService } from '../admin/moderation.service.js';
import { AuthService } from '../auth/auth.service.js';
import { LevelGuard, RequireLevel } from '../auth/level.guard.js';
import { type AuthUser, CurrentUser, Public, ZodPipe } from '../common/http.js';
import { REPORT_REASONS, ReportsService } from './reports.service.js';

const ReportBody = z
  .object({
    targetType: z.enum(['user', 'community', 'message']),
    targetId: z.string().uuid(),
    reason: z.enum(REPORT_REASONS),
    details: z.string().trim().max(500).optional(),
  })
  .strict();

@Controller('reports')
@UseGuards(LevelGuard)
@RequireLevel(1)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Throttle({ default: { limit: 20, ttl: 3_600_000 } })
  @Post()
  @HttpCode(201)
  async create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(ReportBody)) b: z.infer<typeof ReportBody>) {
    const { id } = await this.reports.create(u.id, { ...b, details: b.details || undefined });
    return { id };
  }
}

const AppealBody = z.union([
  z.object({ email: z.string().email().max(254), password: z.string().min(1).max(128), message: z.string().trim().min(10, 'Jelaskan minimal 10 karakter').max(2000) }).strict(),
  z.object({ googleIdToken: z.string().min(10).max(4096), message: z.string().trim().min(10, 'Jelaskan minimal 10 karakter').max(2000) }).strict(),
]);

/** Banding akun yang ditangguhkan/diblokir. Akun tidak bisa login, jadi kredensial diverifikasi di sini. */
@Controller('auth')
export class AppealController {
  constructor(
    private readonly auth: AuthService,
    private readonly moderation: ModerationService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post('appeal')
  @HttpCode(202)
  async appeal(@Body(new ZodPipe(AppealBody)) b: z.infer<typeof AppealBody>) {
    const user = await this.auth.userForAppeal(b);
    await this.moderation.createAppeal(user.id, b.message);
    return { status: 'received' };
  }
}
