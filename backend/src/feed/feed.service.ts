import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { type Queryable, withTx } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { PG_POOL, REDIS } from '../core.module.js';
import { FieldCrypto } from '../crypto/field-crypto.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { RunsService } from '../runs/runs.service.js';
import { processImage } from '../storage/image.js';
import { StorageService } from '../storage/storage.service.js';
import { avatarPath } from '../users/users.repository.js';

export type PostVisibility = 'public' | 'community' | 'followers';
export type FeedTab = 'following' | 'community' | 'explore';

export const MAX_POST_PHOTOS = 4;
/** Batas postingan per pengguna per 24 jam (di samping batas laju per menit di controller). */
export const POSTS_PER_DAY = 30;
const PAGE = 20;
const COMMENT_PAGE = 30;

export const postBodyAad = (id: string) => `feed_posts.body:${id}`;
export const commentBodyAad = (id: string) => `feed_comments.body:${id}`;

/** Penonton ($1) dan pengguna di kolom [col] sama-sama anggota aktif satu komunitas yang tidak diturunkan. */
const sharesCommunity = (col: string) => `EXISTS (
  SELECT 1 FROM community_members x JOIN community_members y ON y.community_id = x.community_id
    JOIN communities cm ON cm.id = x.community_id AND cm.removed_at IS NULL
   WHERE x.user_id = $1 AND y.user_id = ${col} AND x.status = 'active' AND y.status = 'active')`;

/** Tidak ada blokir feed di antara penonton ($1) dan pengguna di kolom [col], ke arah mana pun. */
const notBlocked = (col: string) => `NOT EXISTS (
  SELECT 1 FROM feed_blocks bl
   WHERE (bl.blocker_id = $1 AND bl.blocked_id = ${col}) OR (bl.blocker_id = ${col} AND bl.blocked_id = $1))`;

/**
 * Aturan siapa boleh melihat postingan p (penulis a), penonton = $1. Satu-satunya tempat aturan ini,
 * dipakai semua tab, detail, komentar, suka, foto, dan laporan. Yang tidak berhak mendapat 404.
 */
const VISIBLE = `p.removed_at IS NULL AND a.status = 'active'
  AND (p.hidden_at IS NULL OR p.user_id = $1)
  AND ${notBlocked('p.user_id')}
  AND (
    p.user_id = $1
    OR p.visibility = 'public'
    OR (p.visibility = 'followers' AND EXISTS (SELECT 1 FROM feed_follows ff WHERE ff.follower_id = $1 AND ff.followee_id = p.user_id))
    OR (p.visibility = 'community' AND ${sharesCommunity('p.user_id')})
  )`;

const POST_COLS = `p.id, p.user_id, p.kind, p.body_enc, p.visibility, p.run_id, p.created_at, p.created_at::text AS ts, p.held_at, p.hidden_at,
  a.display_name, a.avatar_key, a.avatar_updated_at, a.plan AS author_plan,
  (SELECT count(*) FROM feed_likes l JOIN users lu ON lu.id = l.user_id AND lu.status = 'active' WHERE l.post_id = p.id) AS like_count,
  (SELECT count(*) FROM feed_comments c JOIN users cu ON cu.id = c.user_id AND cu.status = 'active'
     WHERE c.post_id = p.id AND c.removed_at IS NULL AND c.hidden_at IS NULL) AS comment_count,
  EXISTS (SELECT 1 FROM feed_likes l WHERE l.post_id = p.id AND l.user_id = $1) AS liked`;

interface PostRow {
  id: string;
  user_id: string;
  kind: 'text' | 'photo' | 'run';
  body_enc: Buffer | null;
  visibility: PostVisibility;
  run_id: string | null;
  created_at: Date;
  ts: string;
  held_at: Date | null;
  hidden_at: Date | null;
  display_name: string;
  avatar_key: string | null;
  avatar_updated_at: Date | null;
  author_plan?: string;
  like_count: string;
  comment_count: string;
  liked: boolean;
}

interface CommentRow {
  id: string;
  post_id: string;
  user_id: string;
  body_enc: Buffer | null;
  created_at: Date;
  ts: string;
  hidden_at: Date | null;
  display_name: string;
  avatar_key: string | null;
  avatar_updated_at: Date | null;
  post_owner: string;
}

