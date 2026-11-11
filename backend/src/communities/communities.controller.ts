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
import { CommunitiesService } from './communities.service.js';

const name = z.string().trim().min(3, 'Nama minimal 3 karakter').max(60, 'Nama maksimal 60 karakter');
const city = z.string().trim().min(2, 'Kota wajib diisi').max(60);
const description = z.string().trim().max(1000, 'Deskripsi maksimal 1000 karakter');
const visibility = z.enum(['open', 'private']);
const uuid = new ParseUUIDPipe();
/** Pilihan admin: anggota baru melihat riwayat chat lama atau tidak (bawaan: pengaturan komunitas). */
const ApproveBody = z.object({ seeHistory: z.boolean().optional() }).strict().optional();

const CreateBody = z.object({ name, city, description: description.default(''), visibility });
const UpdateBody = z
  .object({ name, city, description, visibility, newMembersSeeHistory: z.boolean() })
  .partial()
  .strict();
const DirectoryQuery = z.object({
  city: z.string().trim().max(60).optional(),
  q: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(100).optional(),
});
const MembersQuery = z.object({ status: z.enum(['active', 'pending', 'banned']).default('active') });
const InviteBody = z.object({
  expiresInDays: z.number().int().min(1).max(30).default(7),
  maxUses: z.number().int().min(1).max(1000).optional(),
});
const CodeBody = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z2-9]{8}$/, 'Kode berisi 8 huruf/angka') });
const RemoveBody = z.object({ ban: z.boolean().default(false) });
const RoleBody = z.object({ role: z.enum(['admin', 'member']) });
const TransferBody = z.object({ userId: z.string().uuid() });

@Controller('communities')
@UseGuards(LevelGuard)
@RequireLevel(1)
export class CommunitiesController {
  constructor(private readonly communities: CommunitiesService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  directory(@CurrentUser() u: AuthUser, @Query(new ZodPipe(DirectoryQuery)) q: z.infer<typeof DirectoryQuery>) {
    return this.communities.directory(u.id, { city: q.city, search: q.q, limit: q.limit, cursor: q.cursor });
  }

  @Get('cities')
  cities() {
    return this.communities.cities();
  }

  @Get('mine')
  mine(@CurrentUser() u: AuthUser) {
    return this.communities.mine(u.id);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(CreateBody)) b: z.infer<typeof CreateBody>) {
    return this.communities.create(u.id, b);
  }

