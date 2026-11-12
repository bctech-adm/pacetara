import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { audit } from '../admin/admin-auth.service.js';
import { type Queryable, withTx } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { PG_POOL } from '../core.module.js';
import { NotificationsService } from '../notifications/notifications.service.js';

/** Kiriman spot per pengguna per 24 jam (dihitung di database di bawah advisory lock, pola #180). */
export const SPOTS_PER_DAY = 5;
/** Hasil peta maksimum per permintaan. */
export const SPOT_RESULTS = 200;
/** Kotak peta maks. ±1° (±110 km) agar satu permintaan tidak menyapu seluruh Indonesia. */
export const MAX_BBOX_DEG = 1;

export interface SpotInput {
  name: string;
  city: string;
  point: { lat: number; lng: number };
  lighting?: 0 | 1 | 2 | null;
  toilet?: boolean | null;
  parking?: boolean | null;
  notes?: string;
}

interface SpotRow {
  id: string;
  name: string;
  city: string;
  lat: number;
  lng: number;
  lighting: number | null;
  toilet: boolean | null;
  parking: boolean | null;
  notes: string;
  status: 'pending' | 'approved' | 'rejected';
  reject_reason: string | null;
  created_at: Date;
  submitted_by?: string | null;
}

const COLS = `s.id, s.name, s.city, ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lng, s.lighting, s.toilet, s.parking,
  s.notes, s.status, s.reject_reason, s.created_at`;

/**
 * Peta spot lari lokal (modul 2.6). Spot dikirim pengguna Level 1, masuk antrean, dan baru tayang setelah disetujui
 * super admin (pola 2.4: konten publik di peta + titik yang bisa saja rumah seseorang). Spot tayang terlihat semua
 * pengguna Level 1; pengirim tidak ditampilkan. Bisa dilaporkan (sasaran `spot`): 3 pelapor = disembunyikan, turunkan
 * = removed_at.
 */
