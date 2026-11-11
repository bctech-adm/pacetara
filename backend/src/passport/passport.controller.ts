import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { LevelGuard, RequireLevel } from '../auth/level.guard.js';
import { ApiError, type AuthUser, CurrentUser, ZodPipe } from '../common/http.js';
import { MAX_UPLOAD_BYTES } from '../storage/image.js';
import { PassportService } from './passport.service.js';
import { STATS_MAX_COUNT, StatsService } from './stats.service.js';

const uuid = new ParseUUIDPipe();
const category = z.enum(['fun', '5k', '10k', 'hm', 'fm', 'ultra', 'other']);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tanggal YYYY-MM-DD');

const MedalBody = z
  .object({
    title: z.string().trim().min(1, 'Nama medali wajib diisi').max(120),
    eventId: z.string().uuid().optional(),
    eventDate: date.optional(),
    category: category.optional(),
  })
  .strict();

const ResultBody = z
  .object({
    eventId: z.string().uuid().optional(),
    eventName: z.string().trim().min(3, 'Nama event minimal 3 karakter').max(120).optional(),
    eventDate: date.optional(),
    category,
    distanceM: z.number().int().min(100).max(500_000).nullable().optional(),
    officialTimeS: z.number().int().min(60, 'Catatan waktu tidak valid').max(604_800),
  })
  .strict()
  .refine((b) => b.eventId || (b.eventName && b.eventDate), { message: 'Pilih event atau isi nama dan tanggal event', path: ['eventName'] });

const ResultPatch = z
  .object({
    category,
    distanceM: z.number().int().min(100).max(500_000).nullable(),
    officialTimeS: z.number().int().min(60).max(604_800),
  })
  .partial()
  .strict();

const VisibilityBody = z.object({ visibility: z.enum(['community', 'private']) }).strict();

const StatsQuery = z
  .object({
    period: z.enum(['week', 'month', 'year']).default('week'),
    count: z.coerce.number().int().min(1).max(Math.max(...Object.values(STATS_MAX_COUNT))).optional(),
  })
  .strict();

/** Body medali: multipart dengan field `data` (JSON) dan berkas `photo`. Data di body, tidak di URL. */
function parseMedalBody(raw: unknown): z.infer<typeof MedalBody> {
  const data = raw && typeof raw === 'object' ? (raw as { data?: unknown }).data : undefined;
  if (typeof data !== 'string') throw new ApiError(400, 'invalid_input', 'Data medali tidak valid');
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new ApiError(400, 'invalid_input', 'Data medali tidak valid');
  }
  return new ZodPipe(MedalBody).transform(value, { type: 'body' });
}

@Controller()
@UseGuards(LevelGuard)
@RequireLevel(1)
export class PassportController {
  constructor(
    private readonly passport: PassportService,
    private readonly stats: StatsService,
  ) {}

  /** Statistik riwayat lari sendiri (WIB, minggu mulai Senin). */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('runs/mine/stats')
  runStats(@CurrentUser() u: AuthUser, @Query(new ZodPipe(StatsQuery)) q: z.infer<typeof StatsQuery>) {
    return this.stats.stats(u.id, q.period, q.count);
  }

  @Get('passport/me')
  mine(@CurrentUser() u: AuthUser) {
    return this.passport.mine(u.id);
  }

  @Put('passport/settings')
  settings(@CurrentUser() u: AuthUser, @Body(new ZodPipe(VisibilityBody)) b: z.infer<typeof VisibilityBody>) {
    return this.passport.setVisibility(u.id, b.visibility);
  }

  @Get('passport/events')
  events(@CurrentUser() u: AuthUser) {
    return this.passport.joinedEvents(u.id);
  }

  @Get('passport/users/:id')
  ofUser(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.passport.ofUser(u.id, id);
  }

  // Unggah foto medali: maks. 10/menit (dan MEDAL_UPLOADS_PER_DAY per hari di service), maks. 8 MB.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('passport/medals')
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 1, fieldSize: 4096, parts: 2 } }))
  addMedal(@CurrentUser() u: AuthUser, @Body() raw: unknown, @UploadedFile() file?: { buffer?: Buffer }) {
    const b = parseMedalBody(raw);
    if (!file?.buffer) throw new ApiError(400, 'file_required', 'Pilih foto medali terlebih dahulu');
    return this.passport.addMedal(u.id, b, file.buffer);
  }

  @Delete('passport/medals/:id')
  @HttpCode(204)
  async removeMedal(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.passport.removeMedal(u.id, id);
  }

  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Get('passport/medals/:id/photo')
  async medalPhoto(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Res() res: Response) {
    const file = await this.passport.medalPhoto(u.id, id);
    if (!file) throw new ApiError(404, 'not_found', 'Foto tidak ditemukan');
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (file.length) res.setHeader('Content-Length', String(file.length));
    file.stream.pipe(res);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('passport/results')
  @HttpCode(201)
  addResult(@CurrentUser() u: AuthUser, @Body(new ZodPipe(ResultBody)) b: z.infer<typeof ResultBody>) {
    return this.passport.addResult(u.id, b);
  }

  @Patch('passport/results/:id')
  updateResult(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(ResultPatch)) b: z.infer<typeof ResultPatch>) {
    return this.passport.updateResult(u.id, id, b);
  }

  @Delete('passport/results/:id')
  @HttpCode(204)
  async removeResult(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.passport.removeResult(u.id, id);
  }
}
