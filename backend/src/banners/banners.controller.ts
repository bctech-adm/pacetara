import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { AdminGuard } from '../admin/admin-auth.service.js';
import { LevelGuard, RequireLevel } from '../auth/level.guard.js';
import { ApiError, type AuthUser, CurrentUser, ZodPipe } from '../common/http.js';
import { MAX_UPLOAD_BYTES } from '../storage/image.js';
import { BANNER_SLOTS, BannersService } from './banners.service.js';

const uuid = new ParseUUIDPipe();
const Slot = z.enum(BANNER_SLOTS as [string, ...string[]]).transform((s) => s as (typeof BANNER_SLOTS)[number]);
const BannerBody = z
  .object({
    slot: Slot,
    title: z.string().trim().min(3).max(80),
    eventId: z.string().uuid().optional(),
    targetUrl: z.string().trim().max(500).optional(),
    cities: z.array(z.string().trim().min(2).max(60)).max(10).default([]),
    startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tanggal YYYY-MM-DD'),
    days: z.number().int().min(1).max(90),
  })
  .strict();
const QuoteBody = z.object({ slot: Slot, days: z.number().int().min(1).max(90), cities: z.number().int().min(0).max(10) }).strict();
// Kota pengguna dikirim di body, bukan URL.
const PickBody = z.object({ slot: Slot, city: z.string().trim().max(60).optional(), eventId: z.string().uuid().optional() }).strict();
const AdminQuery = z.object({ status: z.enum(['pending_review', 'approved', 'rejected', 'pending_payment', 'cancelled']).default('pending_review') });
const RejectBody = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

function sendImage(res: Response, file: Awaited<ReturnType<BannersService['image']>>) {
  if (!file) throw new ApiError(404, 'not_found', 'Gambar tidak ditemukan');
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (file.length) res.setHeader('Content-Length', String(file.length));
  file.stream.pipe(res);
}

/** Dasbor sponsor (web). Sponsor wajib Level 2 (PRD 3.3). */
@Controller('sponsor')
@UseGuards(LevelGuard)
@RequireLevel(2)
export class SponsorController {
  constructor(private readonly banners: BannersService) {}

  @Get('config')
  config() {
    return this.banners.config();
  }

  @Post('quote')
  @HttpCode(200)
  quote(@Body(new ZodPipe(QuoteBody)) b: z.infer<typeof QuoteBody>) {
    return { amount: this.banners.quote(b.slot, b.days, b.cities) };
  }

  @Get('banners')
  mine(@CurrentUser() u: AuthUser) {
    return this.banners.mine(u.id);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('banners')
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 1, fieldSize: 4 * 1024, parts: 2 } }))
  create(@CurrentUser() u: AuthUser, @Body() raw: unknown, @UploadedFile() file?: { buffer?: Buffer }) {
    if (!file?.buffer) throw new ApiError(400, 'file_required', 'Unggah gambar banner');
    let json: unknown;
    try {
      const data = (raw as { data?: unknown } | undefined)?.data;
      json = typeof data === 'string' ? JSON.parse(data) : data;
    } catch {
      throw new ApiError(400, 'invalid_input', 'Data banner tidak valid');
    }
    return this.banners.create(u.id, new ZodPipe(BannerBody).transform(json, { type: 'body' }), file.buffer);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('banners/:id/pay')
  @HttpCode(200)
  pay(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.banners.pay(u.id, id);
  }

  @Get('banners/:id/stats')
  stats(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.banners.stats(u.id, id);
  }

  @Delete('banners/:id')
  @HttpCode(204)
  async cancel(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.banners.cancel(u.id, id);
  }
}

/** Banner di aplikasi: ambil satu per slot, catat tayangan/klik, gambar. Level 1. */
@Controller('banners')
@UseGuards(LevelGuard)
@RequireLevel(1)
export class BannersController {
  constructor(private readonly banners: BannersService) {}

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post('pick')
  @HttpCode(200)
  pick(@CurrentUser() u: AuthUser, @Body(new ZodPipe(PickBody)) b: z.infer<typeof PickBody>) {
    return this.banners.pick(u.id, b);
  }

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post(':id/impression')
  @HttpCode(204)
  async impression(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.banners.impression(u.id, id);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post(':id/click')
  @HttpCode(200)
  click(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.banners.click(u.id, id);
  }

  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Get(':id/image')
  async image(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Res() res: Response) {
    sendImage(res, await this.banners.image(u.id, id));
  }
}

/** Antrean banner di panel super admin. Setiap keputusan tercatat di admin_audit_log. */
@Controller('admin/banners')
@UseGuards(AdminGuard)
export class AdminBannersController {
  constructor(private readonly banners: BannersService) {}

  @Get()
  list(@Query(new ZodPipe(AdminQuery)) q: z.infer<typeof AdminQuery>) {
    return this.banners.adminList(q.status);
  }

  @Get(':id/image')
  async image(@Param('id', uuid) id: string, @Res() res: Response) {
    sendImage(res, await this.banners.adminImage(id));
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.banners.approve(u.id, id);
  }

  @Post(':id/reject')
  @HttpCode(204)
  async reject(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(RejectBody)) b: z.infer<typeof RejectBody>) {
    await this.banners.reject(u.id, id, b.reason);
  }
}
