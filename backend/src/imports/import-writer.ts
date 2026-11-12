import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type pg from 'pg';
import { type Queryable, withTx } from '../common/db.js';
import { PG_POOL } from '../core.module.js';
import { FieldCrypto } from '../crypto/field-crypto.js';
import { BadgesService } from '../passport/badges.service.js';
import { deleteRuns, findOverlaps, lockUserRuns, SOURCE_PRIORITY } from '../runs/dedup.js';
import { applyPrivacyZone, cleanPoints, computeStats, MAX_SPEED_MPS, type Point, roundSegments } from '../runs/geo.js';
import { encryptRoute, fullAad, publicAad } from '../runs/runs.service.js';
import { StorageService } from '../storage/storage.service.js';
import type { ImportedRun, ImportResult } from './types.js';

const MAX_DISTANCE_M = 300_000;
const MAX_DURATION_S = 24 * 3600;
const MAX_POINTS = 15_000;

/**
 * Menyimpan lari impor dengan aturan yang sama dengan lari aplikasi:
 * - rute (jika ada) dibersihkan, statistik dihitung server (#60), zona privasi diterapkan dan rute
 *   dienkripsi (#61, #62); tanpa rute, statistik yang dilaporkan dipakai dan ditandai stats_verified = false;
 * - idempoten per (pengguna, sumber, id eksternal) lewat import_records;
 * - deduplikasi antar-sumber (runs/dedup.ts) di dalam transaksi berkunci per pengguna;
 * - lari Strava selalu privat.
 */
