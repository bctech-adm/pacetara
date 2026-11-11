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
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { LevelGuard, RequireLevel } from '../auth/level.guard.js';
import { ApiError, type AuthUser, CurrentUser, ZodPipe } from '../common/http.js';
import { MAX_UPLOAD_BYTES } from '../storage/image.js';
import { FeedService, MAX_POST_PHOTOS } from './feed.service.js';

const uuid = new ParseUUIDPipe();

const PostBody = z
  .object({
    text: z.string().trim().max(2000, 'Maksimal 2000 karakter').optional(),
    visibility: z.enum(['public', 'community', 'followers']),
    runId: z.string().uuid().optional(),
  })
  .strict();
const CommentBody = z.object({ text: z.string().trim().min(1, 'Komentar kosong').max(1000, 'Maksimal 1000 karakter') }).strict();
const ListQuery = z.object({ tab: z.enum(['following', 'community', 'explore']).default('following'), cursor: z.string().max(200).optional() }).strict();
const CursorQuery = z.object({ cursor: z.string().max(200).optional() }).strict();

/**
 * Body postingan: JSON biasa (teks/hasil lari), atau multipart dengan field `data` (JSON) dan
 * sampai 4 berkas `photos`. Teks di body, tidak pernah di URL.
 */
function parsePostBody(raw: unknown): z.infer<typeof PostBody> {
  let value = raw;
  if (raw && typeof raw === 'object' && typeof (raw as { data?: unknown }).data === 'string') {
    try {
      value = JSON.parse((raw as { data: string }).data);
    } catch {
      throw new ApiError(400, 'invalid_input', 'Data postingan tidak valid');
    }
  }
  return new ZodPipe(PostBody).transform(value, { type: 'body' });
}

@Controller('feed')
@UseGuards(LevelGuard)
@RequireLevel(1)
export class FeedController {
  constructor(private readonly feed: FeedService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  list(@CurrentUser() u: AuthUser, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.feed.list(u.id, q);
  }

  // Unggah foto: maks. 10 postingan/menit (dan POSTS_PER_DAY per hari di service), tiap foto maks. 8 MB.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('posts')
  @HttpCode(201)
  @UseInterceptors(
    FilesInterceptor('photos', MAX_POST_PHOTOS, {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_POST_PHOTOS, fields: 1, fieldSize: 16 * 1024, parts: MAX_POST_PHOTOS + 1 },
    }),
  )
  create(@CurrentUser() u: AuthUser, @Body() raw: unknown, @UploadedFiles() files?: { buffer?: Buffer }[]) {
    const b = parsePostBody(raw);
    const buffers = (files ?? []).map((f) => f.buffer).filter((x): x is Buffer => Boolean(x));
    return this.feed.create(u.id, b, buffers);
  }

  @Get('posts/:id')
  get(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.feed.get(u.id, id);
  }

  @Delete('posts/:id')
  @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.feed.remove(u.id, id);
  }

  // Satu layar feed bisa memuat banyak foto; batas lebih longgar dari batas global.
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Get('posts/:id/photos/:photoId')
  async photo(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Param('photoId', uuid) photoId: string, @Res() res: Response) {
    const file = await this.feed.photoFile(u.id, id, photoId);
    if (!file) throw new ApiError(404, 'not_found', 'Foto tidak ditemukan');
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (file.length) res.setHeader('Content-Length', String(file.length));
    file.stream.pipe(res);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('posts/:id/like')
  @HttpCode(200)
  like(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.feed.like(u.id, id);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Delete('posts/:id/like')
  unlike(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.feed.unlike(u.id, id);
  }

  @Get('posts/:id/comments')
  comments(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Query(new ZodPipe(CursorQuery)) q: z.infer<typeof CursorQuery>) {
    return this.feed.comments(u.id, id, q.cursor);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('posts/:id/comments')
  @HttpCode(201)
  addComment(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(CommentBody)) b: z.infer<typeof CommentBody>) {
    return this.feed.addComment(u.id, id, b.text);
  }

  @Delete('comments/:id')
  @HttpCode(204)
  async deleteComment(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.feed.deleteComment(u.id, id);
  }

  @Get('users/:id')
  profile(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.feed.profile(u.id, id);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('users/:id/posts')
  userPosts(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Query(new ZodPipe(CursorQuery)) q: z.infer<typeof CursorQuery>) {
    return this.feed.ofUser(u.id, id, q.cursor);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('users/:id/follow')
  @HttpCode(200)
  follow(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.feed.follow(u.id, id);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Delete('users/:id/follow')
  @HttpCode(204)
  async unfollow(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.feed.unfollow(u.id, id);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('users/:id/block')
  @HttpCode(204)
  async block(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.feed.block(u.id, id);
  }

  @Delete('users/:id/block')
  @HttpCode(204)
  async unblock(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.feed.unblock(u.id, id);
  }

  @Get('me/followers')
  followers(@CurrentUser() u: AuthUser) {
    return this.feed.myConnections(u.id, 'followers');
  }

  @Get('me/following')
  following(@CurrentUser() u: AuthUser) {
    return this.feed.myConnections(u.id, 'following');
  }

  @Delete('me/followers/:id')
  @HttpCode(204)
  async removeFollower(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.feed.removeFollower(u.id, id);
  }

  @Get('me/blocks')
  blocks(@CurrentUser() u: AuthUser) {
    return this.feed.blocks(u.id);
  }
}
