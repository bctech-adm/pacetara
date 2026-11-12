import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { LevelGuard, RequireLevel } from '../auth/level.guard.js';
import { type AuthUser, CurrentUser, ZodPipe } from '../common/http.js';
import { BUDDY_MAX_DISTANCE_KM, BUDDY_SLOTS, BuddiesService } from './buddies.service.js';

const uuid = new ParseUUIDPipe();
const pace = z.number().int().min(180).max(1200);
// Area dipilih pengguna di peta (bukan GPS/rute); dibulatkan server ke grid ±2 km. Dikirim di body, bukan URL.
const ProfileBody = z
  .object({
    paceSPerKm: pace,
    city: z.string().trim().min(2, 'Kota wajib diisi').max(60),
    area: z.object({ lat: z.number().min(-11.5).max(6.5), lng: z.number().min(94).max(141.5) }).strict().nullable().optional(),
    slots: z.array(z.enum(BUDDY_SLOTS)).max(BUDDY_SLOTS.length).default([]),
    enabled: z.boolean().optional(),
    consent: z.boolean().optional(),
  })
  .strict();
const SearchBody = z
  .object({
    city: z.string().trim().min(2).max(60).optional(),
    paceMinSPerKm: pace.optional(),
    paceMaxSPerKm: pace.optional(),
    maxDistanceKm: z.number().min(1).max(BUDDY_MAX_DISTANCE_KM).optional(),
    slots: z.array(z.enum(BUDDY_SLOTS)).max(BUDDY_SLOTS.length).optional(),
  })
  .strict();
const RequestBody = z.object({ userId: z.string().uuid() }).strict();

/** Cari teman lari (modul 2.6). */
@Controller('buddies')
@UseGuards(LevelGuard)
@RequireLevel(1)
export class BuddiesController {
  constructor(private readonly buddies: BuddiesService) {}

  @Get('profile')
  profile(@CurrentUser() u: AuthUser) {
    return this.buddies.profile(u.id);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Put('profile')
  save(@CurrentUser() u: AuthUser, @Body(new ZodPipe(ProfileBody)) b: z.infer<typeof ProfileBody>) {
    const { consent, ...input } = b;
    return this.buddies.saveProfile(u.id, input, consent === true);
  }

  @Delete('profile')
  @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser) {
    await this.buddies.deleteProfile(u.id);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('search')
  @HttpCode(200)
  search(@CurrentUser() u: AuthUser, @Body(new ZodPipe(SearchBody)) b: z.infer<typeof SearchBody>) {
    return this.buddies.search(u.id, b);
  }

  @Get('requests')
  requests(@CurrentUser() u: AuthUser) {
    return this.buddies.requests(u.id);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('requests')
  @HttpCode(200)
  send(@CurrentUser() u: AuthUser, @Body(new ZodPipe(RequestBody)) b: z.infer<typeof RequestBody>) {
    return this.buddies.sendRequest(u.id, b.userId);
  }

  @Post('requests/:id/accept')
  @HttpCode(200)
  accept(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.buddies.respond(u.id, id, true);
  }

  @Post('requests/:id/decline')
  @HttpCode(200)
  decline(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.buddies.respond(u.id, id, false);
  }

  @Delete('connections/:userId')
  @HttpCode(204)
  async disconnect(@CurrentUser() u: AuthUser, @Param('userId', uuid) userId: string) {
    await this.buddies.removeConnection(u.id, userId);
  }
}
