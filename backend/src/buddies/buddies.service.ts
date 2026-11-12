import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { type Queryable, withTx } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { PG_POOL, REDIS } from '../core.module.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { hasBuddyFilters, type UserPlan } from '../plans/plans.js';
import { avatarPath } from '../users/users.repository.js';

/** Jam lari favorit (WIB setempat): subuh 04–06, pagi 06–09, siang 09–15, sore 15–18, malam 18–22. */
export const BUDDY_SLOTS = ['subuh', 'pagi', 'siang', 'sore', 'malam'] as const;
export type BuddySlot = (typeof BUDDY_SLOTS)[number];

/** Area dibulatkan ke grid 0,02° (±2,2 km) ke titik tengah sel: lokasi persis tidak pernah disimpan. */
export const AREA_GRID_DEG = 0.02;
export const BUDDY_RESULTS = 30;
/** Batas laju pencarian (CLAUDE.md: pembatasan laju pada pencarian), di samping throttler per menit. */
export const BUDDY_SEARCHES_PER_DAY = 50;
/** Sapa baru per 24 jam (anti-spam). */
export const BUDDY_REQUESTS_PER_DAY = 10;
export const BUDDY_MAX_DISTANCE_KM = 50;

export interface BuddyProfileInput {
  paceSPerKm: number;
  city: string;
  area?: { lat: number; lng: number } | null;
  slots: BuddySlot[];
  enabled?: boolean;
}

export interface BuddySearch {
  city?: string;
  paceMinSPerKm?: number;
  paceMaxSPerKm?: number;
  maxDistanceKm?: number;
  slots?: BuddySlot[];
}

export function snapToGrid(v: number): number {
  return Math.round((Math.floor(v / AREA_GRID_DEG) * AREA_GRID_DEG + AREA_GRID_DEG / 2) * 1e4) / 1e4;
}

/** Tidak ada blokir feed (#139) di antara $1 dan [col], ke arah mana pun. */
const NOT_BLOCKED = (col: string) => `NOT EXISTS (SELECT 1 FROM feed_blocks bl
  WHERE (bl.blocker_id = $1 AND bl.blocked_id = ${col}) OR (bl.blocker_id = ${col} AND bl.blocked_id = $1))`;

/**
 * Cari teman lari (modul 2.6). Opt-in eksplisit: tanpa profil pencarian, pengguna tidak pernah muncul. Hanya yang
 * ia setujui dibagikan (nama, foto, pace, kota, jam favorit, jarak perkiraan dari area yang ia pilih sendiri). Yang
 * mencari juga wajib punya profil aktif (timbal balik, mencegah pengintaian anonim). Sapa harus diterima sebelum
 * chat pribadi terbuka (#85 tetap berlaku untuk orang asing).
 */
@Injectable()
export class BuddiesService {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------- Profil pencarian ----------

  async profile(userId: string) {
    const { rows } = await this.pool.query<{ enabled: boolean; pace_s_per_km: number; city: string; lat: number | null; lng: number | null; slots: BuddySlot[]; consented_at: Date }>(
      `SELECT enabled, pace_s_per_km, city, ST_Y(area::geometry) AS lat, ST_X(area::geometry) AS lng, slots, consented_at
         FROM buddy_profiles WHERE user_id = $1`,
      [userId],
    );
    const r = rows[0];
    const plan = await this.plan(userId);
    return {
      profile: r
        ? { enabled: r.enabled, paceSPerKm: r.pace_s_per_km, city: r.city, area: r.lat !== null && r.lng !== null ? { lat: r.lat, lng: r.lng } : null, slots: r.slots, consentedAt: r.consented_at.toISOString() }
        : null,
      filters: hasBuddyFilters(plan),
    };
  }

