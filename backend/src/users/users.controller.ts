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
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { ApiError, type AuthUser, CurrentUser, ZodPipe } from '../common/http.js';
import { MAX_UPLOAD_BYTES } from '../storage/image.js';
import { UsersService } from './users.service.js';

const ProfilePatch = z
  .object({
    displayName: z.string().trim().min(1, 'Nama wajib diisi').max(60),
    city: z.string().trim().max(60).nullable(),
    // 2:00–30:00 menit per km
    avgPaceSecPerKm: z.number().int().min(120).max(1800).nullable(),
  })
  .partial()
  .strict();

const DeleteBody = z.object({ password: z.string().max(128).optional(), confirm: z.literal('HAPUS') });

@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  me(@CurrentUser() u: AuthUser) {
    return this.users.me(u.id);
  }

  @Patch('me')
  update(@CurrentUser() u: AuthUser, @Body(new ZodPipe(ProfilePatch)) b: z.infer<typeof ProfilePatch>) {
    return this.users.updateProfile(u.id, b);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('me/avatar')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  avatar(@CurrentUser() u: AuthUser, @UploadedFile() file?: { buffer?: Buffer; size: number }) {
    if (!file?.buffer) throw new ApiError(400, 'file_required', 'Pilih gambar terlebih dahulu');
    return this.users.setAvatar(u.id, file.buffer);
  }

  @Delete('me/avatar')
  removeAvatar(@CurrentUser() u: AuthUser) {
    return this.users.removeAvatar(u.id);
  }

  /** Hapus akun beserta data pribadi. Wajib mengetik "HAPUS"; akun berkata sandi wajib memasukkan kata sandi. */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('me/delete')
  @HttpCode(204)
  async deleteAccount(@CurrentUser() u: AuthUser, @Body(new ZodPipe(DeleteBody)) b: z.infer<typeof DeleteBody>) {
    await this.users.deleteAccount(u.id, { password: b.password });
  }

  @Get('users/:id')
  publicProfile(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.users.publicProfile(id);
  }

  @Get('users/:id/avatar')
  async avatarFile(@Param('id', new ParseUUIDPipe()) id: string, @Res() res: Response) {
    const file = await this.users.avatarFile(id);
    if (!file) throw new ApiError(404, 'not_found', 'Foto tidak ditemukan');
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (file.length) res.setHeader('Content-Length', String(file.length));
    file.stream.pipe(res);
  }
}
