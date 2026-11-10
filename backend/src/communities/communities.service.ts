import { randomInt } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type pg from 'pg';
import { chatImageKeysOfCommunities } from '../chat/chat-storage.js';
import { type Queryable, withTx } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { ENV, type Env } from '../config/env.js';
import { PG_POOL } from '../core.module.js';
import {
  COMMUNITY_MEMBER_LIMIT,
  type CommunityPlan,
  FREE_COMMUNITIES_PER_OWNER,
  hasMultiAdmin,
  isPaidCommunity,
  limitInfo,
  USER_JOIN_LIMIT,
  type UserPlan,
} from '../plans/plans.js';
import { processImage } from '../storage/image.js';
import { StorageService } from '../storage/storage.service.js';
import { avatarPath } from '../users/users.repository.js';

export type Role = 'owner' | 'admin' | 'member';
export type MemberStatus = 'active' | 'pending' | 'banned';
type MyStatus = MemberStatus | 'none';

interface CommunityRow {
  id: string;
  name: string;
  city: string;
  description: string;
  logo_key: string | null;
  logo_updated_at: Date | null;
  visibility: 'open' | 'private';
  plan: CommunityPlan;
  new_members_see_history: boolean;
  owner_id: string;
  member_count: number;
  created_at: Date;
}

const COLS = `c.id, c.name, c.city, c.description, c.logo_key, c.logo_updated_at, c.visibility, c.plan,
  c.new_members_see_history, c.owner_id, c.member_count, c.created_at`;

