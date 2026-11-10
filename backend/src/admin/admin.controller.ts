import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { type AuthUser, CurrentUser, Public, ZodPipe } from '../common/http.js';
import { AdminAuthService, AdminGuard } from './admin-auth.service.js';
import { ModerationService } from './moderation.service.js';

const uuid = new ParseUUIDPipe();
const LoginBody = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(128), code: z.string().regex(/^\d{6}$/) }).strict();
const StatusQuery = z.object({ status: z.enum(['open', 'closed']).default('open') });
const TargetType = z.enum(['user', 'community', 'message']);
const ResolveBody = z.object({ action: z.enum(['dismiss', 'remove']), note: z.string().trim().max(500).optional() }).strict();
const Reason = z.string().trim().min(3, 'Tulis alasan').max(500);
const SuspendBody = z.object({ days: z.number().int().min(1).max(365).nullable(), reason: Reason }).strict();
const ReasonBody = z.object({ reason: Reason }).strict();
const LookupBody = z.object({ email: z.string().email().max(254) }).strict();
const DecideBody = z.object({ accept: z.boolean(), note: z.string().trim().min(3, 'Tulis catatan').max(500) }).strict();
const AuditQuery = z.object({ before: z.string().regex(/^\d{1,18}$/).optional() });

/** Login panel admin. Batas 5/menit per IP, ditambah kunci 15 menit per akun setelah 5 kali gagal. */
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodPipe(LoginBody)) b: z.infer<typeof LoginBody>) {
    return this.auth.login(b);
  }
}

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly mod: ModerationService) {}

  @Get('me')
  me(@CurrentUser() u: AuthUser) {
    return { id: u.id };
  }

  @Get('reports')
  reports(@Query(new ZodPipe(StatusQuery)) q: z.infer<typeof StatusQuery>) {
    return this.mod.queue(q.status);
  }

  @Get('reports/:type/:id')
  target(@CurrentUser() u: AuthUser, @Param('type', new ZodPipe(TargetType)) type: z.infer<typeof TargetType>, @Param('id', uuid) id: string) {
    return this.mod.target(u.id, type, id);
  }

  @Post('reports/:type/:id/resolve')
  @HttpCode(204)
  async resolve(
    @CurrentUser() u: AuthUser,
    @Param('type', new ZodPipe(TargetType)) type: z.infer<typeof TargetType>,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(ResolveBody)) b: z.infer<typeof ResolveBody>,
  ) {
    await this.mod.resolve(u.id, type, id, b.action, b.note);
  }

  @Get('users/:id')
  user(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.mod.user(u.id, id);
  }

  /** Email di body, bukan query string (data pribadi tidak boleh masuk URL). */
  @Post('users/lookup')
  @HttpCode(200)
  lookup(@CurrentUser() u: AuthUser, @Body(new ZodPipe(LookupBody)) b: z.infer<typeof LookupBody>) {
    return this.mod.lookup(u.id, b.email);
  }

  @Post('users/:id/suspend')
  @HttpCode(204)
  async suspend(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(SuspendBody)) b: z.infer<typeof SuspendBody>) {
    await this.mod.suspend(u.id, id, b);
  }

  @Post('users/:id/ban')
  @HttpCode(204)
  async ban(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(ReasonBody)) b: z.infer<typeof ReasonBody>) {
    await this.mod.ban(u.id, id, b.reason);
  }

  @Post('users/:id/reinstate')
  @HttpCode(204)
  async reinstate(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(ReasonBody)) b: z.infer<typeof ReasonBody>) {
    await this.mod.reinstate(u.id, id, b.reason);
  }

  @Get('appeals')
  appeals(@Query(new ZodPipe(StatusQuery)) q: z.infer<typeof StatusQuery>) {
    return this.mod.appeals(q.status);
  }

  @Post('appeals/:id/decide')
  @HttpCode(204)
  async decide(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(DecideBody)) b: z.infer<typeof DecideBody>) {
    await this.mod.decideAppeal(u.id, id, b.accept, b.note);
  }

  @Get('audit')
  audit(@Query(new ZodPipe(AuditQuery)) q: z.infer<typeof AuditQuery>) {
    return this.mod.auditLog(q.before);
  }
}
