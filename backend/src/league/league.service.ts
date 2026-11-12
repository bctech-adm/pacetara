import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { communityAccess, requirePro, requireStaff } from '../communities/access.js';
import { withTx } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { PG_POOL } from '../core.module.js';
import { MIN_BADGE_DISTANCE_M, MIN_PLAUSIBLE_PACE_S_PER_KM } from '../passport/badges.js';
import { hasProFeature, type CommunityPlan } from '../plans/plans.js';

export const LEAGUE_TZ = 'Asia/Jakarta';
/** Pembagi minimum skor: komunitas dengan < 5 pelari aktif dibagi 5 agar satu pelari rajin tidak mengalahkan tim. */
export const LEAGUE_MIN_DIVISOR = 5;
/** Bulan sebelumnya masih dihitung ulang sampai tanggal 3 (unggahan antrean offline yang terlambat), lalu dibekukan. */
export const LEAGUE_FREEZE_DAY = 3;

/**
 * Lari yang dihitung untuk liga dan statistik komunitas (alias r = runs, m = community_members, u = users):
 * - bukan Strava (PRD 2.3: tidak boleh di papan peringkat/statistik komunitas) dan stats_verified (#161);
 * - bukan "hanya saya" (pilihan privat dihormati, bahkan dalam angka agregat);
 * - lari sah seperti lencana (#154): >= 1 km dan pace rata-rata tidak lebih cepat dari 2:30/km;
 * - dimulai setelah pelari bergabung ke komunitas itu (anggota baru tidak membawa jarak lamanya);
 * - akun aktif dan anggota aktif saat dihitung.
 * Sumber app, Garmin, dan Health Connect (dengan rute) diizinkan.
 */
export const COUNTED_RUN = `r.source <> 'strava' AND r.stats_verified AND r.visibility <> 'private'
  AND r.distance_m >= ${MIN_BADGE_DISTANCE_M} AND r.moving_time_s::bigint * 1000 >= ${MIN_PLAUSIBLE_PACE_S_PER_KM}::bigint * r.distance_m
  AND m.status = 'active' AND m.joined_at IS NOT NULL AND m.joined_at <= r.started_at AND u.status = 'active'`;

export type StatsPeriod = 'week' | 'month';
const INTERVAL: Record<StatsPeriod, string> = { week: '1 week', month: '1 month' };

/**
 * Liga antar komunitas (Komunitas Pro): papan peringkat bulanan per kota dari snapshot yang dihitung worker.
 * Skor = total jarak / GREATEST(anggota aktif, LEAGUE_MIN_DIVISOR). Hanya angka agregat; tidak ada detail lari,
 * nama pelari, atau rute yang keluar dari sini.
 */