  // Kode undangan dibatasi ketat agar tidak bisa ditebak dengan mencoba-coba.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('invites/preview')
  @HttpCode(200)
  previewInvite(@CurrentUser() u: AuthUser, @Body(new ZodPipe(CodeBody)) b: z.infer<typeof CodeBody>) {
    return this.communities.previewInvite(u.id, b.code);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('join-by-code')
  @HttpCode(200)
  joinByCode(@CurrentUser() u: AuthUser, @Body(new ZodPipe(CodeBody)) b: z.infer<typeof CodeBody>) {
    return this.communities.joinByCode(u.id, b.code);
  }

  @Get(':id')
  detail(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.communities.detail(u.id, id);
  }

  @Patch(':id')
  update(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(UpdateBody)) b: z.infer<typeof UpdateBody>) {
    return this.communities.update(u.id, id, b);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.communities.remove(u.id, id);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':id/logo')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2, fieldSize: 1024, parts: 3 } }))
  logo(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @UploadedFile() file?: { buffer?: Buffer }) {
    if (!file?.buffer) throw new ApiError(400, 'file_required', 'Pilih gambar terlebih dahulu');
    return this.communities.setLogo(u.id, id, file.buffer);
  }

  @Get(':id/logo')
  async logoFile(@Param('id', uuid) id: string, @Res() res: Response) {
    const file = await this.communities.logoFile(id);
    if (!file) throw new ApiError(404, 'not_found', 'Logo tidak ditemukan');
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (file.length) res.setHeader('Content-Length', String(file.length));
    file.stream.pipe(res);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':id/join')
  @HttpCode(200)
  join(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.communities.join(u.id, id);
  }

  @Delete(':id/join')
  @HttpCode(204)
  async cancelRequest(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.communities.cancelRequest(u.id, id);
  }

  /** Pengguna yang bisa diundang langsung: dikenal admin (satu komunitas lain / pernah chat pribadi). */
  @Get(':id/invite-candidates')
  inviteCandidates(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.communities.inviteCandidates(u.id, id);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':id/invitations')
  @HttpCode(201)
  invite(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(TransferBody)) b: z.infer<typeof TransferBody>) {
    return this.communities.inviteUser(u.id, id, b.userId);
  }

  @Post(':id/leave')
  @HttpCode(204)
  async leave(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.communities.leave(u.id, id);
  }

  @Get(':id/members')
  members(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Query(new ZodPipe(MembersQuery)) q: z.infer<typeof MembersQuery>) {
    return this.communities.members(u.id, id, q.status);
  }

  @Post(':id/members/:userId/approve')
  @HttpCode(204)
  async approve(
    @CurrentUser() u: AuthUser,
    @Param('id', uuid) id: string,
    @Param('userId', uuid) target: string,
    @Body(new ZodPipe(ApproveBody)) b: z.infer<typeof ApproveBody>,
  ) {
    await this.communities.approve(u.id, id, target, b?.seeHistory);
  }

  @Post(':id/members/:userId/reject')
  @HttpCode(204)
  async reject(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Param('userId', uuid) target: string) {
    await this.communities.reject(u.id, id, target);
  }

  @Post(':id/members/:userId/remove')
  @HttpCode(204)
  async removeMember(
    @CurrentUser() u: AuthUser,
    @Param('id', uuid) id: string,
    @Param('userId', uuid) target: string,
    @Body(new ZodPipe(RemoveBody)) b: z.infer<typeof RemoveBody>,
  ) {
    await this.communities.removeMember(u.id, id, target, b.ban);
  }

  @Post(':id/members/:userId/unban')
  @HttpCode(204)
  async unban(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Param('userId', uuid) target: string) {
    await this.communities.unban(u.id, id, target);
  }

  @Post(':id/members/:userId/role')
  @HttpCode(204)
  async setRole(
    @CurrentUser() u: AuthUser,
    @Param('id', uuid) id: string,
    @Param('userId', uuid) target: string,
    @Body(new ZodPipe(RoleBody)) b: z.infer<typeof RoleBody>,
  ) {
    await this.communities.setRole(u.id, id, target, b.role);
  }

  @Post(':id/transfer')
  @HttpCode(204)
  async transfer(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(TransferBody)) b: z.infer<typeof TransferBody>) {
    await this.communities.transferOwnership(u.id, id, b.userId);
  }

  @Post(':id/invites')
  createInvite(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(InviteBody)) b: z.infer<typeof InviteBody>) {
    return this.communities.createInvite(u.id, id, b);
  }

  @Get(':id/invites')
  listInvites(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.communities.listInvites(u.id, id);
  }

  @Delete(':id/invites/:inviteId')
  @HttpCode(204)
  async revokeInvite(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Param('inviteId', uuid) inviteId: string) {
    await this.communities.revokeInvite(u.id, id, inviteId);
  }
}

/** Undangan komunitas yang saya terima (modul 1.9). */
@Controller('invitations')
@UseGuards(LevelGuard)
@RequireLevel(1)
export class InvitationsController {
  constructor(private readonly communities: CommunitiesService) {}

  @Get()
  mine(@CurrentUser() u: AuthUser) {
    return this.communities.myInvitations(u.id);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':id/accept')
  @HttpCode(200)
  accept(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.communities.respondInvitation(u.id, id, true);
  }

  @Post(':id/decline')
  @HttpCode(204)
  async decline(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.communities.respondInvitation(u.id, id, false);
  }
}
