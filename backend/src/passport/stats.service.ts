import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { ApiError } from '../common/http.js';
import { PG_POOL } from '../core.module.js';
import { hasFullStats, RUN_HISTORY_DAYS, type UserPlan } from '../plans/plans.js';
import { MIN_PLAUSIBLE_PACE_S_PER_KM } from './badges.js';

export type StatsPeriod = 'week' | 'month' | 'year';

/** Zona waktu agregasi. date_trunc('week') Postgres memulai minggu pada Senin. */
export const STATS_TZ = 'Asia/Jakarta';

export const STATS_DEFAULT_COUNT: Record<StatsPeriod, number> = { week: 12, month: 6, year: 5 };
export const STATS_MAX_COUNT: Record<StatsPeriod, number> = { week: 52, month: 24, year: 10 };

const INTERVAL: Record<StatsPeriod, string> = { week: '1 week', month: '1 month', year: '1 year' };

const RECORDS = [
  { code: '5k', distanceM: 5000 },
  { code: '10k', distanceM: 10_000 },
  { code: 'hm', distanceM: 21_097 },
  { code: 'fm', distanceM: 42_195 },
] as const;

const pace = (movingS: number, distanceM: number) => (distanceM > 0 ? Math.round((movingS * 1000) / distanceM) : null);

/**
 * Statistik riwayat lari pemilik, dihitung server dalam WIB. Semua lari pemilik dihitung (termasuk
 * privat dan impor Strava, karena ini riwayat pribadinya). Paket gratis hanya melihat jendela
 * RUN_HISTORY_DAYS; Premium mendapat statistik lengkap (lihat hasFullStats).
 */
@Injectable()
export class StatsService {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async stats(userId: string, period: StatsPeriod, requestedCount?: number) {
    const plan = await this.plan(userId);
    const full = hasFullStats(plan);
    if (period === 'year' && !full) {
      throw new ApiError(403, 'limit_reached', 'Statistik tahunan khusus Premium. Upgrade untuk melihat statistik lengkap', {
        limit: { kind: 'full_stats', max: null },
      });
    }
    const days = full ? null : RUN_HISTORY_DAYS[plan];
    const count = Math.min(requestedCount ?? STATS_DEFAULT_COUNT[period], STATS_MAX_COUNT[period]);
    const unit = period; // nilai dari daftar tetap, aman disisipkan ke SQL
    const step = INTERVAL[period];

    // Deret periode (kosong tetap muncul). Paket gratis: tidak lebih awal dari periode yang memuat awal jendela.
    const { rows } = await this.pool.query<{ start: string; runs: string; distance: string; moving: string }>(
      `WITH cur AS (SELECT date_trunc('${unit}', now() AT TIME ZONE '${STATS_TZ}') AS c),
       series AS (
         SELECT generate_series(
                  greatest(c - ($2::int - 1) * interval '${step}',
                           CASE WHEN $3::int IS NULL THEN '-infinity'::timestamp
                                ELSE date_trunc('${unit}', (now() - make_interval(days => $3::int)) AT TIME ZONE '${STATS_TZ}') END),
                  c, interval '${step}') AS start
           FROM cur
       )
       SELECT to_char(s.start, 'YYYY-MM-DD') AS start, count(r.id) AS runs,
              COALESCE(sum(r.distance_m), 0) AS distance, COALESCE(sum(r.moving_time_s), 0) AS moving
         FROM series s
         LEFT JOIN runs r ON r.user_id = $1
              AND r.started_at >= (SELECT min(start) FROM series) AT TIME ZONE '${STATS_TZ}'
              AND date_trunc('${unit}', r.started_at AT TIME ZONE '${STATS_TZ}') = s.start
              AND ($3::int IS NULL OR r.started_at >= now() - make_interval(days => $3::int))
        GROUP BY s.start ORDER BY s.start`,
      [userId, count, days],
    );

    const totals = await this.totals(userId, days);
    return {
      period,
      timezone: STATS_TZ,
      weekStartsOn: 'monday',
      full,
      historyLimit: { days },
      buckets: rows.map((r) => ({
        start: r.start,
        runs: Number(r.runs),
        distanceM: Number(r.distance),
        movingTimeS: Number(r.moving),
        avgPaceSPerKm: pace(Number(r.moving), Number(r.distance)),
      })),
      // Paket gratis: total di dalam jendela riwayat; Premium: sepanjang masa.
      totals,
      records: full ? await this.records(userId) : null,
    };
  }

  private async totals(userId: string, days: number | null) {
    const { rows } = await this.pool.query<{ runs: string; distance: string; moving: string; longest: number | null }>(
      `SELECT count(*) AS runs, COALESCE(sum(distance_m), 0) AS distance, COALESCE(sum(moving_time_s), 0) AS moving, max(distance_m) AS longest
         FROM runs WHERE user_id = $1 AND ($2::int IS NULL OR started_at >= now() - make_interval(days => $2::int))`,
      [userId, days],
    );
    const t = rows[0]!;
    return {
      runs: Number(t.runs),
      distanceM: Number(t.distance),
      movingTimeS: Number(t.moving),
      avgPaceSPerKm: pace(Number(t.moving), Number(t.distance)),
      longestRunM: t.longest ?? 0,
    };
  }

  /**
   * Rekor pribadi: pace rata-rata terbaik dari lari yang minimal sejauh jarak rekor, diproyeksikan ke
   * jarak itu (perkiraan, bukan split terbaik di tengah lari). Lari dengan pace tidak masuk akal diabaikan.
   */
  private async records(userId: string) {
    const out: Record<string, { runId: string; startedAt: string; timeS: number; avgPaceSPerKm: number } | null> = {};
    for (const r of RECORDS) {
      const { rows } = await this.pool.query<{ id: string; started_at: Date; avg_pace_s_per_km: number }>(
        `SELECT id, started_at, avg_pace_s_per_km FROM runs
          WHERE user_id = $1 AND distance_m >= $2 AND avg_pace_s_per_km >= $3
          ORDER BY avg_pace_s_per_km, started_at LIMIT 1`,
        [userId, r.distanceM, MIN_PLAUSIBLE_PACE_S_PER_KM],
      );
      const best = rows[0];
      out[r.code] = best
        ? {
            runId: best.id,
            startedAt: best.started_at.toISOString(),
            timeS: Math.round((best.avg_pace_s_per_km * r.distanceM) / 1000),
            avgPaceSPerKm: best.avg_pace_s_per_km,
          }
        : null;
    }
    return out;
  }

  private async plan(userId: string): Promise<UserPlan> {
    const { rows } = await this.pool.query<{ plan: UserPlan }>('SELECT plan FROM users WHERE id = $1', [userId]);
    return rows[0]?.plan ?? 'free';
  }
}
