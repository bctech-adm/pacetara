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
import type { Point } from './geo.js';
import { RunsService } from './runs.service.js';

const MAX_POINTS = 15_000;
const MAX_SEGMENTS = 100;
const uuid = new ParseUUIDPipe();

const point = z.tuple([
  z.number().min(-90).max(90),
  z.number().min(-180).max(180),
  z.number().min(0).max(86_400),
  z.number().min(-500).max(9000).nullable(),
]);
const visibility = z.enum(['public', 'community', 'private']);
const title = z.string().trim().min(1, 'Judul wajib diisi').max(80);
const notes = z.string().trim().max(2000);

const CreateBody = z
  .object({
    clientRunId: z.string().uuid(),
    title,
    notes: notes.default(''),
    visibility,
    startedAt: z.coerce.date(),
    endedAt: z.coerce.date(),
    segments: z.array(z.array(point)).max(MAX_SEGMENTS),
  })
  .refine((b) => b.endedAt >= b.startedAt, { message: 'Waktu selesai sebelum waktu mulai', path: ['endedAt'] })
  .refine((b) => b.endedAt.getTime() - b.startedAt.getTime() <= 24 * 3600 * 1000, { message: 'Lari maksimal 24 jam', path: ['endedAt'] })
  .refine((b) => b.endedAt.getTime() <= Date.now() + 10 * 60 * 1000, { message: 'Waktu lari di masa depan', path: ['endedAt'] })
  .refine((b) => b.segments.reduce((n, s) => n + s.length, 0) <= MAX_POINTS, { message: `Maksimal ${MAX_POINTS} titik`, path: ['segments'] });

const UpdateBody = z.object({ title, notes, visibility }).partial().strict();
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.coerce.date().optional(),
});
const PrivacyBody = z.object({ radiusM: z.number().int().min(100).max(1000) });

@Controller()
@UseGuards(LevelGuard)
@RequireLevel(1)
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('runs')
  async create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(CreateBody)) b: z.infer<typeof CreateBody>, @Res({ passthrough: true }) res: Response) {
    const result = await this.runs.create(u.id, { ...b, segments: b.segments as Point[][] });
    res.status(result.created ? 201 : 200);
    return result.run;
  }

  @Get('runs/mine')
  mine(@CurrentUser() u: AuthUser, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.runs.mine(u.id, q);
  }

  @Put('runs/privacy-zone')
  @HttpCode(204)
  async privacy(@CurrentUser() u: AuthUser, @Body(new ZodPipe(PrivacyBody)) b: z.infer<typeof PrivacyBody>) {
    await this.runs.setPrivacyRadius(u.id, b.radiusM);
  }

  @Get('users/:id/runs')
  ofUser(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.runs.ofUser(u.id, id, q);
  }

  @Get('runs/:id')
  detail(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.runs.detail(u.id, id);
  }

  @Patch('runs/:id')
  update(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(UpdateBody)) b: z.infer<typeof UpdateBody>) {
    return this.runs.update(u.id, id, b);
  }

  @Delete('runs/:id')
  @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.runs.remove(u.id, id);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('runs/:id/photos')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  addPhoto(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @UploadedFile() file?: { buffer?: Buffer }) {
    if (!file?.buffer) throw new ApiError(400, 'file_required', 'Pilih foto terlebih dahulu');
    return this.runs.addPhoto(u.id, id, file.buffer);
  }

  @Delete('runs/:id/photos/:photoId')
  removePhoto(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Param('photoId', uuid) photoId: string) {
    return this.runs.removePhoto(u.id, id, photoId);
  }

  @Get('runs/:id/photos/:photoId')
  async photo(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Param('photoId', uuid) photoId: string, @Res() res: Response) {
    const file = await this.runs.photoFile(u.id, id, photoId);
    if (!file) throw new ApiError(404, 'not_found', 'Foto tidak ditemukan');
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (file.length) res.setHeader('Content-Length', String(file.length));
    file.stream.pipe(res);
  }
}
