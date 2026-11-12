import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { audit } from '../admin/admin-auth.service.js';
import { type Queryable, withTx } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { PG_POOL } from '../core.module.js';
import { avatarPath } from '../users/users.repository.js';

/** Kategori jarak event. Sama dengan CHECK di migrasi 0007. */
export const EVENT_CATEGORIES = ['fun', '5k', '10k', 'hm', 'fm', 'ultra', 'other'] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

/**
 * "Hari ini" untuk arsip event, dalam WIB. Event pada tanggal D tampil sampai akhir hari D (WIB)
 * dan diarsipkan mulai D+1. Event di WITA/WIT diarsipkan 1–2 jam setelah tengah malam setempat.
 */
export const TODAY_SQL = `(now() AT TIME ZONE 'Asia/Jakarta')::date`;

/** Maksimal nama "anggota komunitasmu yang ikut" di detail; daftar lengkap lewat /participants. */
const FRIEND_PREVIEW = 5;
const PARTICIPANTS_MAX = 200;

export interface EventInput {
  name: string;
  date: string;
  startTime: string | null;
  city: string;
  venue: string;
  description: string;
  categories: EventCategory[];
  registrationUrl: string;
  /** Nama situs sumber dan halaman resmi (modul 2.4). Null = event manual tim PaceTara. */
  sourceName: string | null;
  sourceUrl: string | null;
}

export type EventOrigin = 'admin' | 'scrape' | 'user';

/** Nama sumber untuk event manual tanpa sumber. */
export const DEFAULT_SOURCE_NAME = 'Tim PaceTara';

interface EventRow {
  id: string;
  name: string;
  date: string;
  start_time: string | null;
  city: string;
  venue: string;
  description: string;
  categories: EventCategory[];
  registration_url: string;
  origin: EventOrigin;
  source_name: string | null;
  source_url: string | null;
  archived: boolean;
  hidden_at: Date | null;
  removed_at: Date | null;
  going_count: string;
  i_am_going: boolean;
  friends_going: string;
}

/**
 * Peserta lain yang terlihat oleh [viewer]: akun aktif yang sama-sama anggota aktif di minimal satu
 * komunitas (yang tidak diturunkan). Dipakai untuk "Siapa ikut?" — orang di luar komunitasmu hanya
 * terhitung di jumlah total, tanpa nama.
 */
const CO_MEMBER = (viewer: string, other: string) => `EXISTS (
  SELECT 1 FROM community_members a
    JOIN community_members b ON b.community_id = a.community_id AND b.user_id = ${other} AND b.status = 'active'
    JOIN communities cm ON cm.id = a.community_id AND cm.removed_at IS NULL
   WHERE a.user_id = ${viewer} AND a.status = 'active')`;

const COLS = (viewer: string) => `e.id, e.name, to_char(e.event_date, 'YYYY-MM-DD') AS date, to_char(e.start_time, 'HH24:MI') AS start_time,
  e.city, e.venue, e.description, e.categories, e.registration_url, e.origin, e.source_name, e.source_url, e.hidden_at, e.removed_at,
  (e.archived_at IS NOT NULL OR e.event_date < ${TODAY_SQL}) AS archived,
  (SELECT count(*) FROM event_participants p JOIN users pu ON pu.id = p.user_id AND pu.status = 'active' WHERE p.event_id = e.id) AS going_count,
  EXISTS (SELECT 1 FROM event_participants p WHERE p.event_id = e.id AND p.user_id = ${viewer}) AS i_am_going,
  (SELECT count(*) FROM event_participants p JOIN users pu ON pu.id = p.user_id AND pu.status = 'active'
    WHERE p.event_id = e.id AND p.user_id <> ${viewer} AND ${CO_MEMBER(viewer, 'p.user_id')}) AS friends_going`;

/**
 * Kalender event (PRD 1.7). Event dimasukkan super admin; semua pengguna Level 1 bisa melihat dan
 * menandai ikut. Event yang diturunkan (laporan) dianggap tidak ada; yang disembunyikan otomatis
 * hilang dari daftar tetapi detailnya masih bisa dibuka (mis. dari kartu chat).
 */