  /** Buat/ubah profil. [consent] wajib true saat pertama dibuat (layar persetujuan di aplikasi). */
  async saveProfile(userId: string, input: BuddyProfileInput, consent: boolean) {
    const area = input.area ? { lat: snapToGrid(input.area.lat), lng: snapToGrid(input.area.lng) } : null;
    const { rowCount } = await this.pool.query('SELECT 1 FROM buddy_profiles WHERE user_id = $1', [userId]);
    if (!rowCount && !consent) throw new ApiError(400, 'consent_required', 'Setujui dulu bahwa profil pencarianmu terlihat oleh pengguna lain');
    await this.pool.query(
      `INSERT INTO buddy_profiles (user_id, enabled, pace_s_per_km, city, city_key, area, slots)
       VALUES ($1, $2, $3, $4, lower($4), CASE WHEN $5::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($6, $5), 4326)::geography END, $7)
       ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, pace_s_per_km = EXCLUDED.pace_s_per_km, city = EXCLUDED.city,
         city_key = EXCLUDED.city_key, area = EXCLUDED.area, slots = EXCLUDED.slots`,
      [userId, input.enabled ?? true, input.paceSPerKm, input.city.trim(), area?.lat ?? null, area?.lng ?? null, [...new Set(input.slots)]],
    );
    return this.profile(userId);
  }

  /** Berhenti: profil dihapus dan sapa yang menunggu ikut dihapus. Teman yang sudah diterima tetap. */
  async deleteProfile(userId: string): Promise<void> {
    await withTx(this.pool, async (db) => {
      await db.query('DELETE FROM buddy_profiles WHERE user_id = $1', [userId]);
      await db.query(`DELETE FROM buddy_requests WHERE (from_user = $1 OR to_user = $1) AND status <> 'accepted'`, [userId]);
    });
  }

  // ---------- Pencarian ----------