/**
 * Feed sosial (PRD 2.1): postingan teks/foto/hasil lari, ikuti, suka, komentar, blokir.
 * Hak akses diperiksa di setiap permintaan lewat VISIBLE; isi teks terenkripsi FieldCrypto.
 */
@Injectable()
export class FeedService {
  private readonly logger = new Logger('Feed');

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly crypto: FieldCrypto,
    private readonly storage: StorageService,
    private readonly runs: RunsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------- Postingan ----------

  async create(userId: string, input: { text?: string; visibility: PostVisibility; runId?: string }, files: Buffer[]) {
    const text = input.text?.trim() || undefined;
    if (files.length > MAX_POST_PHOTOS) throw new ApiError(400, 'photo_limit', `Maksimal ${MAX_POST_PHOTOS} foto per postingan`);
    if (!text && files.length === 0 && !input.runId) throw new ApiError(400, 'empty_post', 'Tulis sesuatu, pilih foto, atau bagikan hasil lari');

    if (input.runId) {
      const run = await this.runs.shareableRun(userId, input.runId);
      // Postingan tidak boleh lebih luas dari visibilitas larinya (lari komunitas tidak bisa jadi postingan publik).
      if (run.visibility === 'community' && input.visibility !== 'community') {
        throw new ApiError(400, 'visibility_too_wide', 'Lari ini hanya untuk anggota komunitasmu, jadi postingannya juga hanya untuk komunitas');
      }
    }

    const dayKey = `feed:posts:${userId}`;
    if (Number((await this.redis.get(dayKey)) ?? 0) >= POSTS_PER_DAY) {
      throw new ApiError(429, 'post_rate_limited', `Maksimal ${POSTS_PER_DAY} postingan per hari`);
    }

    // Foto diproses dulu (jenis dicek dari isi, EXIF/GPS terbuang) sebelum apa pun disimpan.
    const images: Buffer[] = [];
    for (const f of files) images.push(await processImage(f, { size: 1600 }));

    const id = randomUUID();
    const keys = images.map(() => `feed/${userId}/${id}/${randomUUID()}.webp`);
    for (let i = 0; i < images.length; i++) await this.storage.put(keys[i]!, images[i]!, 'image/webp');
    try {
      await withTx(this.pool, async (db) => {
        await db.query(
          `INSERT INTO feed_posts (id, user_id, kind, body_enc, visibility, run_id) VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, userId, input.runId ? 'run' : images.length ? 'photo' : 'text', text ? this.crypto.encrypt(text, postBodyAad(id)) : null, input.visibility, input.runId ?? null],
        );
        for (let i = 0; i < keys.length; i++) {
          await db.query('INSERT INTO feed_post_photos (post_id, storage_key, position) VALUES ($1, $2, $3)', [id, keys[i], i]);
        }
      });
    } catch (err) {
      await this.deleteObjects(keys);
      if ((err as { code?: string }).code === '23505') throw new ApiError(409, 'run_already_posted', 'Lari ini sudah pernah dibagikan ke feed');
      throw err;
    }
    const n = await this.redis.incr(dayKey);
    if (n === 1) await this.redis.expire(dayKey, 86_400);
    return this.get(userId, id);
  }

  async list(viewerId: string, q: { tab: FeedTab; cursor?: string }) {
    const extra =
      q.tab === 'following'
        ? `AND (p.user_id = $1 OR EXISTS (SELECT 1 FROM feed_follows fo WHERE fo.follower_id = $1 AND fo.followee_id = p.user_id))`
        : q.tab === 'community'
          ? `AND (p.user_id = $1 OR ${sharesCommunity('p.user_id')})`
          : // Jelajah: hanya konten publik yang tidak sedang disembunyikan.
            `AND p.visibility = 'public' AND p.hidden_at IS NULL`;
    return this.page(viewerId, extra, [], q.cursor);
  }

  async ofUser(viewerId: string, userId: string, cursor?: string) {
    if (!(await this.canSeeProfile(viewerId, userId))) throw userNotFound();
    return this.page(viewerId, 'AND p.user_id = $2', [userId], cursor);
  }

  async get(viewerId: string, postId: string) {
    const row = await this.visiblePost(viewerId, postId);
    const [item] = await this.toJson(viewerId, [row]);
    return item!;
  }

  async remove(userId: string, postId: string): Promise<void> {
    const keys = await withTx(this.pool, async (db) => {
      const { rows } = await db.query<{ user_id: string; held_at: Date | null }>(
        'SELECT user_id, held_at FROM feed_posts WHERE id = $1 AND removed_at IS NULL FOR UPDATE',
        [postId],
      );
      if (!rows[0] || rows[0].user_id !== userId) throw postNotFound();
      if (rows[0].held_at) throw new ApiError(409, 'content_held', 'Postingan ini sedang ditinjau karena laporan dan belum bisa dihapus');
      const photos = await db.query<{ storage_key: string }>('DELETE FROM feed_post_photos WHERE post_id = $1 RETURNING storage_key', [postId]);
      await db.query('DELETE FROM feed_posts WHERE id = $1', [postId]);
      return photos.rows.map((r) => r.storage_key);
    });
    await this.deleteObjects(keys);
  }

  async photoFile(viewerId: string, postId: string, photoId: string) {
    await this.visiblePost(viewerId, postId);
    const { rows } = await this.pool.query<{ storage_key: string }>('SELECT storage_key FROM feed_post_photos WHERE id = $1 AND post_id = $2', [
      photoId,
      postId,
    ]);
    return rows[0] ? this.storage.get(rows[0].storage_key) : undefined;
  }

  // ---------- Suka ----------

  async like(userId: string, postId: string) {
    const post = await this.visiblePost(userId, postId);
    const { rowCount } = await this.pool.query('INSERT INTO feed_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [postId, userId]);
    // Satu notifikasi per penyuka per postingan per hari (suka-batal-suka tidak membanjiri notifikasi).
    if (rowCount && post.user_id !== userId && (await this.once(`feed:n:like:${postId}:${userId}`))) {
      const { actor } = await this.notifications.labels(userId);
      await this.notifications.notify([post.user_id], {
        category: 'social',
        actorId: userId,
        inbox: { type: 'post_like', data: { postId } },
        push: { title: 'Suka baru', body: `${actor} menyukai postinganmu`, data: { type: 'post_like', postId }, tag: `post-like-${postId}` },
      });
    }
    return this.get(userId, postId);
  }

  async unlike(userId: string, postId: string) {
    await this.visiblePost(userId, postId);
    await this.pool.query('DELETE FROM feed_likes WHERE post_id = $1 AND user_id = $2', [postId, userId]);
    return this.get(userId, postId);
  }

  // ---------- Komentar ----------

  async comments(viewerId: string, postId: string, cursor?: string) {
    await this.visiblePost(viewerId, postId);
    const params: unknown[] = [viewerId, postId, COMMENT_PAGE + 1];
    let after = '';
    const c = cursor ? decodeCursor(cursor) : undefined;
    if (c) {
      params.push(c.ts, c.id);
      after = 'AND (c.created_at, c.id) > ($4::timestamptz, $5::uuid)';
    }
    const { rows } = await this.pool.query<CommentRow>(
      `SELECT c.id, c.post_id, c.user_id, c.body_enc, c.created_at, c.created_at::text AS ts, c.hidden_at,
              u.display_name, u.avatar_key, u.avatar_updated_at, p.user_id AS post_owner
         FROM feed_comments c JOIN users u ON u.id = c.user_id JOIN feed_posts p ON p.id = c.post_id
        WHERE c.post_id = $2 AND c.removed_at IS NULL AND u.status = 'active'
          AND (c.hidden_at IS NULL OR c.user_id = $1) AND ${notBlocked('c.user_id')} ${after}
        ORDER BY c.created_at, c.id LIMIT $3`,
      params,
    );
    const page = rows.slice(0, COMMENT_PAGE);
    const last = page.at(-1);
    return {
      items: page.map((r) => this.commentJson(viewerId, r)),
      nextCursor: rows.length > COMMENT_PAGE && last ? encodeCursor(last.ts, last.id) : null,
    };
  }

  async addComment(userId: string, postId: string, text: string) {
    const post = await this.visiblePost(userId, postId);
    const id = randomUUID();
    await this.pool.query('INSERT INTO feed_comments (id, post_id, user_id, body_enc) VALUES ($1, $2, $3, $4)', [
      id,
      postId,
      userId,
      this.crypto.encrypt(text, commentBodyAad(id)),
    ]);
    if (post.user_id !== userId) {
      // Isi komentar tidak pernah dikirim ke Google (KEPUTUSAN #114): hanya nama dan jenis aksi.
      const { actor } = await this.notifications.labels(userId);
      await this.notifications.notify([post.user_id], {
        category: 'social',
        actorId: userId,
        inbox: { type: 'post_comment', data: { postId } },
        push: { title: 'Komentar baru', body: `${actor} mengomentari postinganmu`, data: { type: 'post_comment', postId }, tag: `post-comment-${postId}` },
      });
    }
    const { rows } = await this.pool.query<CommentRow>(
      `SELECT c.id, c.post_id, c.user_id, c.body_enc, c.created_at, c.created_at::text AS ts, c.hidden_at,
              u.display_name, u.avatar_key, u.avatar_updated_at, p.user_id AS post_owner
         FROM feed_comments c JOIN users u ON u.id = c.user_id JOIN feed_posts p ON p.id = c.post_id WHERE c.id = $1`,
      [id],
    );
    return this.commentJson(userId, rows[0]!);
  }

  /** Penulis komentar atau pemilik postingan boleh menghapus. Komentar yang sedang dilaporkan ditahan. */
  async deleteComment(userId: string, commentId: string): Promise<void> {
    const { rows } = await this.pool.query<{ user_id: string; post_id: string; post_owner: string; held_at: Date | null }>(
      `SELECT c.user_id, c.post_id, p.user_id AS post_owner, c.held_at FROM feed_comments c JOIN feed_posts p ON p.id = c.post_id
        WHERE c.id = $1 AND c.removed_at IS NULL`,
      [commentId],
    );
    const c = rows[0];
    if (!c) throw commentNotFound();
    if (c.user_id !== userId && c.post_owner !== userId) {
      // Bukan haknya: tetap 404 jika ia bahkan tidak bisa melihat postingannya.
      await this.visiblePost(userId, c.post_id);
      throw new ApiError(403, 'forbidden', 'Hanya penulis komentar atau pemilik postingan yang bisa menghapus');
    }
    if (c.held_at) throw new ApiError(409, 'content_held', 'Komentar ini sedang ditinjau karena laporan dan belum bisa dihapus');
    await this.pool.query('DELETE FROM feed_comments WHERE id = $1', [commentId]);
  }

  // ---------- Profil, ikuti, blokir ----------

  /**
   * Profil feed pengguna lain terlihat jika: diri sendiri, satu komunitas, salah satu mengikuti yang lain,
   * atau ia aktif di feed publik (punya postingan publik atau komentar di postingan publik).
   * Blokir ke arah mana pun = tidak terlihat. Dipakai juga untuk foto profil (UsersService.avatarFile).
   */
  async canSeeProfile(viewerId: string, userId: string): Promise<boolean> {
    if (viewerId === userId) return true;
    const { rows } = await this.pool.query<{ ok: boolean }>(
      `SELECT (u.status = 'active' AND ${notBlocked('u.id')} AND (
                ${sharesCommunity('u.id')}
                OR EXISTS (SELECT 1 FROM feed_follows f WHERE (f.follower_id = $1 AND f.followee_id = u.id) OR (f.follower_id = u.id AND f.followee_id = $1))
                -- Cari teman lari (modul 2.6): saling sapa, atau keduanya punya profil pencarian aktif (opt-in).
                OR EXISTS (SELECT 1 FROM buddy_requests br WHERE (br.from_user = $1 AND br.to_user = u.id) OR (br.from_user = u.id AND br.to_user = $1))
                OR (EXISTS (SELECT 1 FROM buddy_profiles bp WHERE bp.user_id = u.id AND bp.enabled)
                    AND EXISTS (SELECT 1 FROM buddy_profiles bq WHERE bq.user_id = $1 AND bq.enabled))
                OR EXISTS (SELECT 1 FROM feed_posts p WHERE p.user_id = u.id AND p.visibility = 'public' AND p.removed_at IS NULL AND p.hidden_at IS NULL)
                OR EXISTS (SELECT 1 FROM feed_comments c JOIN feed_posts p ON p.id = c.post_id
                            WHERE c.user_id = u.id AND c.removed_at IS NULL AND c.hidden_at IS NULL
                              AND p.visibility = 'public' AND p.removed_at IS NULL AND p.hidden_at IS NULL)
              )) AS ok
         FROM users u WHERE u.id = $2`,
      [viewerId, userId],
    );
    return Boolean(rows[0]?.ok);
  }

  async profile(viewerId: string, userId: string) {
    if (!(await this.canSeeProfile(viewerId, userId))) throw userNotFound();
    const { rows } = await this.pool.query<{
      id: string;
      display_name: string;
      avatar_key: string | null;
      avatar_updated_at: Date | null;
      verification_level: number;
      plan: string;
      followers: string;
      following: string;
      i_follow: boolean;
      follows_me: boolean;
    }>(
      `SELECT u.id, u.display_name, u.avatar_key, u.avatar_updated_at, u.verification_level, u.plan,
              (SELECT count(*) FROM feed_follows f JOIN users x ON x.id = f.follower_id AND x.status = 'active' WHERE f.followee_id = u.id) AS followers,
              (SELECT count(*) FROM feed_follows f JOIN users x ON x.id = f.followee_id AND x.status = 'active' WHERE f.follower_id = u.id) AS following,
              EXISTS (SELECT 1 FROM feed_follows f WHERE f.follower_id = $1 AND f.followee_id = u.id) AS i_follow,
              EXISTS (SELECT 1 FROM feed_follows f WHERE f.follower_id = u.id AND f.followee_id = $1) AS follows_me
         FROM users u WHERE u.id = $2`,
      [viewerId, userId],
    );
    const u = rows[0]!;
    return {
      id: u.id,
      displayName: u.display_name,
      avatarUrl: avatarPath(u),
      badges: [...(u.plan === 'premium' ? ['premium'] : []), ...(u.verification_level >= 2 ? ['verified'] : [])],
      isMe: viewerId === userId,
      followers: Number(u.followers),
      following: Number(u.following),
      iFollow: u.i_follow,
      followsMe: u.follows_me,
    };
  }

  async follow(userId: string, targetId: string) {
    if (userId === targetId) throw new ApiError(400, 'cannot_follow_self', 'Tidak bisa mengikuti diri sendiri');
    if (!(await this.canSeeProfile(userId, targetId))) throw userNotFound();
    const { rowCount } = await this.pool.query('INSERT INTO feed_follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      userId,
      targetId,
    ]);
    if (rowCount && (await this.once(`feed:n:follow:${targetId}:${userId}`))) {
      const { actor } = await this.notifications.labels(userId);
      await this.notifications.notify([targetId], {
        category: 'social',
        actorId: userId,
        inbox: { type: 'new_follower', data: { userId } },
        push: { title: 'Pengikut baru', body: `${actor} mulai mengikutimu`, data: { type: 'new_follower', userId } },
      });
    }
    return this.profile(userId, targetId);
  }

  async unfollow(userId: string, targetId: string): Promise<void> {
    await this.pool.query('DELETE FROM feed_follows WHERE follower_id = $1 AND followee_id = $2', [userId, targetId]);
  }

  /** Hapus seseorang dari pengikutku (ia bisa mengikuti lagi; untuk mencegahnya, blokir). */
  async removeFollower(userId: string, followerId: string): Promise<void> {
    await this.pool.query('DELETE FROM feed_follows WHERE follower_id = $1 AND followee_id = $2', [followerId, userId]);
  }

  /** Daftar pengikut/yang diikuti hanya untuk pemiliknya sendiri (jejaring sosial tidak dibuka ke orang lain). */
  async myConnections(userId: string, which: 'followers' | 'following') {
    const [mine, other] = which === 'followers' ? ['followee_id', 'follower_id'] : ['follower_id', 'followee_id'];
    const { rows } = await this.pool.query<{ id: string; display_name: string; avatar_key: string | null; avatar_updated_at: Date | null }>(
      `SELECT u.id, u.display_name, u.avatar_key, u.avatar_updated_at FROM feed_follows f JOIN users u ON u.id = f.${other}
        WHERE f.${mine} = $1 AND u.status = 'active' ORDER BY f.created_at DESC LIMIT 500`,
      [userId],
    );
    return { items: rows.map((u) => ({ id: u.id, displayName: u.display_name, avatarUrl: avatarPath(u) })) };
  }

  /** Blokir di feed. Boleh untuk pengguna mana pun yang ada (mis. penulis komentar yang profilnya tidak terlihat). */
  async block(userId: string, targetId: string): Promise<void> {
    if (userId === targetId) throw new ApiError(400, 'cannot_block_self', 'Tidak bisa memblokir diri sendiri');
    const { rows } = await this.pool.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [targetId]);
    if (!rows[0] || rows[0].status === 'deleted') throw userNotFound();
    await withTx(this.pool, async (db) => {
      await db.query('INSERT INTO feed_blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, targetId]);
      await db.query(
        'DELETE FROM feed_follows WHERE (follower_id = $1 AND followee_id = $2) OR (follower_id = $2 AND followee_id = $1)',
        [userId, targetId],
      );
      // Blokir juga memutus hubungan Cari teman lari (sapa/teman), sehingga chat lewat jalur itu tertutup.
      await db.query('DELETE FROM buddy_requests WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)', [userId, targetId]);
    });
  }

  async unblock(userId: string, targetId: string): Promise<void> {
    await this.pool.query('DELETE FROM feed_blocks WHERE blocker_id = $1 AND blocked_id = $2', [userId, targetId]);
  }

  async blocks(userId: string) {
    const { rows } = await this.pool.query<{ id: string; display_name: string }>(
      `SELECT u.id, u.display_name FROM feed_blocks b JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = $1 AND u.status <> 'deleted' ORDER BY b.created_at DESC LIMIT 500`,
      [userId],
    );
    return { items: rows.map((u) => ({ id: u.id, displayName: u.display_name })) };
  }

  // ---------- Dipanggil modul lain ----------

  /** Laporan: pelapor hanya bisa melaporkan postingan yang bisa ia lihat. Mengembalikan penulisnya. */
  async reportablePost(reporterId: string, postId: string): Promise<{ authorId: string }> {
    const p = await this.visiblePost(reporterId, postId);
    return { authorId: p.user_id };
  }

  /** Laporan komentar: komentar harus terlihat oleh pelapor (postingan terlihat, tidak diblokir). */
  async reportableComment(reporterId: string, commentId: string): Promise<{ authorId: string }> {
    const { rows } = await this.pool.query<{ post_id: string; user_id: string }>(
      `SELECT c.post_id, c.user_id FROM feed_comments c JOIN users u ON u.id = c.user_id
        WHERE c.id = $2 AND c.removed_at IS NULL AND u.status = 'active' AND (c.hidden_at IS NULL OR c.user_id = $1) AND ${notBlocked('c.user_id')}`,
      [reporterId, commentId],
    );
    if (!rows[0]) throw commentNotFound();
    await this.visiblePost(reporterId, rows[0].post_id).catch(() => {
      throw commentNotFound();
    });
    return { authorId: rows[0].user_id };
  }

  /**
   * Hapus akun (dalam transaksi yang sama): postingan beserta komentar/suka/fotonya, komentar dan suka
   * di postingan orang lain, mengikuti/diikuti, dan blokir dihapus. Mengembalikan kunci foto untuk dihapus.
   */
  async onAccountDeletion(db: Queryable, userId: string): Promise<string[]> {
    const { rows } = await db.query<{ storage_key: string }>(
      'DELETE FROM feed_post_photos ph USING feed_posts p WHERE ph.post_id = p.id AND p.user_id = $1 RETURNING ph.storage_key',
      [userId],
    );
    await db.query('DELETE FROM feed_posts WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM feed_comments WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM feed_likes WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM feed_follows WHERE follower_id = $1 OR followee_id = $1', [userId]);
    await db.query('DELETE FROM feed_blocks WHERE blocker_id = $1 OR blocked_id = $1', [userId]);
    return rows.map((r) => r.storage_key);
  }

  async deleteObjects(keys: string[]) {
    for (const k of keys) await this.storage.delete(k).catch(() => this.logger.warn('Gagal menghapus foto feed'));
  }

  // ---------- Bantuan ----------

  private async page(viewerId: string, extra: string, extraParams: unknown[], cursor?: string) {
    const params: unknown[] = [viewerId, ...extraParams];
    const c = cursor ? decodeCursor(cursor) : undefined;
    let before = '';
    if (c) {
      params.push(c.ts, c.id);
      before = `AND (p.created_at, p.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(PAGE + 1);
    const { rows } = await this.pool.query<PostRow>(
      `SELECT ${POST_COLS} FROM feed_posts p JOIN users a ON a.id = p.user_id
        WHERE ${VISIBLE} ${extra} ${before}
        ORDER BY p.created_at DESC, p.id DESC LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, PAGE);
    const last = page.at(-1);
    return { items: await this.toJson(viewerId, page), nextCursor: rows.length > PAGE && last ? encodeCursor(last.ts, last.id) : null };
  }

  private async visiblePost(viewerId: string, postId: string): Promise<PostRow> {
    const { rows } = await this.pool.query<PostRow>(
      `SELECT ${POST_COLS} FROM feed_posts p JOIN users a ON a.id = p.user_id WHERE p.id = $2 AND ${VISIBLE}`,
      [viewerId, postId],
    );
    if (!rows[0]) throw postNotFound();
    return rows[0];
  }

  private async toJson(viewerId: string, rows: PostRow[]) {
    const ids = rows.map((r) => r.id);
    const photos = new Map<string, { id: string; url: string }[]>();
    if (ids.length) {
      const { rows: ph } = await this.pool.query<{ id: string; post_id: string }>(
        'SELECT id, post_id FROM feed_post_photos WHERE post_id = ANY($1::uuid[]) ORDER BY position',
        [ids],
      );
      for (const p of ph) photos.set(p.post_id, [...(photos.get(p.post_id) ?? []), { id: p.id, url: `/v1/feed/posts/${p.post_id}/photos/${p.id}` }]);
    }
    const cards = await this.runs.feedCards(viewerId, rows.map((r) => r.run_id).filter((x): x is string => Boolean(x)));
    return rows.map((r) => {
      const isMine = r.user_id === viewerId;
      const run = r.run_id ? (cards.get(r.run_id) ?? null) : null;
      return {
        id: r.id,
        kind: r.kind,
        text: r.body_enc ? this.crypto.decryptString(r.body_enc, postBodyAad(r.id)) : null,
        visibility: r.visibility,
        createdAt: r.created_at.toISOString(),
        // Lencana Premium di avatar (PRD Lencana).
        author: { id: r.user_id, displayName: r.display_name, avatarUrl: avatarPath({ id: r.user_id, avatar_key: r.avatar_key, avatar_updated_at: r.avatar_updated_at }), badges: r.author_plan === 'premium' ? ['premium'] : [] },
        isMine,
        likeCount: Number(r.like_count),
        commentCount: Number(r.comment_count),
        likedByMe: r.liked,
        photos: photos.get(r.id) ?? [],
        run,
        // Lari dihapus, dijadikan privat, atau tidak boleh dilihat penonton: kartu "tidak tersedia".
        runUnavailable: r.kind === 'run' && !run,
        // Hanya penulis yang tahu postingannya sedang ditinjau/disembunyikan.
        ...(isMine ? { underReview: Boolean(r.held_at), hidden: Boolean(r.hidden_at) } : {}),
      };
    });
  }

  private commentJson(viewerId: string, r: CommentRow) {
    const isMine = r.user_id === viewerId;
    return {
      id: r.id,
      postId: r.post_id,
      text: r.body_enc ? this.crypto.decryptString(r.body_enc, commentBodyAad(r.id)) : '',
      createdAt: r.created_at.toISOString(),
      author: { id: r.user_id, displayName: r.display_name, avatarUrl: avatarPath({ id: r.user_id, avatar_key: r.avatar_key, avatar_updated_at: r.avatar_updated_at }) },
      isMine,
      canDelete: isMine || r.post_owner === viewerId,
      ...(isMine ? { hidden: Boolean(r.hidden_at) } : {}),
    };
  }

  /** true hanya pada pemanggilan pertama dalam 24 jam untuk [key] (penahan notifikasi berulang). */
  private async once(key: string): Promise<boolean> {
    return (await this.redis.set(key, '1', 'EX', 86_400, 'NX')) === 'OK';
  }
}

function encodeCursor(ts: string, id: string) {
  return Buffer.from(`${ts}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { ts: string; id: string } | undefined {
  const [ts, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!ts || !id || !/^[0-9a-f-]{36}$/.test(id) || !/^\d{4}-\d{2}-\d{2} [\d:.]+[+-]\d{2}(:\d{2})?$/.test(ts)) {
    throw new ApiError(400, 'invalid_cursor', 'Kursor tidak valid');
  }
  return { ts, id };
}

const postNotFound = () => new ApiError(404, 'post_not_found', 'Postingan tidak ditemukan');
const commentNotFound = () => new ApiError(404, 'comment_not_found', 'Komentar tidak ditemukan');
const userNotFound = () => new ApiError(404, 'user_not_found', 'Pengguna tidak ditemukan');
