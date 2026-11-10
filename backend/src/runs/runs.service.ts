import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type pg from 'pg';
import { CommunitiesService } from '../communities/communities.service.js';
import { type Queryable, withTx } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { PG_POOL } from '../core.module.js';
import { FieldCrypto } from '../crypto/field-crypto.js';
import { LiveService } from '../live/live.service.js';
import { RUN_HISTORY_DAYS, type UserPlan } from '../plans/plans.js';
import { processImage } from '../storage/image.js';
import { StorageService } from '../storage/storage.service.js';
import { applyPrivacyZone, cleanPoints, computeStats, type Point, roundSegments } from './geo.js';

export type RunVisibility = 'public' | 'community' | 'private';

export interface CreateRunInput {
  clientRunId: string;
  title: string;
  notes: string;
  visibility: RunVisibility;
  startedAt: Date;
  endedAt: Date;
  segments: Point[][];
}

interface RunRow {
  id: string;
  user_id: string;
  source: string;
  title: string;
  notes: string;
  visibility: RunVisibility;
  started_at: Date;
  ended_at: Date;
  distance_m: number;
  moving_time_s: number;
  elapsed_time_s: number;
  avg_pace_s_per_km: number | null;
  elevation_gain_m: number | null;
  point_count: number;
  created_at: Date;
}

const COLS = `r.id, r.user_id, r.source, r.title, r.notes, r.visibility, r.started_at, r.ended_at, r.distance_m,
  r.moving_time_s, r.elapsed_time_s, r.avg_pace_s_per_km, r.elevation_gain_m, r.point_count, r.created_at`;

const MAX_PHOTOS = 4;
const fullAad = (id: string) => `runs.route_full:${id}`;
const publicAad = (id: string) => `runs.route_public:${id}`;