  async search(userId: string, q: BuddySearch) {
    const me = await this.myProfile(userId);
    if (!me?.enabled) throw new ApiError(403, 'buddy_profile_required', 'Aktifkan profil Cari teman lari dulu agar bisa mencari');
    const plan = await this.plan(userId);
    const premiumFilter = q.paceMinSPerKm !== undefined || q.paceMaxSPerKm !== undefined || q.maxDistanceKm !== undefined || (q.slots?.length ?? 0) > 0;
    if (premiumFilter && !hasBuddyFilters(plan)) {
      throw new ApiError(403, 'limit_reached', 'Filter pace, jarak lokasi, dan jam khusus Premium. Paket gratis mencari per kota', {
        limit: { kind: 'buddy_filters', max: null },
      });
    }
    if (q.maxDistanceKm !== undefined && me.lat === null) throw new ApiError(400, 'area_required', 'Pilih area lari di profil pencarian untuk memakai filter jarak');

    const dayKey = `buddy:search:${userId}:${new Date().toISOString().slice(0, 10)}`;
    const used = await this.redis.incr(dayKey);
    if (used === 1) await this.redis.expire(dayKey, 86_400);
    if (used > BUDDY_SEARCHES_PER_DAY) throw new ApiError(429, 'search_rate_limited', `Maksimal ${BUDDY_SEARCHES_PER_DAY} pencarian per hari`);

    const params: unknown[] = [userId];
    const where = [
      'bp.enabled',
      'bp.user_id <> $1',
      `u.status = 'active'`,
      NOT_BLOCKED('bp.user_id'),
    ];
    // Filter jarak (Premium) menggantikan filter kota; selain itu per kota (bawaan: kota di profil sendiri).
    if (q.maxDistanceKm !== undefined) {
      params.push(me.lng, me.lat, q.maxDistanceKm * 1000);
      where.push(`bp.area IS NOT NULL AND ST_DWithin(bp.area, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4)`);
    } else {
      params.push((q.city ?? me.city).trim().toLowerCase());
      where.push(`bp.city_key = $${params.length}`);
    }
    if (q.paceMinSPerKm !== undefined) {
      params.push(q.paceMinSPerKm);
      where.push(`bp.pace_s_per_km >= $${params.length}`);
    }
    if (q.paceMaxSPerKm !== undefined) {
      params.push(q.paceMaxSPerKm);
      where.push(`bp.pace_s_per_km <= $${params.length}`);
    }
    if (q.slots?.length) {
      params.push(q.slots);
      where.push(`bp.slots && $${params.length}::text[]`);
    }
    // Jarak hanya dihitung antar titik tengah sel grid kedua pihak dan dibulatkan ke km (min. 1).
    const myPoint = me.lat !== null ? `ST_SetSRID(ST_MakePoint(${Number(me.lng)}, ${Number(me.lat)}), 4326)::geography` : 'NULL::geography';
    params.push(BUDDY_RESULTS);
    const { rows } = await this.pool.query<{
      user_id: string;
      display_name: string;
      avatar_key: string | null;
      avatar_updated_at: Date | null;
      pace_s_per_km: number;
      city: string;
      slots: BuddySlot[];
      dist_m: number | null;
      req_status: string | null;
      req_from_me: boolean | null;
    }>(
      `SELECT bp.user_id, u.display_name, u.avatar_key, u.avatar_updated_at, bp.pace_s_per_km, bp.city, bp.slots,
              CASE WHEN bp.area IS NULL THEN NULL ELSE ST_Distance(bp.area, ${myPoint}) END AS dist_m,
              br.status AS req_status, br.from_user = $1 AS req_from_me
         FROM buddy_profiles bp JOIN users u ON u.id = bp.user_id
         LEFT JOIN buddy_requests br ON (br.from_user = $1 AND br.to_user = bp.user_id) OR (br.from_user = bp.user_id AND br.to_user = $1)
        WHERE ${where.join(' AND ')}
        ORDER BY ${q.maxDistanceKm !== undefined ? 'dist_m ASC,' : ''} bp.updated_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return {
      filters: hasBuddyFilters(plan),
      items: rows.map((r) => ({
        userId: r.user_id,
        displayName: r.display_name,
        avatarUrl: avatarPath({ id: r.user_id, avatar_key: r.avatar_key, avatar_updated_at: r.avatar_updated_at }),
        paceSPerKm: r.pace_s_per_km,
        city: r.city,
        slots: r.slots,
        distanceKm: r.dist_m === null || Number.isNaN(Number(r.dist_m)) ? null : Math.max(1, Math.round(Number(r.dist_m) / 1000)),
        connection: connectionStatus(r.req_status, r.req_from_me),
      })),
    };
  }

  // ---------- Sapa ----------

  async sendRequest(userId: string, targetId: string) {
    if (userId === targetId) throw new ApiError(400, 'invalid_target', 'Tidak bisa menyapa diri sendiri');
    const outcome = await withTx(this.pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`buddy:req:${userId}`]);
      const me = await this.myProfile(userId, db);
      if (!me?.enabled) throw new ApiError(403, 'buddy_profile_required', 'Aktifkan profil Cari teman lari dulu');
      // Sasaran harus terlihat di pencarian (profil aktif, akun aktif, tidak ada blokir); selain itu 404.
      const { rowCount } = await db.query(
        `SELECT 1 FROM buddy_profiles bp JOIN users u ON u.id = bp.user_id
          WHERE bp.user_id = $2 AND bp.enabled AND u.status = 'active' AND ${NOT_BLOCKED('bp.user_id')}`,
        [userId, targetId],
      );
      if (!rowCount) throw userNotFound();
      const { rows: existing } = await db.query<{ id: string; from_user: string; status: string }>(
        `SELECT id, from_user, status FROM buddy_requests WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1) FOR UPDATE`,
        [userId, targetId],
      );
      const ex = existing[0];
      if (ex) {
        // Dia sudah menyapa lebih dulu: menyapa balik = menerima.
        if (ex.from_user === targetId && ex.status === 'pending') {
          await db.query(`UPDATE buddy_requests SET status = 'accepted', decided_at = now() WHERE id = $1`, [ex.id]);
          return { id: ex.id, notify: 'accepted' as const };
        }
        return { id: ex.id, notify: null };
      }
      // Batas harian dihitung dari pencacah terpisah (bukan dari baris yang masih ada), agar menghapus sapaan
      // lalu menyapa ulang tidak mengembalikan kuota. Pemanggilan diserialkan oleh advisory lock di atas.
      const dayKey = `buddy:requests:${userId}:${new Date().toISOString().slice(0, 10)}`;
      const used = Number((await this.redis.get(dayKey)) ?? 0);
      if (used >= BUDDY_REQUESTS_PER_DAY) throw new ApiError(429, 'request_rate_limited', `Maksimal ${BUDDY_REQUESTS_PER_DAY} sapaan per hari`);
      const { rows } = await db.query<{ id: string }>(`INSERT INTO buddy_requests (from_user, to_user) VALUES ($1, $2) RETURNING id`, [userId, targetId]);
      await this.redis.multi().incr(dayKey).expire(dayKey, 86_400).exec();
      // Push sapaan ke orang yang sama paling banyak sekali per 24 jam (sapa → batal → sapa tidak membanjiri).
      const fresh = await this.redis.set(`buddy:request-push:${userId}:${targetId}`, '1', 'EX', 86_400, 'NX');
      return { id: rows[0]!.id, notify: fresh ? ('request' as const) : null };
    });
    if (outcome.notify) {
      const l = await this.notifications.labels(userId);
      const accepted = outcome.notify === 'accepted';
      await this.notifications.notify([targetId], {
        category: 'buddy',
        actorId: userId,
        inbox: { type: accepted ? 'buddy_accepted' : 'buddy_request', data: { requestId: outcome.id } },
        push: {
          title: accepted ? 'Sapaan diterima' : 'Ada yang menyapamu',
          body: accepted ? `${l.actor} menerima sapaanmu. Sekarang kalian bisa mengobrol` : `${l.actor} ingin lari bareng (Cari teman lari)`,
          data: { type: accepted ? 'buddy_accepted' : 'buddy_request', requestId: outcome.id },
        },
      });
    }
    return this.connection(userId, targetId);
  }

  async respond(userId: string, requestId: string, accept: boolean) {
    const r = await withTx(this.pool, async (db) => {
      const { rows } = await db.query<{ from_user: string; status: string }>(
        'SELECT from_user, status FROM buddy_requests WHERE id = $1 AND to_user = $2 FOR UPDATE',
        [requestId, userId],
      );
      const row = rows[0];
      if (!row) throw new ApiError(404, 'request_not_found', 'Sapaan tidak ditemukan');
      if (row.status !== 'pending') return { from: row.from_user, changed: false };
      await db.query('UPDATE buddy_requests SET status = $2, decided_at = now() WHERE id = $1', [requestId, accept ? 'accepted' : 'declined']);
      return { from: row.from_user, changed: true };
    });
    // Penolakan tidak diberitahukan (pengirim tetap melihat "terkirim").
    if (r.changed && accept) {
      const l = await this.notifications.labels(userId);
      await this.notifications.notify([r.from], {
        category: 'buddy',
        actorId: userId,
        inbox: { type: 'buddy_accepted', data: { requestId } },
        push: { title: 'Sapaan diterima', body: `${l.actor} menerima sapaanmu. Sekarang kalian bisa mengobrol`, data: { type: 'buddy_accepted', requestId } },
      });
    }
    return this.connection(userId, r.from);
  }

  /**
   * Hapus teman / batalkan sapaan (ke arah mana pun). Sapaan yang DITOLAK tetap tersimpan jika yang menghapus
   * adalah pengirimnya (jawaban tetap sukses, pengirim tidak tahu ditolak): ia tidak bisa menyapa ulang (#225).
   * Penerima tetap bisa menghapusnya.
   */
  async removeConnection(userId: string, otherId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM buddy_requests WHERE ((from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1))
          AND NOT (status = 'declined' AND from_user = $1)`,
      [userId, otherId],
    );
  }

  async requests(userId: string) {
    const { rows } = await this.pool.query<{
      id: string;
      from_user: string;
      to_user: string;
      status: string;
      created_at: Date;
      other_id: string;
      display_name: string;
      avatar_key: string | null;
      avatar_updated_at: Date | null;
      pace_s_per_km: number | null;
      city: string | null;
    }>(
      `SELECT br.id, br.from_user, br.to_user, br.status, br.created_at, o.id AS other_id, o.display_name, o.avatar_key, o.avatar_updated_at,
              bp.pace_s_per_km, bp.city
         FROM buddy_requests br
         JOIN users o ON o.id = CASE WHEN br.from_user = $1 THEN br.to_user ELSE br.from_user END AND o.status = 'active'
         LEFT JOIN buddy_profiles bp ON bp.user_id = o.id
        WHERE (br.from_user = $1 OR (br.to_user = $1 AND br.status <> 'declined')) AND ${NOT_BLOCKED('o.id')}
        ORDER BY br.created_at DESC LIMIT 200`,
      [userId],
    );
    const item = (r: (typeof rows)[number]) => ({
      id: r.id,
      user: { id: r.other_id, displayName: r.display_name, avatarUrl: avatarPath({ id: r.other_id, avatar_key: r.avatar_key, avatar_updated_at: r.avatar_updated_at }) },
      paceSPerKm: r.pace_s_per_km,
      city: r.city,
      createdAt: r.created_at.toISOString(),
      connection: connectionStatus(r.status, r.from_user === userId),
    });
    return {
      incoming: rows.filter((r) => r.to_user === userId && r.status === 'pending').map(item),
      outgoing: rows.filter((r) => r.from_user === userId && r.status !== 'accepted').map(item),
      connected: rows.filter((r) => r.status === 'accepted').map(item),
    };
  }

  private async connection(userId: string, otherId: string) {
    const { rows } = await this.pool.query<{ id: string; status: string; from_me: boolean }>(
      `SELECT id, status, from_user = $1 AS from_me FROM buddy_requests WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)`,
      [userId, otherId],
    );
    return { userId: otherId, requestId: rows[0]?.id ?? null, connection: connectionStatus(rows[0]?.status ?? null, rows[0]?.from_me ?? null) };
  }

  // ---------- Dipakai modul lain ----------

  /** Sapa sudah diterima dan tidak ada blokir: membuka chat pribadi (ChatService). */
  async areConnected(a: string, b: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `SELECT 1 FROM buddy_requests WHERE status = 'accepted' AND ((from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1))
          AND ${NOT_BLOCKED('$2')}`,
      [a, b],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Untuk laporan pengguna dan foto profil: pernah saling sapa, atau [b] muncul di pencarian [a]. */
  async canSee(a: string, b: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ ok: boolean }>(
      `SELECT (EXISTS (SELECT 1 FROM buddy_requests WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1))
           OR (EXISTS (SELECT 1 FROM buddy_profiles WHERE user_id = $1 AND enabled) AND EXISTS (SELECT 1 FROM buddy_profiles WHERE user_id = $2 AND enabled)))
           AND ${NOT_BLOCKED('$2')} AS ok`,
      [a, b],
    );
    return Boolean(rows[0]?.ok);
  }

  async onAccountDeletion(db: Queryable, userId: string): Promise<void> {
    await db.query('DELETE FROM buddy_profiles WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM buddy_requests WHERE from_user = $1 OR to_user = $1', [userId]);
  }

  // ---------- Bantuan ----------

  private async myProfile(userId: string, db: Queryable = this.pool) {
    const { rows } = await db.query<{ enabled: boolean; city: string; lat: number | null; lng: number | null }>(
      'SELECT enabled, city, ST_Y(area::geometry) AS lat, ST_X(area::geometry) AS lng FROM buddy_profiles WHERE user_id = $1',
      [userId],
    );
    return rows[0];
  }

  private async plan(userId: string): Promise<UserPlan> {
    const { rows } = await this.pool.query<{ plan: UserPlan }>('SELECT plan FROM users WHERE id = $1', [userId]);
    return rows[0]?.plan ?? 'free';
  }
}

/** Status hubungan dari sudut pandang penonton. Ditolak tampil "terkirim" ke pengirim (penolakan tidak diumumkan). */
function connectionStatus(status: string | null, fromMe: boolean | null): 'none' | 'sent' | 'received' | 'connected' {
  if (!status) return 'none';
  if (status === 'accepted') return 'connected';
  if (fromMe) return 'sent';
  return status === 'pending' ? 'received' : 'none';
}

function userNotFound() {
  return new ApiError(404, 'user_not_found', 'Pengguna tidak ditemukan');
}