@Injectable()
export class EventsService {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  // ---------- Pengguna ----------

  async list(userId: string, q: { city?: string; month?: string; going?: boolean; limit: number; cursor?: string }) {
    const params: unknown[] = [userId];
    const where = ['e.removed_at IS NULL', 'e.hidden_at IS NULL', 'e.archived_at IS NULL', `e.event_date >= ${TODAY_SQL}`];
    if (q.city) {
      params.push(q.city.trim().toLowerCase());
      where.push(`lower(e.city) = $${params.length}`);
    }
    if (q.month) {
      params.push(`${q.month}-01`);
      where.push(`e.event_date >= $${params.length}::date AND e.event_date < ($${params.length}::date + interval '1 month')`);
    }
    if (q.going) where.push('EXISTS (SELECT 1 FROM event_participants p WHERE p.event_id = e.id AND p.user_id = $1)');
    const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
    if (cursor) {
      params.push(cursor.date, cursor.id);
      where.push(`(e.event_date, e.id) > ($${params.length - 1}::date, $${params.length}::uuid)`);
    }
    params.push(q.limit + 1);
    const { rows } = await this.pool.query<EventRow>(
      `SELECT ${COLS('$1')} FROM events e WHERE ${where.join(' AND ')} ORDER BY e.event_date, e.id LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => this.summary(r)),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.date, last.id) : null,
    };
  }

  /** Kota yang punya event mendatang, untuk filter. */
  async cities(): Promise<{ city: string; events: number }[]> {
    const { rows } = await this.pool.query<{ city: string; n: string }>(
      `SELECT min(city) AS city, count(*) AS n FROM events
        WHERE removed_at IS NULL AND hidden_at IS NULL AND archived_at IS NULL AND event_date >= ${TODAY_SQL}
        GROUP BY lower(city) ORDER BY count(*) DESC, min(city) LIMIT 200`,
    );
    return rows.map((r) => ({ city: r.city, events: Number(r.n) }));
  }

  async detail(userId: string, id: string) {
    const row = await this.visible(this.pool, userId, id);
    const friends = await this.coMembersGoing(userId, id, FRIEND_PREVIEW);
    return {
      ...this.summary(row),
      description: row.description,
      registrationUrl: row.registration_url,
      source: source(row),
      friendsPreview: friends,
    };
  }

  async setGoing(userId: string, id: string, going: boolean) {
    const row = await this.visible(this.pool, userId, id);
    if (row.archived) throw new ApiError(409, 'event_archived', 'Event ini sudah lewat');
    if (going) {
      await this.pool.query('INSERT INTO event_participants (event_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, userId]);
    } else {
      await this.pool.query('DELETE FROM event_participants WHERE event_id = $1 AND user_id = $2', [id, userId]);
    }
    return this.detail(userId, id);
  }

  /** "Siapa ikut?": hanya sesama anggota aktif komunitas pengguna, beserta nama komunitas bersama. */
  async participants(userId: string, id: string) {
    await this.visible(this.pool, userId, id);
    const items = await this.coMembersGoing(userId, id, PARTICIPANTS_MAX);
    return { items };
  }

  /** Untuk kartu chat: ringkasan event yang masih ada (tidak diturunkan). */
  async cards(ids: string[]): Promise<Map<string, ReturnType<EventsService['card']>>> {
    const out = new Map<string, ReturnType<EventsService['card']>>();
    if (!ids.length) return out;
    const { rows } = await this.pool.query<Pick<EventRow, 'id' | 'name' | 'date' | 'start_time' | 'city' | 'categories' | 'archived'>>(
      `SELECT e.id, e.name, to_char(e.event_date, 'YYYY-MM-DD') AS date, to_char(e.start_time, 'HH24:MI') AS start_time, e.city, e.categories,
              (e.archived_at IS NOT NULL OR e.event_date < ${TODAY_SQL}) AS archived
         FROM events e WHERE e.id = ANY($1::uuid[]) AND e.removed_at IS NULL`,
      [ids],
    );
    for (const r of rows) out.set(r.id, this.card(r));
    return out;
  }

  /** Nama event untuk dibagikan ke chat; 404 jika tidak ada/diturunkan. */
  async nameForShare(id: string): Promise<string> {
    const { rows } = await this.pool.query<{ name: string }>('SELECT name FROM events WHERE id = $1 AND removed_at IS NULL', [id]);
    if (!rows[0]) throw notFound();
    return rows[0].name;
  }

  /** Untuk laporan: event ada dan tidak diturunkan. */
  async assertExists(id: string): Promise<void> {
    await this.nameForShare(id);
  }

  /**
   * Hapus akun: tanda "ikut" dihapus. Kiriman event (modul 2.4) yang belum ditinjau dihapus; yang sudah
   * ditinjau dianonimkan (pengirim dan kontak penyelenggara dikosongkan). Event yang sudah tayang tetap.
   */
  async onAccountDeletion(db: Queryable, userId: string): Promise<void> {
    await db.query('DELETE FROM event_participants WHERE user_id = $1', [userId]);
    await db.query(`DELETE FROM event_submissions WHERE submitted_by = $1 AND status = 'pending'`, [userId]);
    await db.query('UPDATE event_submissions SET submitted_by = NULL, organizer_contact_enc = NULL WHERE submitted_by = $1', [userId]);
  }

  // ---------- Super admin ----------

  async adminList(scope: 'upcoming' | 'past') {
    const { rows } = await this.pool.query<EventRow & { created_at: Date; updated_at: Date; created_by_name: string | null }>(
      `SELECT ${COLS('NULL::uuid')}, e.created_at, e.updated_at, u.display_name AS created_by_name
         FROM events e LEFT JOIN users u ON u.id = e.created_by
        WHERE ${scope === 'upcoming' ? `e.event_date >= ${TODAY_SQL}` : `e.event_date < ${TODAY_SQL}`}
        ORDER BY e.event_date ${scope === 'upcoming' ? 'ASC' : 'DESC'}, e.id LIMIT 500`,
    );
    return rows.map((r) => ({
      ...this.summary(r),
      description: r.description,
      registrationUrl: r.registration_url,
      origin: r.origin,
      sourceName: r.source_name,
      sourceUrl: r.source_url,
      source: source(r),
      hidden: Boolean(r.hidden_at),
      removed: Boolean(r.removed_at),
      createdBy: r.created_by_name,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    }));
  }

  async create(adminId: string, input: EventInput) {
    return withTx(this.pool, async (db) => {
      const id = await this.insertEvent(db, adminId, input, 'admin');
      await audit(db, adminId, 'event.create', { type: 'event', id }, { name: input.name, date: input.date });
      return { id };
    });
  }

  /** Tulis event yang tayang (manual atau hasil persetujuan antrean). 409 event_exists jika nama+tanggal sudah ada. */
  async insertEvent(db: Queryable, createdBy: string, input: EventInput, origin: EventOrigin): Promise<string> {
    const { rows } = await db
      .query<{ id: string }>(
        `INSERT INTO events (name, event_date, start_time, city, venue, description, categories, registration_url, created_by, origin, source_name, source_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [
          input.name,
          input.date,
          input.startTime,
          input.city,
          input.venue,
          input.description,
          input.categories,
          input.registrationUrl,
          createdBy,
          origin,
          input.sourceName,
          input.sourceUrl,
        ],
      )
      .catch(duplicate);
    return rows[0]!.id;
  }

  /** Ubah event. Mengubah tanggal ke masa depan membatalkan arsip. */
  async update(adminId: string, id: string, input: EventInput) {
    await withTx(this.pool, async (db) => {
      const { rowCount } = await db
        .query(
          `UPDATE events SET name = $2, event_date = $3, start_time = $4, city = $5, venue = $6, description = $7,
                  categories = $8, registration_url = $9, source_name = $10, source_url = $11, updated_at = now(),
                  archived_at = CASE WHEN $3::date >= ${TODAY_SQL} THEN NULL ELSE archived_at END
            WHERE id = $1`,
          [
            id,
            input.name,
            input.date,
            input.startTime,
            input.city,
            input.venue,
            input.description,
            input.categories,
            input.registrationUrl,
            input.sourceName,
            input.sourceUrl,
          ],
        )
        .catch(duplicate);
      if (!rowCount) throw notFound();
      await audit(db, adminId, 'event.update', { type: 'event', id }, { name: input.name, date: input.date });
    });
  }

  /** Hapus event yang salah input. Tanda ikut ikut terhapus; kartu chat menjadi "Event tidak tersedia". */
  async remove(adminId: string, id: string) {
    await withTx(this.pool, async (db) => {
      const { rows } = await db.query<{ name: string }>('DELETE FROM events WHERE id = $1 RETURNING name', [id]);
      if (!rows[0]) throw notFound();
      await audit(db, adminId, 'event.delete', { type: 'event', id }, { name: rows[0].name });
    });
  }

  // ---------- Bantuan ----------

  private async visible(db: Queryable, userId: string, id: string): Promise<EventRow> {
    const { rows } = await db.query<EventRow>(`SELECT ${COLS('$2')} FROM events e WHERE e.id = $1 AND e.removed_at IS NULL`, [id, userId]);
    if (!rows[0]) throw notFound();
    return rows[0];
  }

  private async coMembersGoing(userId: string, eventId: string, limit: number) {
    const { rows } = await this.pool.query<{
      id: string;
      display_name: string;
      avatar_key: string | null;
      avatar_updated_at: Date | null;
      communities: string[];
    }>(
      `SELECT u.id, u.display_name, u.avatar_key, u.avatar_updated_at,
              ARRAY(SELECT cm.name FROM community_members a
                      JOIN community_members b ON b.community_id = a.community_id AND b.user_id = u.id AND b.status = 'active'
                      JOIN communities cm ON cm.id = a.community_id AND cm.removed_at IS NULL
                     WHERE a.user_id = $1 AND a.status = 'active' ORDER BY cm.name LIMIT 3) AS communities
         FROM event_participants p JOIN users u ON u.id = p.user_id AND u.status = 'active'
        WHERE p.event_id = $2 AND p.user_id <> $1 AND ${CO_MEMBER('$1', 'p.user_id')}
        ORDER BY p.created_at LIMIT $3`,
      [userId, eventId, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      avatarUrl: avatarPath({ id: r.id, avatar_key: r.avatar_key, avatar_updated_at: r.avatar_updated_at }),
      communities: r.communities,
    }));
  }

