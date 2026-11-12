import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { type Queryable, withTx } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { PG_POOL, REDIS } from '../core.module.js';
import { CommunitiesService } from '../communities/communities.service.js';
import { TODAY_SQL } from '../events/events.service.js';
import { limitInfo, MEDAL_LIMIT, type UserPlan } from '../plans/plans.js';
import { processImage } from '../storage/image.js';
import { StorageService } from '../storage/storage.service.js';
import { BadgesService } from './badges.service.js';

export type PassportVisibility = 'community' | 'private';
export type EventCategory = 'fun' | '5k' | '10k' | 'hm' | 'fm' | 'ultra' | 'other';

/** Batas unggah foto medali per pengguna per 24 jam (di samping batas laju per menit di controller). */
export const MEDAL_UPLOADS_PER_DAY = 20;
/** Batas wajar jumlah hasil resmi (bukan batas paket; mencegah penyalahgunaan penyimpanan). */
export const MAX_RESULTS = 500;
/** Batas wajar jumlah medali untuk paket tanpa batas. */
export const MAX_MEDALS_HARD = 1000;

export const CATEGORY_DISTANCE_M: Partial<Record<EventCategory, number>> = { '5k': 5000, '10k': 10_000, hm: 21_097, fm: 42_195 };

export interface MedalInput {
  title: string;
  eventId?: string;
  eventDate?: string;
  category?: EventCategory;
}

export interface ResultInput {
  eventId?: string;
  eventName?: string;
  eventDate?: string;
  category: EventCategory;
  distanceM?: number | null;
  officialTimeS: number;
}

interface MedalRow {
  id: string;
  title: string;
  event_id: string | null;
  event_date: string | null;
  category: EventCategory | null;
  created_at: Date;
}

interface ResultRow {
  id: string;
  event_id: string | null;
  event_name: string;
  event_date: string;
  category: EventCategory;
  distance_m: number | null;
  official_time_s: number;
}

const MEDAL_COLS = `id, title, event_id, to_char(event_date, 'YYYY-MM-DD') AS event_date, category, created_at`;
const RESULT_COLS = `id, event_id, event_name, to_char(event_date, 'YYYY-MM-DD') AS event_date, category, distance_m, official_time_s`;

const notFound = () => new ApiError(404, 'passport_not_found', 'Paspor lari tidak ditemukan');

/**
 * Paspor lari: rak medali (foto medali fisik), hasil resmi event, dan lencana pencapaian.
 * Pemilik memilih siapa yang boleh melihat (community/private); yang tidak berhak mendapat 404.
 */
