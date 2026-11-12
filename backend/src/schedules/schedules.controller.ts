import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { LevelGuard, RequireLevel } from '../auth/level.guard.js';
import { type AuthUser, CurrentUser, ZodPipe } from '../common/http.js';
import { SchedulesService, TIMEZONES } from './schedules.service.js';

const uuid = new ParseUUIDPipe();
const point = z.object({ lat: z.number().min(-11.5).max(6.5), lng: z.number().min(94).max(141.5) }).strict();
const fields = {
  title: z.string().trim().min(3, 'Judul minimal 3 karakter').max(80),
  locationName: z.string().trim().min(2, 'Tempat wajib diisi').max(120),
  // Titik kumpul di wilayah Indonesia (kotak kasar). Wajib untuk check-in GPS.
  point: point.nullable().optional(),
  distanceM: z.number().int().min(100).max(100_000).nullable().optional(),
  paceTargetSPerKm: z.number().int().min(150).max(1200).nullable().optional(),
  notes: z.string().trim().max(500).optional(),
  remind: z.boolean().optional(),
  timezone: z.enum(TIMEZONES).optional(),
};
const weekday = z.number().int().min(1).max(7);
const startTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Format jam HH:MM');
const ScheduleBody = z.object({ ...fields, weekday, startTime }).strict();
const SchedulePatch = z.object({ ...fields, weekday, startTime }).partial().strict();
const SessionBody = z.object({ ...fields, startsAt: z.coerce.date() }).strict();
const SessionsQuery = z.object({ scope: z.enum(['upcoming', 'past']).default('upcoming') });
const RsvpBody = z.object({ going: z.boolean() }).strict();
const QrBody = z.object({ token: z.string().min(10).max(200) }).strict();
// Posisi hanya untuk dibandingkan dengan titik kumpul; tidak disimpan dan tidak di-log.
const GpsBody = z
  .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(10_000), mocked: z.boolean().optional() })
  .strict();
const MarkBody = z.object({ present: z.boolean() }).strict();
const SummaryQuery = z.object({ days: z.coerce.number().int().min(7).max(365).default(90) });

/** Jadwal lari rutin + RSVP (modul 2.6). */
@Controller('communities/:id')
@UseGuards(LevelGuard)
@RequireLevel(1)
export class CommunitySchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get('schedules')
  list(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.schedules.schedules(u.id, id);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('schedules')
  create(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(ScheduleBody)) b: z.infer<typeof ScheduleBody>) {
    return this.schedules.createSchedule(u.id, id, b);
  }

  @Patch('schedules/:scheduleId')
  update(
    @CurrentUser() u: AuthUser,
    @Param('id', uuid) id: string,
    @Param('scheduleId', uuid) scheduleId: string,
    @Body(new ZodPipe(SchedulePatch)) b: z.infer<typeof SchedulePatch>,
  ) {
    return this.schedules.updateSchedule(u.id, id, scheduleId, b);
  }

  @Delete('schedules/:scheduleId')
  @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Param('scheduleId', uuid) scheduleId: string) {
    await this.schedules.deleteSchedule(u.id, id, scheduleId);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('sessions')
  sessions(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Query(new ZodPipe(SessionsQuery)) q: z.infer<typeof SessionsQuery>) {
    return this.schedules.sessions(u.id, id, q.scope);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('sessions')
  createSession(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(SessionBody)) b: z.infer<typeof SessionBody>) {
    return this.schedules.createSession(u.id, id, b);
  }

  @Get('attendance')
  summary(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Query(new ZodPipe(SummaryQuery)) q: z.infer<typeof SummaryQuery>) {
    return this.schedules.attendanceSummary(u.id, id, q.days);
  }
}

/** Sesi lari: detail, RSVP, absensi (modul 2.6). */
@Controller('sessions')
@UseGuards(LevelGuard)
@RequireLevel(1)
export class SessionsController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get(':id')
  detail(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.schedules.session(u.id, id);
  }

  @Post(':id/cancel')
  @HttpCode(204)
  async cancel(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.schedules.cancelSession(u.id, id);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':id/rsvp')
  @HttpCode(200)
  rsvp(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(RsvpBody)) b: z.infer<typeof RsvpBody>) {
    return this.schedules.rsvp(u.id, id, b.going);
  }

  @Delete(':id/rsvp')
  @HttpCode(204)
  async clearRsvp(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.schedules.clearRsvp(u.id, id);
  }

  /** Token QR berputar untuk ditampilkan admin. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':id/qr')
  qr(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.schedules.qr(u.id, id);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':id/check-in/qr')
  @HttpCode(200)
  checkInQr(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(QrBody)) b: z.infer<typeof QrBody>) {
    return this.schedules.checkInQr(u.id, id, b.token);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':id/check-in/gps')
  @HttpCode(200)
  checkInGps(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(GpsBody)) b: z.infer<typeof GpsBody>) {
    return this.schedules.checkInGps(u.id, id, b);
  }

  @Get(':id/attendance')
  attendance(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.schedules.attendance(u.id, id);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post(':id/attendance/:userId')
  @HttpCode(200)
  mark(
    @CurrentUser() u: AuthUser,
    @Param('id', uuid) id: string,
    @Param('userId', uuid) userId: string,
    @Body(new ZodPipe(MarkBody)) b: z.infer<typeof MarkBody>,
  ) {
    return this.schedules.markAttendance(u.id, id, userId, b.present);
  }
}
