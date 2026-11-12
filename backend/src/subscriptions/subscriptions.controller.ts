import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AdminGuard } from '../admin/admin-auth.service.js';
import { LevelGuard, RequireLevel } from '../auth/level.guard.js';
import { type AuthUser, CurrentUser, Public, ZodPipe } from '../common/http.js';
import { PURCHASE_TOKEN_RE } from './config.js';
import { SubscriptionsService } from './subscriptions.service.js';

const uuid = new ParseUUIDPipe();
const Kind = z.enum(['premium', 'pro', 'pro_unlimited']);
const IntentBody = z.object({ plan: Kind, communityId: z.string().uuid().optional() }).strict();
// Tidak ada field paket/status: klien tidak pernah bisa menyetel paket; hanya mengirim bukti pembelian.
const VerifyBody = z
  .object({
    productId: z.string().regex(/^[a-z0-9][a-z0-9._]{0,98}$/),
    purchaseToken: z.string().regex(PURCHASE_TOKEN_RE),
    communityId: z.string().uuid().optional(),
  })
  .strict();
const Reason = z.string().trim().min(3, 'Tulis alasan').max(500);
const GrantBody = z
  .object({
    userId: z.string().uuid().optional(),
    communityId: z.string().uuid().optional(),
    plan: Kind,
    days: z.number().int().min(1).max(365),
    reason: Reason,
  })
  .strict();
const ReasonBody = z.object({ reason: Reason }).strict();
const SearchBody = z.object({ q: z.string().trim().min(2).max(80) }).strict();

/** Langganan pengguna (Level 1, seperti komunitas). */
@Controller('subscriptions')
@UseGuards(LevelGuard)
@RequireLevel(1)
export class SubscriptionsController {
  constructor(private readonly subs: SubscriptionsService) {}

  @Get()
  status(@CurrentUser() u: AuthUser) {
    return this.subs.status(u.id);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('play/intent')
  @HttpCode(200)
  intent(@CurrentUser() u: AuthUser, @Body(new ZodPipe(IntentBody)) b: z.infer<typeof IntentBody>) {
    return this.subs.intent(u.id, b.plan, b.communityId);
  }

  /** Batas laju ketat: setiap panggilan memanggil API Google. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('play/verify')
  @HttpCode(200)
  verify(@CurrentUser() u: AuthUser, @Body(new ZodPipe(VerifyBody)) b: z.infer<typeof VerifyBody>) {
    return this.subs.verify(u.id, b);
  }
}

/** Real-time Developer Notifications (Pub/Sub push). Publik, tetapi wajib token OIDC Pub/Sub yang sah. */
@Controller('subscriptions/play')
export class PlayRtdnController {
  constructor(private readonly subs: SubscriptionsService) {}

  @Public()
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Post('rtdn')
  @HttpCode(204)
  async rtdn(@Headers('authorization') authorization: string | undefined, @Body() body: unknown) {
    await this.subs.handleRtdn(authorization, body);
  }
}

/** Panel super admin: lihat status (read-only) dan pemberian paket manual berbatas waktu (tercatat di log). */
@Controller('admin/subscriptions')
@UseGuards(AdminGuard)
export class AdminSubscriptionsController {
  constructor(private readonly subs: SubscriptionsService) {}

  @Get('users/:id')
  user(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.subs.adminUser(u.id, id);
  }

  @Get('communities/:id')
  community(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.subs.adminCommunity(u.id, id);
  }

  @Post('communities/search')
  @HttpCode(200)
  search(@Body(new ZodPipe(SearchBody)) b: z.infer<typeof SearchBody>) {
    return this.subs.searchCommunities(b.q);
  }

  @Post('grants')
  grant(@CurrentUser() u: AuthUser, @Body(new ZodPipe(GrantBody)) b: z.infer<typeof GrantBody>) {
    return this.subs.grant(u.id, b);
  }

  @Post('grants/:id/revoke')
  @HttpCode(204)
  async revoke(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(ReasonBody)) b: z.infer<typeof ReasonBody>) {
    await this.subs.revokeGrant(u.id, id, b.reason);
  }
}
