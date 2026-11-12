import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AdminGuard } from '../admin/admin-auth.service.js';
import { ApiError, type AuthUser, CurrentUser, ZodPipe } from '../common/http.js';
import { MAX_UPLOAD_BYTES } from '../storage/image.js';
import { KycService } from './kyc.service.js';

const uuid = new ParseUUIDPipe();
const SubmitData = z
  .object({
    nik: z.string().regex(/^\d{16}$/, 'NIK harus 16 digit angka'),
    name: z.string().trim().min(2, 'Nama sesuai KTP wajib diisi').max(80),
    consent: z.literal(true, { message: 'Persetujuan wajib dicentang' }),
    consentVersion: z.string().min(1).max(40),
  })
  .strict();
const AdminListQuery = z.object({ status: z.enum(['review', 'approved', 'rejected', 'retry', 'expired', 'revoked']).default('review') });
const ApproveBody = z.object({ note: z.string().trim().max(300).optional() }).strict().default({});
const ReasonBody = z.object({ reason: z.string().trim().min(3, 'Alasan minimal 3 karakter').max(300) }).strict();

type Uploaded = { buffer?: Buffer; size: number };

/**
 * Verifikasi Level 2 (modul 3.1). Unggahan multipart: `data` (JSON) + `ktp` + `selfie`, masing-masing ≤ 8 MB.
 * Multer memakai penyimpanan memori bawaan (tanpa `dest`/`storage`), jadi berkas tidak pernah menyentuh disk.
 */
@Controller('kyc')
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Get()
  status(@CurrentUser() u: AuthUser) {
    return this.kyc.status(u.id);
  }

  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post()
  @HttpCode(200)
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'ktp', maxCount: 1 },
        { name: 'selfie', maxCount: 1 },
      ],
      { limits: { fileSize: MAX_UPLOAD_BYTES, files: 2, fields: 1, fieldSize: 1024, parts: 3 } },
    ),
  )
  async submit(@CurrentUser() u: AuthUser, @Body('data') raw: unknown, @UploadedFiles() files?: { ktp?: Uploaded[]; selfie?: Uploaded[] }) {
    const ktp = files?.ktp?.[0]?.buffer;
    const selfie = files?.selfie?.[0]?.buffer;
    try {
      if (!ktp || !selfie) throw new ApiError(400, 'file_required', 'Foto KTP dan selfie wajib diunggah');
      let parsedJson: unknown;
      try {
        parsedJson = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        throw new ApiError(400, 'invalid_input', 'Data tidak valid');
      }
      const data = new ZodPipe(SubmitData).transform(parsedJson, { type: 'body' });
      return await this.kyc.submit(u.id, data, ktp, selfie);
    } finally {
      // Upaya terbaik menghapus isi foto dari memori secepatnya (service juga melakukannya).
      ktp?.fill(0);
      selfie?.fill(0);
    }
  }
}

/** Antrean tinjauan manual verifikasi KTP di panel super admin. Setiap tindakan tercatat di admin_audit_log. */
@Controller('admin/kyc')
@UseGuards(AdminGuard)
export class AdminKycController {
  constructor(private readonly kyc: KycService) {}

  @Get()
  list(@Query(new ZodPipe(AdminListQuery)) q: z.infer<typeof AdminListQuery>) {
    return this.kyc.adminList(q.status);
  }

  @Get(':id')
  detail(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.kyc.adminDetail(u.id, id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(ApproveBody)) b: z.infer<typeof ApproveBody>) {
    return this.kyc.approve(u.id, id, b.note);
  }

  @Post(':id/reject')
  @HttpCode(204)
  async reject(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(ReasonBody)) b: z.infer<typeof ReasonBody>) {
    await this.kyc.reject(u.id, id, b.reason);
  }

  @Post('users/:userId/revoke')
  @HttpCode(204)
  async revoke(@CurrentUser() u: AuthUser, @Param('userId', uuid) userId: string, @Body(new ZodPipe(ReasonBody)) b: z.infer<typeof ReasonBody>) {
    await this.kyc.revoke(u.id, userId, b.reason);
  }
}
