import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { LevelGuard, RequireLevel } from '../auth/level.guard.js';
import { type AuthUser, CurrentUser, ZodPipe } from '../common/http.js';
import { normalizePhoneId } from '../crypto/field-crypto.js';
import { SafetyService } from './safety.service.js';

const uuid = new ParseUUIDPipe();
const ContactBody = z
  .object({
    name: z.string().trim().min(1, 'Nama wajib diisi').max(60),
    phone: z
      .string()
      .trim()
      .transform((v, ctx) => {
        try {
          return normalizePhoneId(v);
        } catch {
          ctx.addIssue({ code: 'custom', message: 'Nomor HP Indonesia tidak valid' });
          return z.NEVER;
        }
      }),
  })
  .strict();
const SosBody = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracyM: z.number().min(0).max(100_000).optional(),
  })
  .strict();

/** Mode aman: gratis untuk semua pengguna Level 1 (REVIEW-PRD A1). Lokasi dikirim di body, bukan URL. */
@Controller()
@UseGuards(LevelGuard)
@RequireLevel(1)
export class SafetyController {
  constructor(private readonly safety: SafetyService) {}

  @Get('me/emergency-contacts')
  contacts(@CurrentUser() u: AuthUser) {
    return this.safety.contacts(u.id);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('me/emergency-contacts')
  @HttpCode(201)
  add(@CurrentUser() u: AuthUser, @Body(new ZodPipe(ContactBody)) b: z.infer<typeof ContactBody>) {
    return this.safety.addContact(u.id, b.name, b.phone);
  }

  @Delete('me/emergency-contacts/:id')
  @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.safety.removeContact(u.id, id);
  }

  // Penahan kasar; batas utama (3/10 menit, 10/hari) di SafetyService, yang tetap mengembalikan kontak untuk SMS.
  @Throttle({ default: { limit: 10, ttl: 600_000 } })
  @Post('sos')
  @HttpCode(200)
  sos(@CurrentUser() u: AuthUser, @Body(new ZodPipe(SosBody)) b: z.infer<typeof SosBody>) {
    return this.safety.trigger(u.id, b);
  }
}
