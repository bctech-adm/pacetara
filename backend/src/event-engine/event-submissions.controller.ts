import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AdminGuard } from '../admin/admin-auth.service.js';
import { LevelGuard, RequireLevel } from '../auth/level.guard.js';
import { type AuthUser, CurrentUser, ZodPipe } from '../common/http.js';
import { todayWib } from '../events/event-archive.js';
import { EventBody, httpsUrl, isoDate } from '../events/events.controller.js';
import { EVENT_CATEGORIES } from '../events/events.service.js';
import { EventScraper } from './event-scraper.js';
import { EventSubmissionsService } from './event-submissions.service.js';

const uuid = new ParseUUIDPipe();

/** Email atau nomor HP (format bebas yang wajar). Tidak divalidasi lebih jauh; hanya untuk dihubungi admin. */
const contact = z
  .string()
  .trim()
  .max(120)
  .refine((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || /^\+?[\d\s().-]{8,20}$/.test(s), 'Isi email atau nomor HP yang valid');

const SubmitBody = z
  .object({
    name: z.string().trim().min(3, 'Nama minimal 3 karakter').max(120),
    date: isoDate.refine((d) => d >= todayWib(), 'Tanggal sudah lewat'),
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
    officialUrl: httpsUrl.nullable().default(null),
    organizer: z.string().trim().min(2, 'Nama penyelenggara wajib diisi').max(80),
    contact: z
      .union([z.literal(''), contact])
      .nullable()
      .default(null)
      .transform((v) => v || null),
  })
  .strict();

const AdminListQuery = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'merged']).default('pending') });
/**
 * Koreksi admin sebelum menyetujui; field yang tidak dikirim memakai data kiriman. Hasil paduannya divalidasi
 * penuh dengan skema event (strict), jadi field asing tetap ditolak.
 */
const ApproveBody = z.record(z.string(), z.unknown()).default({});
const ApproveFinal = EventBody.refine((b) => b.date >= todayWib(), { message: 'Tanggal sudah lewat', path: ['date'] });
const RejectBody = z.object({ reason: z.string().trim().min(3, 'Alasan minimal 3 karakter').max(300) }).strict();
const MergeBody = z.object({ eventId: z.string().uuid() }).strict();

/**
 * Kirim event oleh pengguna aplikasi (Level 1) — jalur utama penyelenggara (KEPUTUSAN #179). Tidak ada
 * formulir web publik tanpa login. Kiriman masuk antrean dan tidak terlihat di /v1/events sebelum disetujui.
 */
@Controller('event-submissions')
@UseGuards(LevelGuard)
@RequireLevel(1)
export class EventSubmissionsController {
  constructor(private readonly subs: EventSubmissionsService) {}

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post()
  @HttpCode(201)
  submit(@CurrentUser() u: AuthUser, @Body(new ZodPipe(SubmitBody)) b: z.infer<typeof SubmitBody>) {
    return this.subs.submit(u.id, b);
  }

  @Get()
  mine(@CurrentUser() u: AuthUser) {
    return this.subs.mine(u.id);
  }
}

/** Antrean event di panel super admin. Setiap tindakan tercatat di admin_audit_log. */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminEventQueueController {
  constructor(
    private readonly subs: EventSubmissionsService,
    private readonly scraper: EventScraper,
  ) {}

  @Get('event-submissions')
  list(@Query(new ZodPipe(AdminListQuery)) q: z.infer<typeof AdminListQuery>) {
    return this.subs.adminList(q.status);
  }

  @Get('event-submissions/:id/contact')
  contact(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.subs.contact(u.id, id);
  }

  @Post('event-submissions/:id/approve')
  @HttpCode(200)
  async approve(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(ApproveBody)) b: z.infer<typeof ApproveBody>) {
    const base = await this.subs.pendingInput(id);
    const merged = new ZodPipe(ApproveFinal).transform({ ...base, ...stripUndefined(b) }, { type: 'body' }) as z.infer<typeof EventBody>;
    return this.subs.approve(u.id, id, merged);
  }

  @Post('event-submissions/:id/reject')
  @HttpCode(204)
  async reject(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(RejectBody)) b: z.infer<typeof RejectBody>) {
    await this.subs.reject(u.id, id, b.reason);
  }

  @Post('event-submissions/:id/merge')
  @HttpCode(204)
  async merge(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(MergeBody)) b: z.infer<typeof MergeBody>) {
    await this.subs.merge(u.id, id, b.eventId);
  }

  /** Sumber scraping yang dikonfigurasi (env) dan hasil putaran terakhir. */
  @Get('event-sources')
  sources() {
    return this.scraper.status();
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