@Injectable()
export class PassportService {
  private readonly logger = new Logger('Passport');

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly storage: StorageService,
    private readonly communities: CommunitiesService,
    private readonly badges: BadgesService,
  ) {}

  /** Paspor sendiri. Lencana untuk lari lama diisi di sini (idempoten, tanpa notifikasi). */
  async mine(userId: string) {
    await this.badges.evaluate(userId, { notify: false });
    const { rows } = await this.pool.query<{ plan: UserPlan; passport_visibility: PassportVisibility }>(
      'SELECT plan, passport_visibility FROM users WHERE id = $1',
      [userId],
    );
    const medals = await this.medals(userId);
    return {
      userId,
      isMe: true,
      visibility: rows[0]?.passport_visibility ?? 'community',
      medalLimit: limitInfo(MEDAL_LIMIT[rows[0]?.plan ?? 'free'], medals.length),
      medals,
      results: await this.results(userId),
      badges: await this.badges.list(userId, false),
    };
  }

  /** Paspor pengguna lain. 404 jika tidak berhak (privat, bukan sesama anggota komunitas, blokir, akun nonaktif). */
  async ofUser(viewerId: string, ownerId: string) {
    if (viewerId === ownerId) return this.mine(viewerId);
    const owner = await this.assertCanView(viewerId, ownerId);
    return {
      userId: ownerId,
      displayName: owner.display_name,
      isMe: false,
      medals: await this.medals(ownerId),
      results: await this.results(ownerId),
      badges: await this.badges.list(ownerId, true),
    };
  }

  async setVisibility(userId: string, visibility: PassportVisibility) {
    await this.pool.query('UPDATE users SET passport_visibility = $2 WHERE id = $1', [userId, visibility]);
    return { visibility };
  }

  // ---------- Medali ----------

  async addMedal(userId: string, input: MedalInput, file: Buffer) {
    // Kuota dipesan dulu (INCR atomik) lalu dikembalikan bila gagal, agar permintaan bersamaan tidak melewati batas.
    const dayKey = `medal:day:${userId}`;
    const used = await this.redis.incr(dayKey);
    if (used === 1) await this.redis.expire(dayKey, 86_400);
    try {
      if (used > MEDAL_UPLOADS_PER_DAY) {
        throw new ApiError(429, 'medal_rate_limited', `Maksimal ${MEDAL_UPLOADS_PER_DAY} unggahan medali per hari`);
      }
      return await this.storeMedal(userId, input, file);
    } catch (err) {
      await this.redis.decr(dayKey).catch(() => undefined);
      throw err;
    }
  }

  private async storeMedal(userId: string, input: MedalInput, file: Buffer) {
    const event = input.eventId ? await this.joinedEvent(this.pool, userId, input.eventId) : null;
    const eventDate = event?.event_date ?? input.eventDate ?? null;
    if (eventDate && !event) await this.assertPastDate(eventDate);

    // Cek batas lebih awal agar tidak memproses gambar sia-sia; ditegakkan lagi di transaksi.
    await this.assertMedalRoom(this.pool, userId, false);

    // Gambar diproses (cek isi, EXIF/GPS dibuang) sebelum apa pun disimpan.
    const webp = await processImage(file, { size: 1600 });
    const id = randomUUID();
    const key = `passport/${userId}/${id}.webp`;
    await this.storage.put(key, webp, 'image/webp');
    try {
      await withTx(this.pool, async (db) => {
        await this.assertMedalRoom(db, userId, true);
        await db.query(
          `INSERT INTO passport_medals (id, user_id, title, event_id, event_date, category, storage_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, userId, input.title, event?.id ?? null, eventDate, input.category ?? null, key],
        );
      });
    } catch (err) {
      await this.storage.delete(key).catch(() => undefined);
      throw err;
    }
    const { rows } = await this.pool.query<MedalRow>(`SELECT ${MEDAL_COLS} FROM passport_medals WHERE id = $1`, [id]);
    return this.medalJson(rows[0]!);
  }

  async removeMedal(userId: string, medalId: string): Promise<void> {
    const { rows } = await this.pool.query<{ storage_key: string }>(
      'DELETE FROM passport_medals WHERE id = $1 AND user_id = $2 RETURNING storage_key',
      [medalId, userId],
    );
    if (!rows[0]) throw new ApiError(404, 'medal_not_found', 'Medali tidak ditemukan');
    await this.deleteObjects(rows.map((r) => r.storage_key));
  }

  async medalPhoto(viewerId: string, medalId: string) {
    const { rows } = await this.pool.query<{ user_id: string; storage_key: string }>(
      'SELECT user_id, storage_key FROM passport_medals WHERE id = $1',
      [medalId],
    );
    const m = rows[0];
    if (!m) return undefined;
    if (m.user_id !== viewerId) {
      try {
        await this.assertCanView(viewerId, m.user_id);
      } catch {
        return undefined;
      }
    }
    return this.storage.get(m.storage_key);
  }

  // ---------- Hasil resmi ----------

  async addResult(userId: string, input: ResultInput) {
    return withTx(this.pool, async (db) => {
      await db.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const { rows: c } = await db.query<{ n: string }>('SELECT count(*) AS n FROM passport_results WHERE user_id = $1', [userId]);
      if (Number(c[0]!.n) >= MAX_RESULTS) throw new ApiError(409, 'result_limit', `Maksimal ${MAX_RESULTS} hasil`);
      const v = await this.resolveResult(db, userId, input);
      try {
        const { rows } = await db.query<ResultRow>(
          `INSERT INTO passport_results (user_id, event_id, event_name, event_date, category, distance_m, official_time_s)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${RESULT_COLS}`,
          [userId, v.eventId, v.eventName, v.eventDate, input.category, v.distanceM, input.officialTimeS],
        );
        return this.resultJson(rows[0]!);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new ApiError(409, 'result_exists', 'Hasil untuk event ini sudah ada');
        throw err;
      }
    });
  }

  async updateResult(userId: string, resultId: string, patch: Partial<Pick<ResultInput, 'category' | 'distanceM' | 'officialTimeS'>>) {
    const { rows: cur } = await this.pool.query<ResultRow>(`SELECT ${RESULT_COLS} FROM passport_results WHERE id = $1 AND user_id = $2`, [
      resultId,
      userId,
    ]);
    const r = cur[0];
    if (!r) throw new ApiError(404, 'result_not_found', 'Hasil tidak ditemukan');
    const category = patch.category ?? r.category;
    const distanceM = patch.distanceM !== undefined ? patch.distanceM : patch.category ? (CATEGORY_DISTANCE_M[category] ?? r.distance_m) : r.distance_m;
    const { rows } = await this.pool.query<ResultRow>(
      `UPDATE passport_results SET category = $3, distance_m = $4, official_time_s = $5
        WHERE id = $1 AND user_id = $2 RETURNING ${RESULT_COLS}`,
      [resultId, userId, category, distanceM, patch.officialTimeS ?? r.official_time_s],
    );
    return this.resultJson(rows[0]!);
  }

  async removeResult(userId: string, resultId: string): Promise<void> {
    const { rowCount } = await this.pool.query('DELETE FROM passport_results WHERE id = $1 AND user_id = $2', [resultId, userId]);
    if (!rowCount) throw new ApiError(404, 'result_not_found', 'Hasil tidak ditemukan');
  }

  /** Event yang ditandai ikut dan sudah berlangsung (termasuk yang diarsipkan), untuk ditautkan ke paspor. */
  async joinedEvents(userId: string) {
    const { rows } = await this.pool.query<{ id: string; name: string; event_date: string; city: string; categories: string[]; has_result: boolean }>(
      `SELECT e.id, e.name, to_char(e.event_date, 'YYYY-MM-DD') AS event_date, e.city, e.categories,
              EXISTS (SELECT 1 FROM passport_results r WHERE r.user_id = $1 AND r.event_id = e.id) AS has_result
         FROM event_participants p JOIN events e ON e.id = p.event_id
        WHERE p.user_id = $1 AND e.removed_at IS NULL AND e.event_date <= ${TODAY_SQL}
        ORDER BY e.event_date DESC LIMIT 200`,
      [userId],
    );
    return {
      items: rows.map((e) => ({ id: e.id, name: e.name, eventDate: e.event_date, city: e.city, categories: e.categories, hasResult: e.has_result })),
    };
  }

  /** Hapus akun: medali (beserta foto), hasil, dan lencana dihapus. Mengembalikan kunci foto. */
  async onAccountDeletion(db: Queryable, userId: string): Promise<string[]> {
    const { rows } = await db.query<{ storage_key: string }>('DELETE FROM passport_medals WHERE user_id = $1 RETURNING storage_key', [userId]);
    await db.query('DELETE FROM passport_results WHERE user_id = $1', [userId]);
    await this.badges.onAccountDeletion(db, userId);
    return rows.map((r) => r.storage_key);
  }

  // ---------- Bantuan ----------

  private async assertCanView(viewerId: string, ownerId: string) {
    const { rows } = await this.pool.query<{ display_name: string; passport_visibility: PassportVisibility; blocked: boolean }>(
      `SELECT u.display_name, u.passport_visibility,
              EXISTS (SELECT 1 FROM feed_blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $1)) AS blocked
         FROM users u WHERE u.id = $2 AND u.status = 'active'`,
      [viewerId, ownerId],
    );
    const o = rows[0];
    if (!o || o.blocked || o.passport_visibility !== 'community') throw notFound();
    if (!(await this.communities.shareCommunity(viewerId, ownerId))) throw notFound();
    return o;
  }

  /** Batas medali paket (pola #43: dalam transaksi dengan kunci baris pengguna). */
  private async assertMedalRoom(db: Queryable, userId: string, lock: boolean) {
    const { rows } = await db.query<{ plan: UserPlan }>(`SELECT plan FROM users WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [userId]);
    const max = MEDAL_LIMIT[rows[0]?.plan ?? 'free'];
    const { rows: c } = await db.query<{ n: string }>('SELECT count(*) AS n FROM passport_medals WHERE user_id = $1', [userId]);
    const used = Number(c[0]!.n);
    if (max !== null && used >= max) {
      throw new ApiError(403, 'limit_reached', `Rak medali paket gratis maksimal ${max} medali. Upgrade ke Premium untuk menambah tanpa batas`, {
        limit: { kind: 'medals', max },
      });
    }
    if (used >= MAX_MEDALS_HARD) throw new ApiError(409, 'medal_hard_limit', `Maksimal ${MAX_MEDALS_HARD} medali`);
  }

  /** Event kalender yang ditandai ikut oleh pengguna, tidak diturunkan, dan sudah berlangsung. */
  private async joinedEvent(db: Queryable, userId: string, eventId: string) {
    const { rows } = await db.query<{ id: string; name: string; event_date: string }>(
      `SELECT e.id, e.name, to_char(e.event_date, 'YYYY-MM-DD') AS event_date
         FROM events e JOIN event_participants p ON p.event_id = e.id AND p.user_id = $2
        WHERE e.id = $1 AND e.removed_at IS NULL AND e.event_date <= ${TODAY_SQL}`,
      [eventId, userId],
    );
    if (!rows[0]) {
      throw new ApiError(409, 'event_not_joined', 'Hanya event yang kamu tandai ikut dan sudah berlangsung yang bisa ditautkan');
    }
    return rows[0];
  }

  private async assertPastDate(date: string) {
    const { rows } = await this.pool.query<{ ok: boolean }>(`SELECT $1::date <= ${TODAY_SQL} AND $1::date >= '1970-01-01' AS ok`, [date]);
    if (!rows[0]?.ok) throw new ApiError(400, 'invalid_date', 'Tanggal event tidak boleh di masa depan');
  }

  private async resolveResult(db: Queryable, userId: string, input: ResultInput) {
    const distanceM = input.distanceM ?? CATEGORY_DISTANCE_M[input.category] ?? null;
    if (input.eventId) {
      const e = await this.joinedEvent(db, userId, input.eventId);
      return { eventId: e.id, eventName: e.name, eventDate: e.event_date, distanceM };
    }
    if (!input.eventName || !input.eventDate) throw new ApiError(400, 'invalid_input', 'Nama dan tanggal event wajib diisi');
    await this.assertPastDate(input.eventDate);
    return { eventId: null, eventName: input.eventName, eventDate: input.eventDate, distanceM };
  }

  private async medals(userId: string) {
    const { rows } = await this.pool.query<MedalRow>(`SELECT ${MEDAL_COLS} FROM passport_medals WHERE user_id = $1 ORDER BY event_date DESC NULLS LAST, created_at DESC`, [
      userId,
    ]);
    return rows.map((m) => this.medalJson(m));
  }

  private async results(userId: string) {
    const { rows } = await this.pool.query<ResultRow>(`SELECT ${RESULT_COLS} FROM passport_results WHERE user_id = $1 ORDER BY event_date DESC, created_at DESC`, [
      userId,
    ]);
    return rows.map((r) => this.resultJson(r));
  }

  private medalJson(m: MedalRow) {
    return {
      id: m.id,
      title: m.title,
      eventId: m.event_id,
      eventDate: m.event_date,
      category: m.category,
      photoUrl: `/v1/passport/medals/${m.id}/photo`,
      createdAt: m.created_at.toISOString(),
    };
  }

  private resultJson(r: ResultRow) {
    return {
      id: r.id,
      eventId: r.event_id,
      eventName: r.event_name,
      eventDate: r.event_date,
      category: r.category,
      distanceM: r.distance_m,
      officialTimeS: r.official_time_s,
      avgPaceSPerKm: r.distance_m ? Math.round((r.official_time_s * 1000) / r.distance_m) : null,
    };
  }

  private async deleteObjects(keys: string[]) {
    for (const k of keys) await this.storage.delete(k).catch(() => this.logger.warn('Gagal menghapus foto medali'));
  }
}
