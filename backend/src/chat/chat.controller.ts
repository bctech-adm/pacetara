import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
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
import { ChatService } from './chat.service.js';

const uuid = new ParseUUIDPipe();
const seq = z.string().regex(/^\d{1,18}$/);

const MessagesQuery = z
  .object({ before: seq.optional(), after: seq.optional(), limit: z.coerce.number().int().min(1).max(100).default(30) })
  .refine((q) => !(q.before && q.after), { message: 'Pilih before atau after', path: ['before'] });

const SendBody = z.discriminatedUnion('kind', [
  z.object({ clientMsgId: z.string().uuid(), kind: z.literal('text'), text: z.string().trim().min(1, 'Pesan kosong').max(2000) }).strict(),
  z
    .object({
      clientMsgId: z.string().uuid(),
      kind: z.literal('run_invite'),
      invite: z
        .object({
          title: z.string().trim().min(1, 'Judul wajib diisi').max(80),
          startsAt: z.coerce
            .date()
            .refine((d) => d.getTime() > Date.now() - 3600_000, 'Waktu sudah lewat')
            .refine((d) => d.getTime() < Date.now() + 90 * 86_400_000, 'Maksimal 90 hari ke depan')
            .transform((d) => d.toISOString()),
          place: z.string().trim().min(1, 'Tempat wajib diisi').max(120),
          note: z.string().trim().max(500).default(''),
        })
        .strict(),
    })
    .strict(),
]);

const DirectBody = z.object({ userId: z.string().uuid() }).strict();
const ReadBody = z.object({ seq }).strict();
const ImageFields = z.object({ clientMsgId: z.string().uuid() });

@Controller('chat')
@UseGuards(LevelGuard)
@RequireLevel(1)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('conversations')
  conversations(@CurrentUser() u: AuthUser) {
    return this.chat.conversations(u.id);
  }

  @Get('conversations/:id')
  conversation(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.chat.conversation(u.id, id);
  }

  @Post('direct')
  @HttpCode(200)
  direct(@CurrentUser() u: AuthUser, @Body(new ZodPipe(DirectBody)) b: z.infer<typeof DirectBody>) {
    return this.chat.direct(u.id, b.userId);
  }

  @Get('communities/:id')
  community(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.chat.communityConversation(u.id, id);
  }

  @Get('conversations/:id/messages')
  messages(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Query(new ZodPipe(MessagesQuery)) q: z.infer<typeof MessagesQuery>) {
    return this.chat.messages(u.id, id, q);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('conversations/:id/messages')
  send(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(SendBody)) b: z.infer<typeof SendBody>) {
    return this.chat.send(u.id, id, b);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('conversations/:id/images')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2 } }))
  sendImage(
    @CurrentUser() u: AuthUser,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(ImageFields)) b: z.infer<typeof ImageFields>,
    @UploadedFile() file?: { buffer?: Buffer },
  ) {
    if (!file?.buffer) throw new ApiError(400, 'file_required', 'Pilih gambar terlebih dahulu');
    return this.chat.sendImage(u.id, id, b.clientMsgId, file.buffer);
  }

  @Post('conversations/:id/read')
  @HttpCode(204)
  async read(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(ReadBody)) b: z.infer<typeof ReadBody>) {
    await this.chat.markRead(u.id, id, b.seq);
  }

  @Get('messages/:id')
  message(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.chat.message(u.id, id);
  }

  @Delete('messages/:id')
  @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.chat.remove(u.id, id);
  }

  @Post('messages/:id/rsvp')
  @HttpCode(200)
  going(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.chat.rsvp(u.id, id, true);
  }

  @Delete('messages/:id/rsvp')
  notGoing(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.chat.rsvp(u.id, id, false);
  }

  @Get('messages/:id/image')
  async image(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Res() res: Response) {
    const file = await this.chat.imageFile(u.id, id);
    if (!file) throw new ApiError(404, 'image_not_found', 'Gambar tidak ditemukan');
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (file.length) res.setHeader('Content-Length', String(file.length));
    file.stream.pipe(res);
  }
}