@Injectable()
export class SpotsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly notifications: NotificationsService,
  ) {}

  /** Spot tayang di kotak peta. Lokasi area peta dikirim di body (bukan URL). */
  async inBox(box: { minLat: number; minLng: number; maxLat: number; maxLng: number }) {
    if (box.maxLat <= box.minLat || box.maxLng <= box.minLng) throw new ApiError(400, 'invalid_bbox', 'Area peta tidak valid');
    if (box.maxLat - box.minLat > MAX_BBOX_DEG || box.maxLng - box.minLng > MAX_BBOX_DEG) {
      throw new ApiError(400, 'bbox_too_large', 'Perbesar peta untuk melihat spot');
    }
    const { rows } = await this.pool.query<SpotRow>(
      `SELECT ${COLS} FROM run_spots s
        WHERE s.status = 'approved' AND s.removed_at IS NULL AND s.hidden_at IS NULL
          AND s.location && ST_MakeEnvelope($1, $2, $3, $4, 4326)::geography
        ORDER BY s.created_at DESC LIMIT ${SPOT_RESULTS}`,
      [box.minLng, box.minLat, box.maxLng, box.maxLat],
    );
    return { items: rows.map(spotJson), truncated: rows.length >= SPOT_RESULTS };
  }

  /** Spot tayang terdekat dari sebuah titik (mis. titik kumpul / posisi peta), maks. [radiusKm]. */
  async near(p: { lat: number; lng: number }, radiusKm: number) {
    const { rows } = await this.pool.query<SpotRow & { dist_m: number }>(
      `SELECT ${COLS}, ST_Distance(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS dist_m FROM run_spots s
        WHERE s.status = 'approved' AND s.removed_at IS NULL AND s.hidden_at IS NULL
          AND ST_DWithin(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
        ORDER BY dist_m LIMIT 50`,
      [p.lng, p.lat, radiusKm * 1000],
    );
    return { items: rows.map((r) => ({ ...spotJson(r), distanceM: Math.round(Number(r.dist_m)) })) };
  }

  async detail(userId: string, spotId: string) {
    const { rows } = await this.pool.query<SpotRow>(
      `SELECT ${COLS}, s.submitted_by FROM run_spots s
        WHERE s.id = $1 AND s.removed_at IS NULL AND ((s.status = 'approved' AND s.hidden_at IS NULL) OR s.submitted_by = $2)`,
      [spotId, userId],
    );
    if (!rows[0]) throw spotNotFound();
    return { ...spotJson(rows[0]), mine: rows[0].submitted_by === userId };
  }

  async submit(userId: string, input: SpotInput) {
    const id = await withTx(this.pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`spot:${userId}`]);
      const { rows: n } = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM run_spots WHERE submitted_by = $1 AND created_at > now() - interval '24 hours'`,
        [userId],
      );
      if (Number(n[0]!.n) >= SPOTS_PER_DAY) throw new ApiError(429, 'spot_limit', `Maksimal ${SPOTS_PER_DAY} kiriman spot per hari`);
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO run_spots (submitted_by, name, city, location, lighting, toilet, parking, notes)
         VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($5, $4), 4326)::geography, $6, $7, $8, $9) RETURNING id`,
        [
          userId,
          input.name,
          input.city,
          round5(input.point.lat),
          round5(input.point.lng),
          input.lighting ?? null,
          input.toilet ?? null,
          input.parking ?? null,
          input.notes ?? '',
        ],
      );
      return rows[0]!.id;
    });
    return this.detail(userId, id);
  }

  async mine(userId: string) {
    const { rows } = await this.pool.query<SpotRow>(
      `SELECT ${COLS} FROM run_spots s WHERE s.submitted_by = $1 AND s.removed_at IS NULL ORDER BY s.created_at DESC LIMIT 100`,
      [userId],
    );
    return { items: rows.map((r) => ({ ...spotJson(r), status: r.status, rejectReason: r.reject_reason })) };
  }

  /** Pengirim boleh menarik kiriman yang belum ditinjau. */
  async withdraw(userId: string, spotId: string): Promise<void> {
    const { rowCount } = await this.pool.query(`DELETE FROM run_spots WHERE id = $1 AND submitted_by = $2 AND status = 'pending'`, [spotId, userId]);
    if (!rowCount) throw spotNotFound();
  }

  /** Untuk laporan: hanya spot yang terlihat pelapor. */
  async reportable(userId: string, spotId: string): Promise<{ submittedBy: string | null }> {
    const { rows } = await this.pool.query<{ submitted_by: string | null }>(
      `SELECT submitted_by FROM run_spots WHERE id = $1 AND removed_at IS NULL AND status = 'approved' AND (hidden_at IS NULL OR submitted_by = $2)`,
      [spotId, userId],
    );
    if (!rows[0]) throw spotNotFound();
    return { submittedBy: rows[0].submitted_by };
  }

  // ---------- Panel super admin ----------

  async adminList(status: 'pending' | 'approved' | 'rejected') {
    const { rows } = await this.pool.query<SpotRow & { submitter: string | null; hidden: boolean; nearby: string }>(
      `SELECT ${COLS}, u.display_name AS submitter, s.hidden_at IS NOT NULL AS hidden,
              (SELECT count(*) FROM run_spots o WHERE o.id <> s.id AND o.status = 'approved' AND o.removed_at IS NULL
                  AND ST_DWithin(o.location, s.location, 150)) AS nearby
         FROM run_spots s LEFT JOIN users u ON u.id = s.submitted_by
        WHERE s.status = $1 AND s.removed_at IS NULL ORDER BY s.created_at ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT 200`,
      [status],
    );
    return {
      items: rows.map((r) => ({
        ...spotJson(r),
        status: r.status,
        rejectReason: r.reject_reason,
        submitter: r.submitter,
        hidden: r.hidden,
        // Spot tayang lain dalam 150 m: kemungkinan duplikat.
        nearbyApproved: Number(r.nearby),
      })),
    };
  }

  async approve(adminId: string, spotId: string, patch: Partial<SpotInput>) {
    const s = await withTx(this.pool, async (db) => {
      const row = await this.pendingForUpdate(db, spotId);
      const sets = [`status = 'approved'`, 'reviewed_by = $2', 'reviewed_at = now()'];
      const values: unknown[] = [spotId, adminId];
      const add = (col: string, v: unknown) => {
        values.push(v);
        sets.push(`${col} = $${values.length}`);
      };
      if (patch.name !== undefined) add('name', patch.name);
      if (patch.city !== undefined) add('city', patch.city);
      if (patch.lighting !== undefined) add('lighting', patch.lighting);
      if (patch.toilet !== undefined) add('toilet', patch.toilet);
      if (patch.parking !== undefined) add('parking', patch.parking);
      if (patch.notes !== undefined) add('notes', patch.notes);
      if (patch.point) {
        values.push(round5(patch.point.lng), round5(patch.point.lat));
        sets.push(`location = ST_SetSRID(ST_MakePoint($${values.length - 1}, $${values.length}), 4326)::geography`);
      }
      await db.query(`UPDATE run_spots SET ${sets.join(', ')} WHERE id = $1`, values);
      await audit(db, adminId, 'spot.approve', { type: 'spot', id: spotId }, { name: patch.name ?? row.name, city: patch.city ?? row.city });
      return row;
    });
    if (s.submitted_by) {
      await this.notifications.notify([s.submitted_by], {
        category: 'event',
        inbox: { type: 'spot_approved', data: { spotId } },
        push: { title: 'Spot lari disetujui', body: `${patch.name ?? s.name} sudah tampil di peta`, data: { type: 'spot_approved', spotId } },
      });
    }
    return { id: spotId, status: 'approved' };
  }

  async reject(adminId: string, spotId: string, reason: string): Promise<void> {
    const s = await withTx(this.pool, async (db) => {
      const row = await this.pendingForUpdate(db, spotId);
      await db.query(`UPDATE run_spots SET status = 'rejected', reject_reason = $3, reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [spotId, adminId, reason]);
      await audit(db, adminId, 'spot.reject', { type: 'spot', id: spotId }, { name: row.name, reason });
      return row;
    });
    if (s.submitted_by) {
      await this.notifications.notify([s.submitted_by], {
        category: 'event',
        inbox: { type: 'spot_rejected', data: { spotId } },
        push: { title: 'Spot lari tidak disetujui', body: `Kiriman ${s.name} tidak disetujui. Lihat alasannya di aplikasi`, data: { type: 'spot_rejected', spotId } },
      });
    }
  }

  /** Ringkasan untuk antrean laporan panel. */
  async adminSummary(spotId: string) {
    const { rows } = await this.pool.query<SpotRow & { submitter: string | null; hidden_at: Date | null; removed_at: Date | null }>(
      `SELECT ${COLS}, u.display_name AS submitter, s.hidden_at, s.removed_at FROM run_spots s LEFT JOIN users u ON u.id = s.submitted_by WHERE s.id = $1`,
      [spotId],
    );
    const r = rows[0];
    if (!r) return null;
    return { ...spotJson(r), status: r.status, submitter: r.submitter, hidden: Boolean(r.hidden_at), removed: Boolean(r.removed_at) };
  }

  /**
   * Hapus akun: kiriman yang belum ditinjau/ditolak dihapus; spot yang sudah tayang tetap (informasi tempat umum)
   * dan dilepas dari akun.
   */
  async onAccountDeletion(db: Queryable, userId: string): Promise<void> {
    await db.query(`DELETE FROM run_spots WHERE submitted_by = $1 AND status <> 'approved'`, [userId]);
    await db.query('UPDATE run_spots SET submitted_by = NULL WHERE submitted_by = $1', [userId]);
    await db.query('UPDATE run_spots SET reviewed_by = NULL WHERE reviewed_by = $1', [userId]);
  }

  private async pendingForUpdate(db: Queryable, spotId: string) {
    const { rows } = await db.query<{ name: string; city: string; status: string; submitted_by: string | null }>(
      'SELECT name, city, status, submitted_by FROM run_spots WHERE id = $1 AND removed_at IS NULL FOR UPDATE',
      [spotId],
    );
    const row = rows[0];
    if (!row) throw spotNotFound();
    if (row.status !== 'pending') throw new ApiError(409, 'spot_reviewed', 'Spot ini sudah ditinjau');
    return row;
  }
}

/** Titik spot dibulatkan ke 5 desimal (±1 m): tempat umum, presisi lebih tinggi tidak berguna. */
function round5(v: number): number {
  return Math.round(v * 1e5) / 1e5;
}

function spotJson(r: SpotRow) {
  return {
    id: r.id,
    name: r.name,
    city: r.city,
    point: { lat: Number(r.lat), lng: Number(r.lng) },
    lighting: r.lighting,
    toilet: r.toilet,
    parking: r.parking,
    notes: r.notes,
    createdAt: r.created_at.toISOString(),
  };
}

function spotNotFound() {
  return new ApiError(404, 'spot_not_found', 'Spot tidak ditemukan');
}
