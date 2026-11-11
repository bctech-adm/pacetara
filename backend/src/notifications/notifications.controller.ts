import { Body, Controller, Get, HttpCode, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { LevelGuard, RequireLevel } from '../auth/level.guard.js';
import { type AuthUser, CurrentUser, ZodPipe } from '../common/http.js';
import { NOTIF_CATEGORIES, NotificationsService } from './notifications.service.js';

const ListQuery = z.object({ before: z.string().uuid().optional() });
const SettingsBody = z
  .object(Object.fromEntries(NOTIF_CATEGORIES.map((c) => [c, z.boolean().optional()])) as Record<(typeof NOTIF_CATEGORIES)[number], z.ZodOptional<z.ZodBoolean>>)
  .strict();
// Token FCM ±150–250 karakter; di body, bukan URL.
const TokenBody = z.object({ token: z.string().min(20).max(4096).regex(/^[\w:.-]+$/) }).strict();

@Controller()
@UseGuards(LevelGuard)
@RequireLevel(1)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('notifications')
  list(@CurrentUser() u: AuthUser, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.notifications.list(u.id, q.before);
  }

  @Post('notifications/read')
  @HttpCode(204)
  async read(@CurrentUser() u: AuthUser) {
    await this.notifications.markAllRead(u.id);
  }

  @Get('me/notification-settings')
  settings(@CurrentUser() u: AuthUser) {
    return this.notifications.settings(u.id);
  }

  @Put('me/notification-settings')
  updateSettings(@CurrentUser() u: AuthUser, @Body(new ZodPipe(SettingsBody)) b: z.infer<typeof SettingsBody>) {
    return this.notifications.updateSettings(u.id, b);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Put('me/push-token')
  @HttpCode(204)
  async registerToken(@CurrentUser() u: AuthUser, @Body(new ZodPipe(TokenBody)) b: z.infer<typeof TokenBody>) {
    await this.notifications.registerToken(u.id, u.sessionId, b.token);
  }

  @Post('me/push-token/remove')
  @HttpCode(204)
  async removeToken(@CurrentUser() u: AuthUser, @Body(new ZodPipe(TokenBody)) b: z.infer<typeof TokenBody>) {
    await this.notifications.removeToken(u.id, b.token);
  }
}
