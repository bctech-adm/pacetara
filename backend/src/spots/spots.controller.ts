import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AdminGuard } from '../admin/admin-auth.service.js';
import { LevelGuard, RequireLevel } from '../auth/level.guard.js';
import { type AuthUser, CurrentUser, ZodPipe } from '../common/http.js';
import { SpotsService } from './spots.service.js';

const uuid = new ParseUUIDPipe();
const lat = z.number().min(-11.5).max(6.5);
const lng = z.number().min(94).max(141.5);
const fields = {
  name: z.string().trim().min(3, 'Nama minimal 3 karakter').max(80),
  city: z.string().trim().min(2, 'Kota wajib diisi').max(60),
  point: z.object({ lat, lng }).strict(),
  lighting: z.union([z.literal(0), z.literal(1), z.literal(2)]).nullable().optional(),
  toilet: z.boolean().nullable().optional(),
  parking: z.boolean().nullable().optional(),
  notes: z.string().trim().max(300).optional(),
};
const SpotBody = z.object(fields).strict();
const ApproveBody = z.object(fields).partial().strict().default({});
const RejectBody = z.object({ reason: z.string().trim().min(3, 'Alasan minimal 3 karakter').max(300) }).strict();
// Area peta di body (POST), bukan query string: area yang dilihat bisa menunjukkan lokasi pengguna.
const QueryBody = z.union([
  z.object({ bbox: z.object({ minLat: lat, minLng: lng, maxLat: lat, maxLng: lng }).strict() }).strict(),
  z.object({ near: z.object({ lat, lng }).strict(), radiusKm: z.number().min(0.5).max(25).default(5) }).strict(),
]);
const AdminListQuery = z.object({ status: z.enum(['pending', 'approved', 'rejected']).default('pending') });

/** Peta spot lari lokal (modul 2.6). */
@Controller('spots')
@UseGuards(LevelGuard)
@RequireLevel(1)
export class SpotsController {
  constructor(private readonly spots: SpotsService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('query')
  @HttpCode(200)
  query(@Body(new ZodPipe(QueryBody)) b: z.infer<typeof QueryBody>) {
    return 'bbox' in b ? this.spots.inBox(b.bbox) : this.spots.near(b.near, b.radiusKm);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post()
  @HttpCode(201)
  submit(@CurrentUser() u: AuthUser, @Body(new ZodPipe(SpotBody)) b: z.infer<typeof SpotBody>) {
    return this.spots.submit(u.id, b);
  }

  @Get('mine')
  mine(@CurrentUser() u: AuthUser) {
    return this.spots.mine(u.id);
  }

  @Get(':id')
  detail(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.spots.detail(u.id, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async withdraw(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.spots.withdraw(u.id, id);
  }
}

/** Antrean spot di panel super admin. Setiap keputusan tercatat di admin_audit_log. */
@Controller('admin/spots')
@UseGuards(AdminGuard)
export class AdminSpotsController {
  constructor(private readonly spots: SpotsService) {}

  @Get()
  list(@Query(new ZodPipe(AdminListQuery)) q: z.infer<typeof AdminListQuery>) {
    return this.spots.adminList(q.status);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(ApproveBody)) b: z.infer<typeof ApproveBody>) {
    return this.spots.approve(u.id, id, b);
  }

  @Post(':id/reject')
  @HttpCode(204)
  async reject(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(RejectBody)) b: z.infer<typeof RejectBody>) {
    await this.spots.reject(u.id, id, b.reason);
  }
}
