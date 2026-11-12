import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { LevelGuard, RequireLevel } from '../auth/level.guard.js';
import { ApiError, type AuthUser, CurrentUser, Public, ZodPipe } from '../common/http.js';
import type { Point } from '../runs/geo.js';
import { type CallbackOutcome, ImportsService, PROVIDER_PATHS, type ProviderPath } from './imports.service.js';
import type { OAuthProvider } from './types.js';

const point = z.tuple([
  z.number().min(-90).max(90),
  z.number().min(-180).max(180),
  z.number().min(0).max(86_400),
  z.number().min(-500).max(9000).nullable(),
]);

const HealthConnectBody = z
  .object({
    externalId: z.string().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/),
    originPackage: z.string().max(200).regex(/^[A-Za-z0-9._]*$/).default(''),
    exerciseType: z.enum(['running', 'running_treadmill']),
    title: z.string().trim().max(80).default(''),
    visibility: z.enum(['public', 'community', 'private']).default('community'),
    startedAt: z.coerce.date(),
    endedAt: z.coerce.date(),
    distanceM: z.number().min(0).max(300_000).nullable().default(null),
    route: z.array(point).max(15_000).default([]),
  })
  .strict()
  .refine((b) => b.endedAt > b.startedAt, { message: 'Waktu selesai sebelum waktu mulai', path: ['endedAt'] })
  .refine((b) => b.endedAt.getTime() - b.startedAt.getTime() <= 24 * 3600 * 1000, { message: 'Lari maksimal 24 jam', path: ['endedAt'] })
  .refine((b) => b.endedAt.getTime() <= Date.now() + 10 * 60 * 1000, { message: 'Waktu lari di masa depan', path: ['endedAt'] });

const CheckBody = z.object({ ids: z.array(z.string().min(1).max(100)).max(200) }).strict();
const DisconnectQuery = z.object({ deleteRuns: z.enum(['true', 'false']).default('false') });

const StravaEventBody = z.object({
  object_type: z.enum(['activity', 'athlete']),
  object_id: z.number().int().positive(),
  aspect_type: z.enum(['create', 'update', 'delete']),
  owner_id: z.number().int().positive(),
  subscription_id: z.number().int().nonnegative(),
  event_time: z.number().int().optional(),
  updates: z.record(z.string(), z.unknown()).optional(),
});

function oauthProvider(p: string): OAuthProvider {
  if (p === 'garmin' || p === 'strava') return p;
  throw new ApiError(404, 'not_found', 'Penyedia tidak dikenal');
}
function providerPath(p: string): ProviderPath {
  if (p in PROVIDER_PATHS) return p as ProviderPath;
  throw new ApiError(404, 'not_found', 'Penyedia tidak dikenal');
}

/** Endpoint impor untuk pengguna yang login (Level 1, seperti lari). */
@Controller('imports')
@UseGuards(LevelGuard)
@RequireLevel(1)
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Get()
  status(@CurrentUser() u: AuthUser) {
    return this.imports.status(u.id);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('health-connect')
  @HttpCode(200)
  healthConnect(@CurrentUser() u: AuthUser, @Body(new ZodPipe(HealthConnectBody)) b: z.infer<typeof HealthConnectBody>) {
    return this.imports.importHealthConnect(u.id, { ...b, route: b.route as Point[] });
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('health-connect/check')
  @HttpCode(200)
  check(@CurrentUser() u: AuthUser, @Body(new ZodPipe(CheckBody)) b: z.infer<typeof CheckBody>) {
    return this.imports.knownHealthConnect(u.id, b.ids);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':provider/connect')
  @HttpCode(200)
  connect(@CurrentUser() u: AuthUser, @Param('provider') p: string) {
    return this.imports.connect(u.id, oauthProvider(p));
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('strava/sync')
  @HttpCode(202)
  async sync(@CurrentUser() u: AuthUser) {
    await this.imports.requestStravaSync(u.id);
    return { queued: true };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Delete(':provider')
  disconnect(@CurrentUser() u: AuthUser, @Param('provider') p: string, @Query(new ZodPipe(DisconnectQuery)) q: z.infer<typeof DisconnectQuery>) {
    return this.imports.disconnect(u.id, providerPath(p), { deleteRuns: q.deleteRuns === 'true' });
  }
}

/** Endpoint publik: callback OAuth (browser) dan webhook penyedia. Semua dibatasi laju per IP. */
@Controller('imports')
export class ImportWebhooksController {
  constructor(private readonly imports: ImportsService) {}

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':provider/callback')
  async callback(@Param('provider') p: string, @Query() q: Record<string, unknown>, @Res() res: Response) {
    const outcome = await this.imports.callback(oauthProvider(p), q);
    res
      .status(outcome.ok ? 200 : 400)
      .setHeader('Cache-Control', 'no-store')
      .type('html')
      .send(callbackPage(outcome));
  }

  @Public()
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Post('garmin/push/:key')
  @HttpCode(200)
  garminPush(@Param('key') key: string, @Body() body: unknown) {
    if (!this.imports.enabled('garmin')) throw new ApiError(503, 'not_configured', 'Impor Garmin belum tersedia');
    // Kunci salah = seolah endpoint tidak ada.
    if (!this.imports.garminKeyMatches(key)) throw new ApiError(404, 'not_found', 'Tidak ditemukan');
    return this.imports.garminPush(body);
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('strava/webhook')
  stravaVerify(@Query() q: Record<string, unknown>) {
    return this.imports.stravaVerify(q);
  }

  @Public()
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Post('strava/webhook')
  @HttpCode(200)
  stravaEvent(@Body(new ZodPipe(StravaEventBody)) b: z.infer<typeof StravaEventBody>) {
    return this.imports.stravaEvent(b);
  }
}

/** Halaman hasil OAuth. Pesan statis dari server (tanpa input pengguna), tanpa JavaScript. */
function callbackPage(o: CallbackOutcome): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${esc(o.title)} · PaceTara</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#1b1b1b}
h1{font-size:1.4rem}a.btn{display:inline-block;margin-top:1rem;padding:.7rem 1.2rem;border-radius:.6rem;background:#e85d04;color:#fff;text-decoration:none}</style>
</head><body><h1>${esc(o.title)}</h1><p>${esc(o.message)}</p>
<a class="btn" href="pacetara://app/imports">Kembali ke PaceTara</a>
<p><small>Jika tombol tidak berfungsi, tutup halaman ini dan buka aplikasi PaceTara.</small></p>
</body></html>`;
}