@Injectable()
export class RunsService {
  private readonly logger = new Logger('Runs');

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly crypto: FieldCrypto,
    private readonly storage: StorageService,
    private readonly communities: CommunitiesService,
    private readonly live: LiveService,
  ) {}

  /** Simpan lari. Idempoten per (pengguna, clientRunId): upload ulang mengembalikan lari yang sama. */
  async create(userId: string, input: CreateRunInput) {
    // Lari selesai dan diunggah: status lari langsung (beserta titik lokasinya) dihapus dari server.
    await this.live.end(userId, input.clientRunId);
    const existing = await this.pool.query<{ id: string }>('SELECT id FROM runs WHERE user_id = $1 AND client_run_id = $2', [
      userId,
      input.clientRunId,
    ]);
    if (existing.rows[0]) return { created: false, run: await this.detail(userId, existing.rows[0].id, true) };

    const { rows: u } = await this.pool.query<{ privacy_radius_m: number }>('SELECT privacy_radius_m FROM users WHERE id = $1', [
      userId,
    ]);
    const radius = u[0]?.privacy_radius_m ?? 250;

    const segments = roundSegments(input.segments.map(cleanPoints).filter((s) => s.length > 0));
    const stats = computeStats(segments);
    const publicSegments = applyPrivacyZone(segments, radius);
    const elapsed = Math.max(0, Math.round((input.endedAt.getTime() - input.startedAt.getTime()) / 1000));
    const id = randomUUID();

    try {
      await this.pool.query(
        `INSERT INTO runs (id, user_id, client_run_id, title, notes, visibility, started_at, ended_at, distance_m,
                           moving_time_s, elapsed_time_s, avg_pace_s_per_km, elevation_gain_m,
                           route_full_enc, route_public_enc, point_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          id,
          userId,
          input.clientRunId,
          input.title,
          input.notes,
          input.visibility,
          input.startedAt,
          input.endedAt,
          stats.distanceM,
          Math.min(stats.movingTimeS, elapsed || stats.movingTimeS),
          elapsed,
          stats.avgPaceSPerKm,
          stats.elevationGainM,
          this.encryptRoute(segments, fullAad(id)),
          this.encryptRoute(publicSegments, publicAad(id)),
          segments.reduce((n, s) => n + s.length, 0),
        ],
      );
    } catch (err) {
      // Dua upload bersamaan dengan clientRunId sama: kembalikan yang sudah tersimpan.
      if ((err as { code?: string }).code === '23505') {
        const again = await this.pool.query<{ id: string }>('SELECT id FROM runs WHERE user_id = $1 AND client_run_id = $2', [
          userId,
          input.clientRunId,
        ]);
        if (again.rows[0]) return { created: false, run: await this.detail(userId, again.rows[0].id, true) };
      }
      throw err;
    }
    return { created: true, run: await this.detail(userId, id, true) };
  }

  /** Riwayat lari sendiri. Paket gratis hanya melihat RUN_HISTORY_DAYS terakhir (data lama tidak dihapus). */
  async mine(userId: string, q: { limit: number; before?: Date }) {
    const plan = await this.plan(userId);
    const days = RUN_HISTORY_DAYS[plan];
    const params: unknown[] = [userId, q.limit + 1];
    const where = ['r.user_id = $1'];
    if (days !== null) where.push(`r.started_at >= now() - make_interval(days => ${Number(days)})`);
    if (q.before) {
      params.push(q.before);
      where.push(`r.started_at < $${params.length}`);
    }
    const { rows } = await this.pool.query<RunRow>(
      `SELECT ${COLS} FROM runs r WHERE ${where.join(' AND ')} ORDER BY r.started_at DESC LIMIT $2`,
      params,
    );
    const hiddenOlder =
      days === null
        ? 0
        : Number(
            (
              await this.pool.query<{ n: string }>(
                `SELECT count(*) AS n FROM runs WHERE user_id = $1 AND started_at < now() - make_interval(days => ${Number(days)})`,
                [userId],
              )
            ).rows[0]!.n,
          );
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((r) => this.summary(r)),
      nextBefore: rows.length > q.limit ? page.at(-1)!.started_at.toISOString() : null,
      historyLimit: { days, hiddenOlderRuns: hiddenOlder },
    };
  }

  /** Lari pengguna lain yang boleh dilihat penonton. */
  async ofUser(viewerId: string, ownerId: string, q: { limit: number; before?: Date }) {
    if (viewerId === ownerId) return this.mine(viewerId, q);
    const allowed: RunVisibility[] = ['public'];
    if (await this.communities.shareCommunity(viewerId, ownerId)) allowed.push('community');
    const params: unknown[] = [ownerId, allowed, q.limit + 1];
    let extra = '';
    if (q.before) {
      params.push(q.before);
      extra = `AND r.started_at < $${params.length}`;
    }
    const { rows } = await this.pool.query<RunRow>(
      `SELECT ${COLS} FROM runs r JOIN users u ON u.id = r.user_id
        WHERE r.user_id = $1 AND u.status = 'active' AND r.visibility = ANY($2) ${extra}
        ORDER BY r.started_at DESC LIMIT $3`,
      params,
    );
    const page = rows.slice(0, q.limit);
    return { items: page.map((r) => this.summary(r)), nextBefore: rows.length > q.limit ? page.at(-1)!.started_at.toISOString() : null };
  }

  /** Detail + rute. Pemilik mendapat rute utuh; orang lain hanya rute setelah zona privasi. */
  async detail(viewerId: string, runId: string, skipHistoryLimit = false) {
    const { rows } = await this.pool.query<RunRow & { route_full_enc: Buffer | null; route_public_enc: Buffer | null }>(
      `SELECT ${COLS}, r.route_full_enc, r.route_public_enc FROM runs r WHERE r.id = $1`,
      [runId],
    );
    const r = rows[0];
    if (!r) throw notFound();
    const isOwner = r.user_id === viewerId;
    if (!isOwner) await this.assertCanView(viewerId, r);
    if (isOwner && !skipHistoryLimit) await this.assertWithinHistory(viewerId, r);

    const photos = await this.pool.query<{ id: string; position: number }>(
      'SELECT id, position FROM run_photos WHERE run_id = $1 ORDER BY position',
      [runId],
    );
    return {
      ...this.summary(r),
      notes: r.notes,
      isOwner,
      // Pemilik: rute utuh + rute publik (agar bisa melihat apa yang terlihat orang lain).
      route: isOwner ? this.decryptRoute(r.route_full_enc, fullAad(r.id)) : this.decryptRoute(r.route_public_enc, publicAad(r.id)),
      publicRoute: isOwner ? this.decryptRoute(r.route_public_enc, publicAad(r.id)) : undefined,
      photos: photos.rows.map((p) => ({ id: p.id, url: `/v1/runs/${r.id}/photos/${p.id}` })),
    };
  }

  async update(userId: string, runId: string, patch: { title?: string; notes?: string; visibility?: RunVisibility }) {
    await this.requireOwner(this.pool, userId, runId);
    const sets: string[] = [];
    const values: unknown[] = [runId];
    for (const [col, v] of [
      ['title', patch.title],
      ['notes', patch.notes],
      ['visibility', patch.visibility],
    ] as const) {
      if (v !== undefined) {
        values.push(v);
        sets.push(`${col} = $${values.length}`);
      }
    }
    if (sets.length) await this.pool.query(`UPDATE runs SET ${sets.join(', ')} WHERE id = $1`, values);
    return this.detail(userId, runId);
  }

  async remove(userId: string, runId: string): Promise<void> {
    const keys = await withTx(this.pool, async (db) => {
      await this.requireOwner(db, userId, runId);
      const { rows } = await db.query<{ storage_key: string }>('DELETE FROM run_photos WHERE run_id = $1 RETURNING storage_key', [runId]);
      await db.query('DELETE FROM runs WHERE id = $1', [runId]);
      return rows.map((r) => r.storage_key);
    });
    await this.deleteObjects(keys);
  }

  async addPhoto(userId: string, runId: string, file: Buffer) {
    await this.requireOwner(this.pool, userId, runId);
    const { rows } = await this.pool.query<{ position: number }>('SELECT position FROM run_photos WHERE run_id = $1', [runId]);
    const used = new Set(rows.map((r) => r.position));
    const position = [0, 1, 2, 3].find((p) => !used.has(p));
    if (position === undefined) throw new ApiError(409, 'photo_limit', `Maksimal ${MAX_PHOTOS} foto per lari`);
    const webp = await processImage(file, { size: 1600 });
    const key = `runs/${userId}/${runId}/${randomUUID()}.webp`;
    await this.storage.put(key, webp, 'image/webp');
    try {
      await this.pool.query('INSERT INTO run_photos (run_id, storage_key, position) VALUES ($1, $2, $3)', [runId, key, position]);
    } catch (err) {
      await this.storage.delete(key).catch(() => undefined);
      throw err;
    }
    return this.detail(userId, runId);
  }

  async removePhoto(userId: string, runId: string, photoId: string) {
    await this.requireOwner(this.pool, userId, runId);
    const { rows } = await this.pool.query<{ storage_key: string }>(
      'DELETE FROM run_photos WHERE id = $1 AND run_id = $2 RETURNING storage_key',
      [photoId, runId],
    );
    await this.deleteObjects(rows.map((r) => r.storage_key));
    return this.detail(userId, runId);
  }

  async photoFile(viewerId: string, runId: string, photoId: string) {
    await this.detailAccess(viewerId, runId);
    const { rows } = await this.pool.query<{ storage_key: string }>('SELECT storage_key FROM run_photos WHERE id = $1 AND run_id = $2', [
      photoId,
      runId,
    ]);
    return rows[0] ? this.storage.get(rows[0].storage_key) : undefined;
  }

  async setPrivacyRadius(userId: string, radiusM: number): Promise<void> {
    await this.pool.query('UPDATE users SET privacy_radius_m = $2 WHERE id = $1', [userId, radiusM]);
  }

  /** Dipanggil saat hapus akun (dalam transaksi yang sama). Mengembalikan kunci foto untuk dihapus. */
  async onAccountDeletion(db: Queryable, userId: string): Promise<string[]> {
    const { rows } = await db.query<{ storage_key: string }>(
      'DELETE FROM run_photos p USING runs r WHERE p.run_id = r.id AND r.user_id = $1 RETURNING p.storage_key',
      [userId],
    );
    await db.query('DELETE FROM runs WHERE user_id = $1', [userId]);
    return rows.map((r) => r.storage_key);
  }

  async deleteObjects(keys: string[]) {
    for (const k of keys) await this.storage.delete(k).catch(() => this.logger.warn('Gagal menghapus foto lari'));
  }

  // ---------- Bantuan ----------

  private async detailAccess(viewerId: string, runId: string) {
    const { rows } = await this.pool.query<RunRow>(`SELECT ${COLS} FROM runs r WHERE r.id = $1`, [runId]);
    const r = rows[0];
    if (!r) throw notFound();
    if (r.user_id === viewerId) await this.assertWithinHistory(viewerId, r);
    else await this.assertCanView(viewerId, r);
  }

  private async assertCanView(viewerId: string, r: RunRow) {
    const { rows } = await this.pool.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [r.user_id]);
    if (rows[0]?.status !== 'active') throw notFound();
    if (r.visibility === 'public') return;
    if (r.visibility === 'community' && (await this.communities.shareCommunity(viewerId, r.user_id))) return;
    // Lari privat/komunitas tampil seolah tidak ada bagi yang tidak berhak.
    throw notFound();
  }

  private async assertWithinHistory(userId: string, r: RunRow) {
    const days = RUN_HISTORY_DAYS[await this.plan(userId)];
    if (days !== null && r.started_at.getTime() < Date.now() - days * 86_400_000) {
      throw new ApiError(403, 'limit_reached', `Riwayat lari paket gratis hanya ${days} hari terakhir. Upgrade ke Premium untuk melihat semua riwayat`, {
        limit: { kind: 'run_history', max: days },
      });
    }
  }

  private async requireOwner(db: Queryable, userId: string, runId: string) {
    const { rows } = await db.query<{ user_id: string }>('SELECT user_id FROM runs WHERE id = $1', [runId]);
    if (!rows[0] || rows[0].user_id !== userId) throw notFound();
  }

  private async plan(userId: string): Promise<UserPlan> {
    const { rows } = await this.pool.query<{ plan: UserPlan }>('SELECT plan FROM users WHERE id = $1', [userId]);
    return rows[0]?.plan ?? 'free';
  }

  private encryptRoute(segments: Point[][], aad: string): Buffer {
    return this.crypto.encrypt(gzipSync(Buffer.from(JSON.stringify(segments))), aad);
  }

  private decryptRoute(payload: Buffer | null, aad: string): Point[][] {
    if (!payload) return [];
    return JSON.parse(gunzipSync(this.crypto.decrypt(payload, aad)).toString('utf8')) as Point[][];
  }

  private summary(r: RunRow) {
    return {
      id: r.id,
      userId: r.user_id,
      source: r.source,
      title: r.title,
      visibility: r.visibility,
      startedAt: r.started_at.toISOString(),
      endedAt: r.ended_at.toISOString(),
      distanceM: r.distance_m,
      movingTimeS: r.moving_time_s,
      elapsedTimeS: r.elapsed_time_s,
      avgPaceSPerKm: r.avg_pace_s_per_km,
      elevationGainM: r.elevation_gain_m,
    };
  }
}

function notFound() {
  return new ApiError(404, 'run_not_found', 'Lari tidak ditemukan');
}
