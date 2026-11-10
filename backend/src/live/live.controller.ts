import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { LevelGuard, RequireLevel } from '../auth/level.guard.js';
import { type AuthUser, CurrentUser, ZodPipe } from '../common/http.js';
import { LiveService } from './live.service.js';

const latLng = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

const UpdateBody = z
  .object({
    clientRunId: z.string().uuid(),
    communities: z.array(z.object({ id: z.string().uuid(), showLocation: z.boolean() })).max(50),
    startedAt: z.coerce.date(),
    distanceM: z.number().min(0).max(500_000),
    movingTimeS: z.number().int().min(0).max(86_400),
    paused: z.boolean(),
    position: latLng.nullable().optional(),
    origin: latLng.nullable().optional(),
  })
  .refine((b) => b.startedAt.getTime() <= Date.now() + 10 * 60 * 1000, { message: 'Waktu mulai di masa depan', path: ['startedAt'] })
  .refine((b) => b.startedAt.getTime() >= Date.now() - 24 * 3600 * 1000, { message: 'Lari maksimal 24 jam', path: ['startedAt'] });

const EndBody = z.object({ clientRunId: z.string().uuid().optional() }).strict().optional();
const uuid = new ParseUUIDPipe();

@Controller()
@UseGuards(LevelGuard)
@RequireLevel(1)
export class LiveController {
  constructor(private readonly live: LiveService) {}

  /** Mulai/perbarui status lari (aplikasi memanggil tiap ±10 detik selama merekam). Body berisi posisi, jadi PUT, bukan query. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Put('live')
  update(@CurrentUser() u: AuthUser, @Body(new ZodPipe(UpdateBody)) b: z.infer<typeof UpdateBody>) {
    return this.live.update(u.id, b);
  }

  @Get('live')
  mine(@CurrentUser() u: AuthUser) {
    return this.live.mine(u.id);
  }

  @Delete('live')
  @HttpCode(204)
  async end(@CurrentUser() u: AuthUser, @Body(new ZodPipe(EndBody)) b: z.infer<typeof EndBody>) {
    await this.live.end(u.id, b?.clientRunId);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('communities/:id/live')
  list(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.live.list(u.id, id);
  }
}