@Injectable()
export class LeagueService {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** Hitung ulang snapshot satu bulan (YYYY-MM-01). Mengembalikan jumlah komunitas peserta. */
  async compute(month: string): Promise<number> {
    return withTx(this.pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`league:${month}`]);
      await db.query('DELETE FROM league_snapshots WHERE month = $1::date', [month]);
      const { rowCount } = await db.query(
        `WITH parts AS (
           SELECT c.id, lower(btrim(c.city)) AS city_key, btrim(c.city) AS city FROM communities c
            WHERE c.plan <> 'free' AND c.removed_at IS NULL AND c.hidden_at IS NULL
         ), counted AS (
           SELECT m.community_id, r.user_id, r.distance_m
             FROM runs r
             JOIN users u ON u.id = r.user_id
             JOIN community_members m ON m.user_id = r.user_id AND m.community_id IN (SELECT id FROM parts)
            WHERE (r.started_at AT TIME ZONE '${LEAGUE_TZ}') >= $1::date
              AND (r.started_at AT TIME ZONE '${LEAGUE_TZ}') < ($1::date + interval '1 month')
              AND ${COUNTED_RUN}
         ), agg AS (
           SELECT p.id, p.city_key, p.city, COALESCE(sum(c.distance_m), 0)::bigint AS total_m, count(c.user_id)::int AS runs,
                  count(DISTINCT c.user_id)::int AS active
             FROM parts p LEFT JOIN counted c ON c.community_id = p.id
            GROUP BY p.id, p.city_key, p.city
         )
         INSERT INTO league_snapshots (month, community_id, city_key, city, total_m, runs, active_members, score, rank)
         SELECT $1::date, id, city_key, city, total_m, runs, active, (total_m / GREATEST(active, ${LEAGUE_MIN_DIVISOR}))::int,
                rank() OVER (PARTITION BY city_key ORDER BY (total_m / GREATEST(active, ${LEAGUE_MIN_DIVISOR})) DESC, total_m DESC)
           FROM agg`,
        [month],
      );
      return rowCount ?? 0;
    });
  }

  /** Job worker (tiap jam): bulan berjalan, plus bulan lalu sampai LEAGUE_FREEZE_DAY. */
  async runJob(now = new Date()): Promise<{ months: string[]; communities: number }> {
    const cur = monthWib(now);
    const months = [cur];
    if (wibDay(now) <= LEAGUE_FREEZE_DAY) months.push(prevMonth(cur));
    let communities = 0;
    for (const m of months) communities += await this.compute(m);
    return { months, communities };
  }

  async leaderboard(userId: string, q: { month?: string; city?: string }) {
    const month = q.month ? `${q.month}-01` : monthWib(new Date());
    const current = monthWib(new Date());
    if (month > current) throw new ApiError(400, 'invalid_month', 'Bulan belum berjalan');
    // Snapshot bulan berjalan belum ada (mis. tepat setelah deploy/awal bulan): hitung sekarang.
    if (month === current) {
      const { rowCount } = await this.pool.query('SELECT 1 FROM league_snapshots WHERE month = $1::date LIMIT 1', [month]);
      if (!rowCount) await this.compute(month);
    }
    const mine = await this.myCommunities(userId, month);
    const { rows: cities } = await this.pool.query<{ city_key: string; city: string; n: string }>(
      `SELECT city_key, min(city) AS city, count(*) AS n FROM league_snapshots WHERE month = $1::date GROUP BY city_key ORDER BY count(*) DESC, min(city)`,
      [month],
    );
    const wanted = q.city?.trim().toLowerCase() || mine.find((m) => m.participating)?.city.trim().toLowerCase() || mine[0]?.city.trim().toLowerCase() || cities[0]?.city_key;
    const { rows } = wanted
      ? await this.pool.query<{
          community_id: string;
          name: string;
          logo_key: string | null;
          logo_updated_at: Date | null;
          city: string;
          total_m: string;
          runs: number;
          active_members: number;
          score: number;
          rank: number;
          computed_at: Date;
        }>(
          `SELECT s.community_id, c.name, c.logo_key, c.logo_updated_at, s.city, s.total_m, s.runs, s.active_members, s.score, s.rank, s.computed_at
             FROM league_snapshots s JOIN communities c ON c.id = s.community_id AND c.removed_at IS NULL
            WHERE s.month = $1::date AND s.city_key = $2 ORDER BY s.rank, c.name LIMIT 100`,
          [month, wanted],
        )
      : { rows: [] };
    return {
      month: month.slice(0, 7),
      city: rows[0]?.city ?? cities.find((c) => c.city_key === wanted)?.city ?? q.city ?? null,
      computedAt: rows[0]?.computed_at.toISOString() ?? null,
      rules: {
        minDivisor: LEAGUE_MIN_DIVISOR,
        description: 'Skor = total km anggota ÷ jumlah pelari aktif (min. 5). Hanya lari yang direkam di aplikasi atau diimpor dengan rute (bukan Strava), min. 1 km, bukan "hanya saya", sejak anggota bergabung.',
      },
      cities: cities.map((c) => ({ city: c.city, communities: Number(c.n) })),
      items: rows.map((r) => ({
        rank: r.rank,
        community: {
          id: r.community_id,
          name: r.name,
          city: r.city,
          logoUrl: r.logo_key ? `/v1/communities/${r.community_id}/logo?v=${r.logo_updated_at?.getTime() ?? 0}` : null,
        },
        totalM: Number(r.total_m),
        runs: r.runs,
        activeMembers: r.active_members,
        scoreM: r.score,
      })),
      mine,
    };
  }

  /** Komunitas saya: ikut liga atau tidak (non-Pro = tidak tampil sebagai peserta; admin melihat ajakan upgrade). */
  private async myCommunities(userId: string, month: string) {
    const { rows } = await this.pool.query<{
      id: string;
      name: string;
      city: string;
      plan: CommunityPlan;
      role: string;
      rank: number | null;
      score: number | null;
    }>(
      `SELECT c.id, c.name, c.city, c.plan, m.role, s.rank, s.score
         FROM community_members m JOIN communities c ON c.id = m.community_id AND c.removed_at IS NULL
         LEFT JOIN league_snapshots s ON s.community_id = c.id AND s.month = $2::date
        WHERE m.user_id = $1 AND m.status = 'active' ORDER BY m.joined_at`,
      [userId, month],
    );
    return rows.map((r) => {
      const participating = hasProFeature(r.plan, 'league');
      const staff = r.role === 'owner' || r.role === 'admin';
      return {
        communityId: r.id,
        name: r.name,
        city: r.city,
        participating,
        rank: participating ? r.rank : null,
        scoreM: participating ? r.score : null,
        isOwner: r.role === 'owner',
        upgradeRequired: !participating && staff,
      };
    });
  }

  /** Statistik komunitas (Komunitas Pro, admin): ringkasan aktivitas anggota per minggu/bulan WIB. */
  async communityStats(userId: string, communityId: string, period: StatsPeriod, count: number) {
    const access = requirePro(requireStaff(await communityAccess(this.pool, communityId, userId)), 'community_stats');
    const { rows } = await this.pool.query<{ start: string; total_m: string; runs: string; active: string; sessions: string; attendees: string }>(
      `WITH periods AS (
         SELECT generate_series(date_trunc('${period}', now() AT TIME ZONE '${LEAGUE_TZ}') - ($2::int - 1) * interval '${INTERVAL[period]}',
                                date_trunc('${period}', now() AT TIME ZONE '${LEAGUE_TZ}'), interval '${INTERVAL[period]}') AS start
       ), counted AS (
         SELECT date_trunc('${period}', r.started_at AT TIME ZONE '${LEAGUE_TZ}') AS start, r.user_id, r.distance_m
           FROM runs r JOIN users u ON u.id = r.user_id
           JOIN community_members m ON m.user_id = r.user_id AND m.community_id = $1
          WHERE r.started_at >= (SELECT (min(start) AT TIME ZONE '${LEAGUE_TZ}') FROM periods) AND ${COUNTED_RUN}
       ), sess AS (
         SELECT date_trunc('${period}', s.starts_at AT TIME ZONE '${LEAGUE_TZ}') AS start, count(DISTINCT s.id) AS sessions,
                count(a.user_id) AS attendees
           FROM community_sessions s LEFT JOIN session_attendance a ON a.session_id = s.id
          WHERE s.community_id = $1 AND s.cancelled_at IS NULL AND s.starts_at <= now()
            AND s.starts_at >= (SELECT (min(start) AT TIME ZONE '${LEAGUE_TZ}') FROM periods)
          GROUP BY 1
       )
       SELECT to_char(p.start, 'YYYY-MM-DD') AS start, COALESCE(sum(c.distance_m), 0) AS total_m, count(c.user_id) AS runs,
              count(DISTINCT c.user_id) AS active, COALESCE(max(se.sessions), 0) AS sessions, COALESCE(max(se.attendees), 0) AS attendees
         FROM periods p LEFT JOIN counted c ON c.start = p.start LEFT JOIN sess se ON se.start = p.start
        GROUP BY p.start ORDER BY p.start`,
      [communityId, count],
    );
    const { rows: members } = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM community_members WHERE community_id = $1 AND status = 'active'`,
      [communityId],
    );
    return {
      communityId: access.communityId,
      period,
      timezone: LEAGUE_TZ,
      members: Number(members[0]!.n),
      series: rows.map((r) => ({
        start: r.start,
        totalM: Number(r.total_m),
        runs: Number(r.runs),
        activeMembers: Number(r.active),
        sessions: Number(r.sessions),
        attendees: Number(r.attendees),
      })),
    };
  }
}

/** Awal bulan WIB (YYYY-MM-01). */
export function monthWib(d: Date): string {
  return `${new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 7)}-01`;
}

function wibDay(d: Date): number {
  return new Date(d.getTime() + 7 * 3_600_000).getUTCDate();
}

export function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  return `${py}-${String(pm).padStart(2, '0')}-01`;
}