  private summary(r: EventRow) {
    return {
      ...this.card(r),
      venue: r.venue,
      goingCount: Number(r.going_count),
      iAmGoing: r.i_am_going,
      friendsGoing: Number(r.friends_going),
    };
  }

  private card(r: Pick<EventRow, 'id' | 'name' | 'date' | 'start_time' | 'city' | 'categories' | 'archived'>) {
    return { id: r.id, name: r.name, date: r.date, startTime: r.start_time, city: r.city, categories: r.categories, archived: r.archived };
  }
}

/** "Sumber: <nama> · Lihat halaman resmi" — selalu ada (PRD 2.4). */
function source(r: Pick<EventRow, 'origin' | 'source_name' | 'source_url' | 'registration_url'>) {
  return { origin: r.origin, name: r.source_name ?? DEFAULT_SOURCE_NAME, url: r.source_url ?? r.registration_url };
}

function notFound() {
  return new ApiError(404, 'event_not_found', 'Event tidak ditemukan');
}

function duplicate(err: unknown): never {
  if ((err as { code?: string }).code === '23505') throw new ApiError(409, 'event_exists', 'Event dengan nama dan tanggal yang sama sudah ada');
  throw err;
}

function encodeCursor(date: string, id: string) {
  return Buffer.from(`${date}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { date: string; id: string } | undefined {
  const [date, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!date || !id || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[0-9a-f-]{36}$/.test(id)) return undefined;
  return { date, id };
}
