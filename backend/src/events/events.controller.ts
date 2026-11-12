import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AdminGuard } from '../admin/admin-auth.service.js';
import { LevelGuard, RequireLevel } from '../auth/level.guard.js';
import { type AuthUser, CurrentUser, ZodPipe } from '../common/http.js';
import { todayWib } from './event-archive.js';
import { EVENT_CATEGORIES, EventsService } from './events.service.js';

const uuid = new ParseUUIDPipe();

const ListQuery = z.object({
  city: z.string().trim().max(60).optional(),
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Format bulan YYYY-MM')
    .optional(),
  going: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tanggal YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Tanggal tidak valid');

/** Hanya https, tanpa kredensial di URL. */
export const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.protocol === 'https:' && !u.username && !u.password && u.hostname.includes('.');
    } catch {
      return false;
    }
  }, 'Tautan harus diawali https:// dan valid');

export const EventBody = z
  .object({
    name: z.string().trim().min(3, 'Nama minimal 3 karakter').max(120),
    date: isoDate,
    startTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Format jam HH:MM')
      .nullable()
      .default(null),
    city: z.string().trim().min(2, 'Kota wajib diisi').max(60),
    venue: z.string().trim().max(160).default(''),
    description: z.string().trim().max(2000).default(''),
    categories: z
      .array(z.enum(EVENT_CATEGORIES))
      .min(1, 'Pilih minimal satu kategori jarak')
      .max(EVENT_CATEGORIES.length)
      .transform((a) => [...new Set(a)]),
    registrationUrl: httpsUrl,
    /** Modul 2.4: sumber dan halaman resmi. Kosong = event manual tim PaceTara. */
    sourceName: z.string().trim().min(2).max(80).nullable().default(null),
    sourceUrl: httpsUrl.nullable().default(null),
  })
  .strict();
const CreateBody = EventBody.refine((b) => b.date >= todayWib(), { message: 'Tanggal sudah lewat', path: ['date'] });
const AdminListQuery = z.object({ scope: z.enum(['upcoming', 'past']).default('upcoming') });

/** Kalender event untuk pengguna aplikasi (Level 1). */
@Controller('events')
@UseGuards(LevelGuard)
@RequireLevel(1)
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  list(@CurrentUser() u: AuthUser, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.events.list(u.id, { city: q.city || undefined, month: q.month, going: q.going === 'true', limit: q.limit, cursor: q.cursor });
  }

  @Get('cities')
  cities() {
    return this.events.cities();
  }

  @Get(':id')
  detail(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.events.detail(u.id, id);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':id/going')
  @HttpCode(200)
  going(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.events.setGoing(u.id, id, true);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Delete(':id/going')
  notGoing(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.events.setGoing(u.id, id, false);
  }

  @Get(':id/participants')
  participants(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.events.participants(u.id, id);
  }
}

/** Input event manual oleh super admin (panel). Setiap perubahan tercatat di admin_audit_log. */
@Controller('admin/events')
@UseGuards(AdminGuard)
export class AdminEventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  list(@Query(new ZodPipe(AdminListQuery)) q: z.infer<typeof AdminListQuery>) {
    return this.events.adminList(q.scope);
  }

  @Post()
  @HttpCode(201)
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(CreateBody)) b: z.infer<typeof EventBody>) {
    return this.events.create(u.id, b);
  }

  @Put(':id')
  @HttpCode(204)
  async update(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(EventBody)) b: z.infer<typeof EventBody>) {
    await this.events.update(u.id, id, b);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.events.remove(u.id, id);
  }
}