@Injectable()
export class ImportWriter {
  private readonly logger = new Logger('ImportWriter');

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly crypto: FieldCrypto,
    private readonly storage: StorageService,
    private readonly badges: BadgesService,
  ) {}

  /**
   * @param opts.skipBadges lencana dihitung pemanggil sekali di akhir (sinkron banyak aktivitas).
   * @param opts.allowReimport impor ulang jika lari hasil impor sebelumnya sudah dihapus pemiliknya
   *        (hanya untuk pilihan eksplisit pengguna di Health Connect; impor otomatis tidak menghidupkan lagi lari yang dihapus).
   */
  async importRun(userId: string, run: ImportedRun, opts: { allowReimport?: boolean; notify?: boolean; skipBadges?: boolean } = {}): Promise<ImportResult> {
    const prepared = this.prepare(run);
    const { result, photoKeys } = await withTx(this.pool, async (db) => {
      await lockUserRuns(db, userId);
      const { rows: rec } = await db.query<{ status: string; run_id: string | null; point_count: number | null }>(
        `SELECT ir.status, ir.run_id, r.point_count FROM import_records ir LEFT JOIN runs r ON r.id = ir.run_id
          WHERE ir.user_id = $1 AND ir.source = $2 AND ir.external_id = $3 FOR UPDATE OF ir`,
        [userId, run.source, run.externalId],
      );
      const existing = rec[0];
      if (existing) {
        // Ringkasan sudah masuk tanpa rute, lalu detail dengan rute menyusul (pola Garmin): lengkapi larinya.
        if (existing.status === 'imported' && existing.run_id && existing.point_count === 0 && prepared.ok && prepared.segments.length > 0) {
          await this.updateRoute(db, userId, existing.run_id, prepared);
          return { result: { status: 'updated', runId: existing.run_id } as ImportResult, photoKeys: [] };
        }
        const deletedByOwner = existing.status === 'imported' && !existing.run_id;
        if (!(deletedByOwner && opts.allowReimport)) {
          return { result: { status: 'already_imported', runId: existing.run_id } as ImportResult, photoKeys: [] };
        }
      }

      if (!prepared.ok) {
        await this.record(db, userId, run, 'skipped', null);
        return { result: { status: 'skipped', runId: null, reason: prepared.reason } as ImportResult, photoKeys: [] };
      }

      const overlaps = await findOverlaps(db, userId, run.startedAt, run.endedAt);
      const mine = SOURCE_PRIORITY[run.source] ?? 0;
      const winner = overlaps.find((o) => (SOURCE_PRIORITY[o.source] ?? 0) >= mine);
      if (winner) {
        await this.record(db, userId, run, 'duplicate', winner.id);
        return { result: { status: 'duplicate', runId: winner.id } as ImportResult, photoKeys: [] };
      }
      // Sumber ini lebih diutamakan: lari impor lain yang tumpang-tindih digantikan.
      const id = await this.insert(db, userId, run, prepared);
      const replaced = overlaps.map((o) => o.id);
      if (replaced.length) {
        await db.query(`UPDATE import_records SET status = 'duplicate', run_id = $2 WHERE user_id = $1 AND run_id = ANY($3::uuid[])`, [userId, id, replaced]);
      }
      const keys = await deleteRuns(db, replaced);
      await this.record(db, userId, run, 'imported', id);
      return { result: { status: 'imported', runId: id } as ImportResult, photoKeys: keys };
    });
    for (const k of photoKeys) await this.storage.delete(k).catch(() => this.logger.warn('Gagal menghapus foto lari yang digantikan'));
    if (!opts.skipBadges && (result.status === 'imported' || result.status === 'updated')) await this.badges.evaluate(userId, { notify: opts.notify ?? true });
    return result;
  }

  private async record(db: Queryable, userId: string, run: ImportedRun, status: 'imported' | 'duplicate' | 'skipped', runId: string | null) {
    await db.query(
      `INSERT INTO import_records (user_id, source, external_id, status, run_id) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, source, external_id) DO UPDATE SET status = EXCLUDED.status, run_id = EXCLUDED.run_id`,
      [userId, run.source, run.externalId, status, runId],
    );
  }

  private prepare(run: ImportedRun): Prepared {
    const elapsed = Math.round((run.endedAt.getTime() - run.startedAt.getTime()) / 1000);
    if (!(elapsed > 0) || elapsed > MAX_DURATION_S) return { ok: false, reason: 'invalid_duration' };
    if (run.endedAt.getTime() > Date.now() + 10 * 60_000) return { ok: false, reason: 'in_future' };

    const total = run.segments.reduce((n, s) => n + s.length, 0);
    const raw = total > MAX_POINTS ? [] : run.segments;
    const segments = roundSegments(raw.map(cleanPoints).filter((s) => s.length > 1));
    const gps = computeStats(segments);
    if (segments.length > 0 && gps.distanceM >= 100) {
      return {
        ok: true,
        segments,
        elapsed,
        verified: true,
        distanceM: gps.distanceM,
        movingTimeS: Math.min(gps.movingTimeS, elapsed),
        avgPace: gps.avgPaceSPerKm,
        elevationGainM: gps.elevationGainM,
      };
    }
    // Tanpa rute yang bisa dihitung: statistik yang dilaporkan, diperiksa kewajarannya.
    const distanceM = Math.round(run.reported.distanceM ?? 0);
    const movingTimeS = Math.round(Math.min(run.reported.movingTimeS ?? elapsed, elapsed));
    if (distanceM <= 0 || distanceM > MAX_DISTANCE_M) return { ok: false, reason: 'invalid_distance' };
    if (movingTimeS <= 0 || distanceM / movingTimeS > MAX_SPEED_MPS) return { ok: false, reason: 'implausible_speed' };
    const gain = run.reported.elevationGainM;
    return {
      ok: true,
      segments: [],
      elapsed,
      verified: false,
      distanceM,
      movingTimeS,
      avgPace: distanceM >= 100 ? Math.round(movingTimeS / (distanceM / 1000)) : null,
      elevationGainM: gain === null || !Number.isFinite(gain) ? null : Math.max(0, Math.min(20_000, Math.round(gain))),
    };
  }

  private async insert(db: Queryable, userId: string, run: ImportedRun, p: PreparedOk): Promise<string> {
    const { rows: u } = await db.query<{ privacy_radius_m: number }>('SELECT privacy_radius_m FROM users WHERE id = $1', [userId]);
    const radius = u[0]?.privacy_radius_m ?? 250;
    const id = randomUUID();
    const visibility = run.source === 'strava' ? 'private' : run.visibility;
    await db.query(
      `INSERT INTO runs (id, user_id, client_run_id, source, title, notes, visibility, started_at, ended_at, distance_m,
                         moving_time_s, elapsed_time_s, avg_pace_s_per_km, elevation_gain_m,
                         route_full_enc, route_public_enc, point_count, stats_verified)
       VALUES ($1, $2, $3, $4, $5, '', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        id,
        userId,
        randomUUID(),
        run.source,
        run.title.trim().slice(0, 80) || 'Lari impor',
        visibility,
        run.startedAt,
        run.endedAt,
        p.distanceM,
        p.movingTimeS,
        p.elapsed,
        p.avgPace,
        p.elevationGainM,
        p.segments.length ? encryptRoute(this.crypto, p.segments, fullAad(id)) : null,
        p.segments.length ? encryptRoute(this.crypto, applyPrivacyZone(p.segments, radius), publicAad(id)) : null,
        p.segments.reduce((n, s) => n + s.length, 0),
        p.verified,
      ],
    );
    return id;
  }

  private async updateRoute(db: Queryable, userId: string, runId: string, p: PreparedOk) {
    const { rows: u } = await db.query<{ privacy_radius_m: number }>('SELECT privacy_radius_m FROM users WHERE id = $1', [userId]);
    const radius = u[0]?.privacy_radius_m ?? 250;
    await db.query(
      `UPDATE runs SET distance_m = $2, moving_time_s = $3, avg_pace_s_per_km = $4, elevation_gain_m = $5,
                       route_full_enc = $6, route_public_enc = $7, point_count = $8, stats_verified = $9
        WHERE id = $1`,
      [
        runId,
        p.distanceM,
        p.movingTimeS,
        p.avgPace,
        p.elevationGainM,
        encryptRoute(this.crypto, p.segments, fullAad(runId)),
        encryptRoute(this.crypto, applyPrivacyZone(p.segments, radius), publicAad(runId)),
        p.segments.reduce((n, s) => n + s.length, 0),
        p.verified,
      ],
    );
  }
}

interface PreparedOk {
  ok: true;
  segments: Point[][];
  elapsed: number;
  verified: boolean;
  distanceM: number;
  movingTimeS: number;
  avgPace: number | null;
  elevationGainM: number | null;
}
type Prepared = PreparedOk | { ok: false; reason: string };