/** Huruf kode undangan: tanpa 0/O/1/I/L agar mudah dibaca dan diketik. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export class LimitError extends ApiError {
  constructor(kind: 'user_join' | 'community_members' | 'owned_communities' | 'multi_admin', message: string, limit: number | null) {
    super(403, 'limit_reached', message, { limit: { kind, max: limit } });
  }
}

@Injectable()
export class CommunitiesService {
  private readonly logger = new Logger('Communities');

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(ENV) private readonly env: Env,
    private readonly storage: StorageService,
  ) {}

  // ---------- Baca ----------

  async directory(userId: string, q: { city?: string; search?: string; limit: number; cursor?: string }) {
    // Disembunyikan (banyak laporan) atau diturunkan super admin: tidak tampil di direktori.
    const where: string[] = [`m.status IS DISTINCT FROM 'banned'`, 'c.hidden_at IS NULL', 'c.removed_at IS NULL'];
    const params: unknown[] = [userId];
    if (q.city) {
      params.push(q.city.trim().toLowerCase());
      where.push(`lower(c.city) = $${params.length}`);
    }
    if (q.search) {
      params.push(`%${escapeLike(q.search.trim().toLowerCase())}%`);
      where.push(`(lower(c.name) LIKE $${params.length} OR lower(c.city) LIKE $${params.length})`);
    }
    const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
    if (cursor) {
      params.push(cursor.count, cursor.id);
      where.push(`(c.member_count, c.id) < ($${params.length - 1}, $${params.length})`);
    }
    params.push(q.limit + 1);
    const { rows } = await this.pool.query<CommunityRow & { my_status: MemberStatus | null; my_role: Role | null }>(
      `SELECT ${COLS}, m.status AS my_status, m.role AS my_role
         FROM communities c
         LEFT JOIN community_members m ON m.community_id = c.id AND m.user_id = $1
        WHERE ${where.join(' AND ')}
        ORDER BY c.member_count DESC, c.id DESC
        LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => this.summary(r, r.my_status ?? 'none', r.my_role)),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.member_count, last.id) : null,
    };
  }

  /** Daftar kota yang punya komunitas, untuk filter direktori. */
  async cities(): Promise<{ city: string; communities: number }[]> {
    const { rows } = await this.pool.query<{ city: string; n: string }>(
      `SELECT min(city) AS city, count(*) AS n FROM communities WHERE hidden_at IS NULL AND removed_at IS NULL GROUP BY lower(city) ORDER BY count(*) DESC, min(city) LIMIT 200`,
    );
    return rows.map((r) => ({ city: r.city, communities: Number(r.n) }));
  }

  async mine(userId: string) {
    const { rows } = await this.pool.query<CommunityRow & { my_status: MemberStatus; my_role: Role }>(
      `SELECT ${COLS}, m.status AS my_status, m.role AS my_role
         FROM community_members m JOIN communities c ON c.id = m.community_id
        WHERE m.user_id = $1 AND m.status IN ('active', 'pending') AND c.removed_at IS NULL
        ORDER BY (m.status = 'active') DESC, m.joined_at DESC NULLS LAST, m.requested_at DESC`,
      [userId],
    );
    const limits = await this.userLimits(this.pool, userId);
    return { items: rows.map((r) => this.summary(r, r.my_status, r.my_role)), limits };
  }

  async detail(userId: string, communityId: string) {
    const { rows } = await this.pool.query<CommunityRow & { my_status: MemberStatus | null; my_role: Role | null }>(
      `SELECT ${COLS}, m.status AS my_status, m.role AS my_role
         FROM communities c
         LEFT JOIN community_members m ON m.community_id = c.id AND m.user_id = $2
        WHERE c.id = $1 AND c.removed_at IS NULL`,
      [communityId, userId],
    );
    const r = rows[0];
    if (!r) throw notFound();
    // Komunitas yang memblokir pengguna tampil seolah tidak ada baginya.
    if (r.my_status === 'banned') throw notFound();
    const isStaff = r.my_status === 'active' && (r.my_role === 'owner' || r.my_role === 'admin');
    const pendingCount = isStaff
      ? Number(
          (
            await this.pool.query<{ n: string }>(
              `SELECT count(*) AS n FROM community_members WHERE community_id = $1 AND status = 'pending'`,
              [communityId],
            )
          ).rows[0]!.n,
        )
      : undefined;
    return {
      ...this.summary(r, r.my_status ?? 'none', r.my_role),
      description: r.description,
      createdAt: r.created_at.toISOString(),
      memberLimit: limitInfo(COMMUNITY_MEMBER_LIMIT[r.plan], r.member_count),
      multiAdmin: hasMultiAdmin(r.plan),
      ...(isStaff ? { settings: { newMembersSeeHistory: r.new_members_see_history }, pendingCount } : {}),
    };
  }

  async members(userId: string, communityId: string, status: 'active' | 'pending' | 'banned') {
    const me = await this.membership(this.pool, communityId, userId);
    if (me?.status !== 'active') throw new ApiError(403, 'not_member', 'Hanya anggota yang bisa melihat daftar anggota');
    if (status !== 'active' && me.role === 'member') throw new ApiError(403, 'not_admin', 'Hanya admin');
    const { rows } = await this.pool.query<{
      user_id: string;
      role: Role;
      status: MemberStatus;
      joined_at: Date | null;
      requested_at: Date;
      display_name: string;
      avatar_key: string | null;
      avatar_updated_at: Date | null;
      city: string | null;
    }>(
      `SELECT m.user_id, m.role, m.status, m.joined_at, m.requested_at,
              u.display_name, u.avatar_key, u.avatar_updated_at, u.city
         FROM community_members m JOIN users u ON u.id = m.user_id
        WHERE m.community_id = $1 AND m.status = $2
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                 COALESCE(m.joined_at, m.requested_at)`,
      [communityId, status],
    );
    return rows.map((r) => ({
      userId: r.user_id,
      displayName: r.display_name,
      avatarUrl: avatarPath({ id: r.user_id, avatar_key: r.avatar_key, avatar_updated_at: r.avatar_updated_at }),
      city: r.city,
      role: r.role,
      status: r.status,
      joinedAt: r.joined_at?.toISOString() ?? null,
      requestedAt: r.requested_at.toISOString(),
    }));
  }

  // ---------- Buat, ubah, hapus ----------

  async create(
    userId: string,
    input: { name: string; city: string; description: string; visibility: 'open' | 'private' },
  ) {
    const id = await withTx(this.pool, async (db) => {
      const user = await this.lockUser(db, userId);
      const ownedFree = Number(
        (
          await db.query<{ n: string }>(`SELECT count(*) AS n FROM communities WHERE owner_id = $1 AND plan = 'free'`, [userId])
        ).rows[0]!.n,
      );
      if (ownedFree >= FREE_COMMUNITIES_PER_OWNER) {
        throw new LimitError(
          'owned_communities',
          `Akun gratis hanya bisa membuat ${FREE_COMMUNITIES_PER_OWNER} komunitas. Upgrade komunitasmu ke Pro untuk membuat komunitas lain`,
          FREE_COMMUNITIES_PER_OWNER,
        );
      }
      await this.assertUserCanJoin(db, userId, user.plan);
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO communities (name, city, description, visibility, owner_id, member_count)
         VALUES ($1, $2, $3, $4, $5, 1) RETURNING id`,
        [input.name, input.city, input.description, input.visibility, userId],
      );
      const cid = rows[0]!.id;
      await db.query(
        `INSERT INTO community_members (community_id, user_id, role, status, joined_at) VALUES ($1, $2, 'owner', 'active', now())`,
        [cid, userId],
      );
      return cid;
    });
    return this.detail(userId, id);
  }

  async update(
    userId: string,
    communityId: string,
    patch: { name?: string; city?: string; description?: string; visibility?: 'open' | 'private'; newMembersSeeHistory?: boolean },
  ) {
    await this.requireStaff(this.pool, communityId, userId);
    const sets: string[] = [];
    const values: unknown[] = [communityId];
    const add = (col: string, v: unknown) => {
      values.push(v);
      sets.push(`${col} = $${values.length}`);
    };
    if (patch.name !== undefined) add('name', patch.name);
    if (patch.city !== undefined) add('city', patch.city);
    if (patch.description !== undefined) add('description', patch.description);
    if (patch.visibility !== undefined) add('visibility', patch.visibility);
    if (patch.newMembersSeeHistory !== undefined) add('new_members_see_history', patch.newMembersSeeHistory);
    if (sets.length) await this.pool.query(`UPDATE communities SET ${sets.join(', ')} WHERE id = $1`, values);
    return this.detail(userId, communityId);
  }

  async setLogo(userId: string, communityId: string, file: Buffer) {
    await this.requireStaff(this.pool, communityId, userId);
    const webp = await processImage(file, { size: 512, square: true });
    const key = `communities/${communityId}/logo-${Date.now()}.webp`;
    await this.storage.put(key, webp, 'image/webp');
    const { rows } = await this.pool.query<{ old: string | null }>(
      `UPDATE communities c SET logo_key = $2, logo_updated_at = now()
         FROM (SELECT logo_key AS old FROM communities WHERE id = $1) prev
        WHERE c.id = $1 RETURNING prev.old`,
      [communityId, key],
    );
    if (rows[0]?.old) await this.storage.delete(rows[0].old).catch(() => this.logger.warn('Gagal menghapus logo lama'));
    return this.detail(userId, communityId);
  }

  async logoFile(communityId: string) {
    const { rows } = await this.pool.query<{ logo_key: string | null }>('SELECT logo_key FROM communities WHERE id = $1', [
      communityId,
    ]);
    const key = rows[0]?.logo_key;
    return key ? this.storage.get(key) : undefined;
  }

  async remove(userId: string, communityId: string): Promise<void> {
    const keys = await withTx(this.pool, async (db) => {
      const c = await this.lockCommunity(db, communityId, true);
      if (c.owner_id !== userId) throw new ApiError(403, 'not_owner', 'Hanya pemilik yang bisa menghapus komunitas');
      // Chat komunitas (pesan + gambar) ikut terhapus.
      const images = await chatImageKeysOfCommunities(db, [communityId]);
      await db.query('DELETE FROM communities WHERE id = $1', [communityId]);
      return [...(c.logo_key ? [c.logo_key] : []), ...images];
    });
    for (const key of keys) await this.storage.delete(key).catch(() => undefined);
  }

  // ---------- Bergabung & keluar ----------

  /** Komunitas terbuka: langsung jadi anggota. Privat: permintaan menunggu persetujuan admin. */
  async join(userId: string, communityId: string): Promise<{ status: MemberStatus }> {
    return withTx(this.pool, async (db) => {
      const user = await this.lockUser(db, userId);
      const c = await this.lockCommunity(db, communityId);
      const existing = await this.membership(db, communityId, userId);
      if (existing?.status === 'banned') throw notFound();
      if (existing?.status === 'active') return { status: 'active' as const };
      if (existing?.status === 'pending') return { status: 'pending' as const };

      await this.assertUserCanJoin(db, userId, user.plan);
      if (c.visibility === 'private') {
        await db.query(
          `INSERT INTO community_members (community_id, user_id, role, status) VALUES ($1, $2, 'member', 'pending')`,
          [communityId, userId],
        );
        return { status: 'pending' as const };
      }
      this.assertCommunityHasRoom(c);
      await this.addActive(db, communityId, userId, null, c.new_members_see_history);
      return { status: 'active' as const };
    });
  }

  async cancelRequest(userId: string, communityId: string): Promise<void> {
    await this.pool.query(`DELETE FROM community_members WHERE community_id = $1 AND user_id = $2 AND status = 'pending'`, [
      communityId,
      userId,
    ]);
  }

  async leave(userId: string, communityId: string): Promise<void> {
    await withTx(this.pool, async (db) => {
      await this.lockCommunity(db, communityId);
      const me = await this.membership(db, communityId, userId);
      if (!me || me.status === 'banned') return;
      if (me.role === 'owner') {
        throw new ApiError(409, 'owner_cannot_leave', 'Pemilik tidak bisa keluar. Serahkan kepemilikan atau hapus komunitas');
      }
      await db.query('DELETE FROM community_members WHERE community_id = $1 AND user_id = $2', [communityId, userId]);
      if (me.status === 'active') await this.adjustCount(db, communityId, -1);
    });
  }

  // ---------- Undangan ----------

  async createInvite(userId: string, communityId: string, opts: { expiresInDays: number; maxUses?: number }) {
    await this.requireStaff(this.pool, communityId, userId);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      try {
        const { rows } = await this.pool.query<InviteRow>(
          `INSERT INTO community_invites (community_id, code, created_by, expires_at, max_uses)
           VALUES ($1, $2, $3, now() + make_interval(days => $4), $5)
           RETURNING id, code, expires_at, max_uses, uses, revoked_at, created_at`,
          [communityId, code, userId, opts.expiresInDays, opts.maxUses ?? null],
        );
        return this.invite(rows[0]!);
      } catch (err) {
        if ((err as { code?: string }).code !== '23505') throw err; // tabrakan kode: coba lagi
      }
    }
    throw new ApiError(503, 'invite_failed', 'Gagal membuat kode undangan, coba lagi');
  }

  async listInvites(userId: string, communityId: string) {
    await this.requireStaff(this.pool, communityId, userId);
    const { rows } = await this.pool.query<InviteRow>(
      `SELECT id, code, expires_at, max_uses, uses, revoked_at, created_at FROM community_invites
        WHERE community_id = $1 AND revoked_at IS NULL AND expires_at > now()
          AND (max_uses IS NULL OR uses < max_uses)
        ORDER BY created_at DESC`,
      [communityId],
    );
    return rows.map((r) => this.invite(r));
  }

  async revokeInvite(userId: string, communityId: string, inviteId: string): Promise<void> {
    await this.requireStaff(this.pool, communityId, userId);
    await this.pool.query('UPDATE community_invites SET revoked_at = now() WHERE id = $1 AND community_id = $2', [
      inviteId,
      communityId,
    ]);
  }

  /** Pratinjau komunitas dari kode undangan (sebelum bergabung). */
  async previewInvite(userId: string, code: string) {
    const inv = await this.findValidInvite(this.pool, code);
    if (!inv) throw new ApiError(404, 'invite_invalid', 'Kode undangan tidak berlaku');
    return this.detail(userId, inv.community_id);
  }

  /** Bergabung lewat kode/tautan undangan: langsung aktif, juga untuk komunitas privat. */
  async joinByCode(userId: string, code: string) {
    const communityId = await withTx(this.pool, async (db) => {
      const user = await this.lockUser(db, userId);
      const inv = await this.findValidInvite(db, code, true);
      if (!inv) throw new ApiError(404, 'invite_invalid', 'Kode undangan tidak berlaku');
      const c = await this.lockCommunity(db, inv.community_id);
      const existing = await this.membership(db, c.id, userId);
      if (existing?.status === 'banned') throw new ApiError(404, 'invite_invalid', 'Kode undangan tidak berlaku');
      if (existing?.status === 'active') return c.id;

      await this.assertUserCanJoin(db, userId, user.plan);
      this.assertCommunityHasRoom(c);
      if (existing?.status === 'pending') {
        await db.query(
          `UPDATE community_members SET status = 'active', joined_at = now(), history_from = $3
            WHERE community_id = $1 AND user_id = $2`,
          [c.id, userId, historyFrom(c.new_members_see_history)],
        );
        await this.adjustCount(db, c.id, 1);
      } else {
        await this.addActive(db, c.id, userId, null, c.new_members_see_history);
      }
      await db.query('UPDATE community_invites SET uses = uses + 1 WHERE id = $1', [inv.id]);
      return c.id;
    });
    return this.detail(userId, communityId);
  }

  // ---------- Kelola anggota (admin) ----------

  /**
   * Setujui permintaan bergabung. [seeHistory]: admin memilih apakah anggota baru melihat riwayat
   * chat lama (PRD 1.6); bawaan mengikuti pengaturan komunitas.
   */
  async approve(adminId: string, communityId: string, targetId: string, seeHistory?: boolean): Promise<void> {
    await withTx(this.pool, async (db) => {
      const target = await this.lockUser(db, targetId);
      const c = await this.lockCommunity(db, communityId);
      await this.requireStaff(db, communityId, adminId);
      const m = await this.membership(db, communityId, targetId);
      if (m?.status !== 'pending') throw new ApiError(404, 'request_not_found', 'Permintaan bergabung tidak ditemukan');
      this.assertCommunityHasRoom(c);
      try {
        await this.assertUserCanJoin(db, targetId, target.plan);
      } catch (err) {
        if (err instanceof LimitError) {
          throw new ApiError(409, 'user_limit_reached', 'Pengguna ini sudah mencapai batas jumlah komunitas yang bisa diikuti');
        }
        throw err;
      }
      await db.query(
        `UPDATE community_members SET status = 'active', joined_at = now(), decided_by = $3, history_from = $4
          WHERE community_id = $1 AND user_id = $2`,
        [communityId, targetId, adminId, historyFrom(seeHistory ?? c.new_members_see_history)],
      );
      await this.adjustCount(db, communityId, 1);
    });
  }

  async reject(adminId: string, communityId: string, targetId: string): Promise<void> {
    await this.requireStaff(this.pool, communityId, adminId);
    await this.pool.query(`DELETE FROM community_members WHERE community_id = $1 AND user_id = $2 AND status = 'pending'`, [
      communityId,
      targetId,
    ]);
  }

  /** Mengeluarkan anggota. `ban` = diblokir: tidak bisa bergabung lagi, termasuk lewat kode undangan. */
  async removeMember(adminId: string, communityId: string, targetId: string, ban: boolean): Promise<void> {
    if (adminId === targetId) throw new ApiError(400, 'cannot_remove_self', 'Gunakan menu Keluar untuk meninggalkan komunitas');
    await withTx(this.pool, async (db) => {
      await this.lockCommunity(db, communityId);
      const admin = await this.requireStaff(db, communityId, adminId);
      const m = await this.membership(db, communityId, targetId);
      if (!m) {
        if (ban) await db.query(`INSERT INTO community_members (community_id, user_id, role, status, decided_by) VALUES ($1, $2, 'member', 'banned', $3)`, [communityId, targetId, adminId]);
        return;
      }
      if (m.role === 'owner') throw new ApiError(403, 'cannot_remove_owner', 'Pemilik tidak bisa dikeluarkan');
      if (m.role === 'admin' && admin.role !== 'owner') {
        throw new ApiError(403, 'cannot_remove_admin', 'Hanya pemilik yang bisa mengeluarkan admin');
      }
      if (ban) {
        await db.query(
          `UPDATE community_members SET status = 'banned', role = 'member', joined_at = NULL, decided_by = $3
            WHERE community_id = $1 AND user_id = $2`,
          [communityId, targetId, adminId],
        );
      } else {
        await db.query('DELETE FROM community_members WHERE community_id = $1 AND user_id = $2', [communityId, targetId]);
      }
      if (m.status === 'active') await this.adjustCount(db, communityId, -1);
    });
  }

  async unban(adminId: string, communityId: string, targetId: string): Promise<void> {
    await this.requireStaff(this.pool, communityId, adminId);
    await this.pool.query(`DELETE FROM community_members WHERE community_id = $1 AND user_id = $2 AND status = 'banned'`, [
      communityId,
      targetId,
    ]);
  }

  /** Mengangkat/menurunkan admin. Hanya pemilik; mengangkat admin hanya untuk Komunitas Pro. */
  async setRole(ownerId: string, communityId: string, targetId: string, role: 'admin' | 'member'): Promise<void> {
    await withTx(this.pool, async (db) => {
      const c = await this.lockCommunity(db, communityId);
      if (c.owner_id !== ownerId) throw new ApiError(403, 'not_owner', 'Hanya pemilik yang bisa mengatur admin');
      const m = await this.membership(db, communityId, targetId);
      if (m?.status !== 'active' || m.role === 'owner') throw new ApiError(404, 'member_not_found', 'Anggota tidak ditemukan');
      if (role === 'admin' && !hasMultiAdmin(c.plan)) {
        throw new LimitError('multi_admin', 'Multi-admin hanya tersedia untuk Komunitas Pro', null);
      }
      await db.query('UPDATE community_members SET role = $3 WHERE community_id = $1 AND user_id = $2', [
        communityId,
        targetId,
        role,
      ]);
    });
  }

  /** Serah terima kepemilikan ke anggota aktif. Pemilik lama menjadi admin (Pro) atau anggota (gratis). */
  async transferOwnership(ownerId: string, communityId: string, targetId: string): Promise<void> {
    if (ownerId === targetId) return;
    await withTx(this.pool, async (db) => {
      await this.lockUser(db, targetId);
      const c = await this.lockCommunity(db, communityId);
      if (c.owner_id !== ownerId) throw new ApiError(403, 'not_owner', 'Hanya pemilik yang bisa menyerahkan kepemilikan');
      const m = await this.membership(db, communityId, targetId);
      if (m?.status !== 'active') throw new ApiError(404, 'member_not_found', 'Penerima harus anggota aktif komunitas ini');
      if (!isPaidCommunity(c.plan)) {
        const ownedFree = Number(
          (await db.query<{ n: string }>(`SELECT count(*) AS n FROM communities WHERE owner_id = $1 AND plan = 'free'`, [targetId]))
            .rows[0]!.n,
        );
        if (ownedFree >= FREE_COMMUNITIES_PER_OWNER) {
          throw new ApiError(409, 'target_owns_free_community', 'Penerima sudah memiliki komunitas gratis');
        }
      }
      await db.query(`UPDATE community_members SET role = $3 WHERE community_id = $1 AND user_id = $2`, [
        communityId,
        ownerId,
        hasMultiAdmin(c.plan) ? 'admin' : 'member',
      ]);
      await db.query(`UPDATE community_members SET role = 'owner' WHERE community_id = $1 AND user_id = $2`, [communityId, targetId]);
      await db.query('UPDATE communities SET owner_id = $2 WHERE id = $1', [communityId, targetId]);
    });
  }

  // ---------- Dipanggil modul lain ----------

  /**
   * Dipanggil saat hapus akun (dalam transaksi yang sama). Komunitas yang hanya berisi pemiliknya
   * ikut dihapus; jika masih ada anggota lain, penghapusan akun ditolak sampai kepemilikan diserahkan.
   * Mengembalikan kunci logo yang perlu dihapus dari penyimpanan setelah transaksi selesai.
   */
  async onAccountDeletion(db: Queryable, userId: string): Promise<string[]> {
    const { rows } = await db.query<{ id: string; name: string; member_count: number; logo_key: string | null }>(
      'SELECT id, name, member_count, logo_key FROM communities WHERE owner_id = $1 FOR UPDATE',
      [userId],
    );
    const blocking = rows.filter((r) => r.member_count > 1);
    if (blocking.length) {
      throw new ApiError(
        409,
        'owns_communities',
        `Serahkan kepemilikan atau hapus komunitas ${blocking.map((b) => `"${b.name}"`).join(', ')} sebelum menghapus akun`,
        { communities: blocking.map((b) => ({ id: b.id, name: b.name })) },
      );
    }
    const chatImages = await chatImageKeysOfCommunities(db, rows.map((r) => r.id));
    if (rows.length) await db.query('DELETE FROM communities WHERE owner_id = $1', [userId]);

    // Keluar dari semua komunitas lain; jumlah anggota aktif disesuaikan.
    const { rows: left } = await db.query<{ community_id: string; status: MemberStatus }>(
      `DELETE FROM community_members WHERE user_id = $1 RETURNING community_id, status`,
      [userId],
    );
    const activeIds = left.filter((l) => l.status === 'active').map((l) => l.community_id);
    if (activeIds.length) {
      await db.query('UPDATE communities SET member_count = member_count - 1 WHERE id = ANY($1::uuid[])', [activeIds]);
    }
    return [...rows.map((r) => r.logo_key).filter((k): k is string => Boolean(k)), ...chatImages];
  }

  /** Apakah dua pengguna sama-sama anggota aktif minimal satu komunitas (dipakai profil & chat). */
  async shareCommunity(a: string, b: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `SELECT 1 FROM community_members x JOIN community_members y ON y.community_id = x.community_id
        WHERE x.user_id = $1 AND y.user_id = $2 AND x.status = 'active' AND y.status = 'active' LIMIT 1`,
      [a, b],
    );
    return (rowCount ?? 0) > 0;
  }

  // ---------- Bantuan ----------

  async userLimits(db: Queryable, userId: string) {
    const { rows } = await db.query<{ plan: UserPlan; joined: string; owned_free: string }>(
      `SELECT u.plan,
              (SELECT count(*) FROM community_members WHERE user_id = u.id AND status = 'active') AS joined,
              (SELECT count(*) FROM communities WHERE owner_id = u.id AND plan = 'free') AS owned_free
         FROM users u WHERE u.id = $1`,
      [userId],
    );
    const r = rows[0]!;
    return {
      plan: r.plan,
      joined: limitInfo(USER_JOIN_LIMIT[r.plan], Number(r.joined)),
      ownedFreeCommunities: limitInfo(FREE_COMMUNITIES_PER_OWNER, Number(r.owned_free)),
    };
  }

  private async assertUserCanJoin(db: Queryable, userId: string, plan: UserPlan) {
    const limit = USER_JOIN_LIMIT[plan];
    if (limit === null) return;
    const joined = Number(
      (
        await db.query<{ n: string }>(`SELECT count(*) AS n FROM community_members WHERE user_id = $1 AND status = 'active'`, [
          userId,
        ])
      ).rows[0]!.n,
    );
    if (joined >= limit) {
      throw new LimitError(
        'user_join',
        `Akun gratis bisa bergabung ke maksimal ${limit} komunitas. Upgrade ke Premium untuk bergabung tanpa batas`,
        limit,
      );
    }
  }

  private assertCommunityHasRoom(c: CommunityRow) {
    const limit = COMMUNITY_MEMBER_LIMIT[c.plan];
    if (limit !== null && c.member_count >= limit) {
      throw new LimitError(
        'community_members',
        c.plan === 'free'
          ? `Komunitas ini sudah mencapai batas ${limit} anggota untuk paket gratis`
          : `Komunitas ini sudah mencapai batas ${limit} anggota`,
        limit,
      );
    }
  }

  private async addActive(db: Queryable, communityId: string, userId: string, decidedBy: string | null, seeHistory: boolean) {
    await db.query(
      `INSERT INTO community_members (community_id, user_id, role, status, joined_at, decided_by, history_from)
       VALUES ($1, $2, 'member', 'active', now(), $3, $4)`,
      [communityId, userId, decidedBy, historyFrom(seeHistory)],
    );
    await this.adjustCount(db, communityId, 1);
  }

  private async adjustCount(db: Queryable, communityId: string, delta: number) {
    await db.query('UPDATE communities SET member_count = member_count + $2 WHERE id = $1', [communityId, delta]);
  }

  /**
   * Urutan kunci selalu: baris pengguna lalu baris komunitas. Konsisten di semua alur agar
   * tidak terjadi deadlock, dan batas tidak bisa terlewati oleh permintaan yang bersamaan.
   */
  private async lockUser(db: Queryable, userId: string): Promise<{ plan: UserPlan }> {
    const { rows } = await db.query<{ plan: UserPlan; status: string }>('SELECT plan, status FROM users WHERE id = $1 FOR UPDATE', [
      userId,
    ]);
    if (!rows[0] || rows[0].status !== 'active') throw new ApiError(404, 'user_not_found', 'Pengguna tidak ditemukan');
    return rows[0];
  }

  /** Komunitas yang diturunkan super admin dianggap tidak ada (kecuali untuk dihapus pemiliknya). */
  private async lockCommunity(db: Queryable, communityId: string, allowRemoved = false): Promise<CommunityRow> {
    const { rows } = await db.query<CommunityRow>(
      `SELECT ${COLS} FROM communities c WHERE c.id = $1 ${allowRemoved ? '' : 'AND c.removed_at IS NULL'} FOR UPDATE`,
      [communityId],
    );
    if (!rows[0]) throw notFound();
    return rows[0];
  }

  private async membership(db: Queryable, communityId: string, userId: string) {
    const { rows } = await db.query<{ role: Role; status: MemberStatus }>(
      'SELECT role, status FROM community_members WHERE community_id = $1 AND user_id = $2',
      [communityId, userId],
    );
    return rows[0];
  }

  private async requireStaff(db: Queryable, communityId: string, userId: string) {
    const m = await this.membership(db, communityId, userId);
    if (m?.status !== 'active' || m.role === 'member') throw new ApiError(403, 'not_admin', 'Hanya admin komunitas');
    return m;
  }

  private async findValidInvite(db: Queryable, code: string, lock = false) {
    const { rows } = await db.query<{ id: string; community_id: string }>(
      `SELECT id, community_id FROM community_invites
        WHERE code = $1 AND revoked_at IS NULL AND expires_at > now() AND (max_uses IS NULL OR uses < max_uses)
        ${lock ? 'FOR UPDATE' : ''}`,
      [code.trim().toUpperCase()],
    );
    return rows[0];
  }

  private summary(r: CommunityRow, myStatus: MyStatus, myRole: Role | null) {
    return {
      id: r.id,
      name: r.name,
      city: r.city,
      visibility: r.visibility,
      memberCount: r.member_count,
      logoUrl: r.logo_key ? `/v1/communities/${r.id}/logo?v=${r.logo_updated_at?.getTime() ?? 0}` : null,
      badges: isPaidCommunity(r.plan) ? ['pro'] : [],
      myStatus,
      myRole: myStatus === 'active' ? myRole : null,
      ownerId: r.owner_id,
    };
  }

  private invite(r: InviteRow) {
    return {
      id: r.id,
      code: r.code,
      url: `${this.env.PUBLIC_WEB_URL}/j/${r.code}`,
      expiresAt: r.expires_at.toISOString(),
      maxUses: r.max_uses,
      uses: r.uses,
    };
  }
}

interface InviteRow {
  id: string;
  code: string;
  expires_at: Date;
  max_uses: number | null;
  uses: number;
  revoked_at: Date | null;
  created_at: Date;
}

function notFound() {
  return new ApiError(404, 'community_not_found', 'Komunitas tidak ditemukan');
}

function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function encodeCursor(count: number, id: string) {
  return Buffer.from(`${count}:${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { count: number; id: string } | undefined {
  const [count, id] = Buffer.from(cursor, 'base64url').toString().split(':');
  if (!count || !id || !/^\d+$/.test(count) || !/^[0-9a-f-]{36}$/.test(id)) return undefined;
  return { count: Number(count), id };
}

/** NULL = melihat seluruh riwayat chat; selain itu hanya pesan sejak bergabung. */
function historyFrom(seeHistory: boolean): Date | null {
  return seeHistory ? null : new Date();
}
