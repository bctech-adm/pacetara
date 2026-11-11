import { Inject, Injectable, Logger } from '@nestjs/common';
import type pg from 'pg';
import type { Queryable } from '../common/db.js';
import { PG_POOL } from '../core.module.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { BADGES, type BadgeRun, computeBadges, currentStreakWeeks } from './badges.js';

/** Lencana yang tercapai lebih lama dari ini dianggap isian ulang (backfill) dan tidak dinotifikasikan. */
const NOTIFY_WINDOW_MS = 7 * 86_400_000;

interface RunRow {
  started_at: Date;
  distance_m: number;
  avg_pace_s_per_km: number | null;
  source: string;
}

/**
 * Lencana pencapaian. Perhitungan idempoten dari seluruh lari pemilik: dipanggil saat lari disimpan
 * (dengan notifikasi) dan saat paspor dibuka pemiliknya (mengisi lencana untuk lari lama, tanpa notifikasi).
 *
 * Semua sumber lari dihitung untuk lencana pribadi pemiliknya. Lencana yang hanya tercapai berkat lari
 * impor Strava ditandai private_only dan tidak pernah ditampilkan ke orang lain (PRD 2.3).
 * Lencana yang sudah didapat tidak dicabut walau larinya dihapus.
 */
@Injectable()
export class BadgesService {
  private readonly logger = new Logger('Badges');

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly notifications: NotificationsService,
  ) {}

  /** Hitung dan simpan lencana. Mengembalikan kode lencana yang baru didapat. Tidak pernah melempar galat. */
  async evaluate(userId: string, opts: { notify: boolean }): Promise<string[]> {
    try {
      const runs = await this.runs(userId);
      const all = computeBadges(runs);
      if (all.size === 0) return [];
      const shareable = computeBadges(runs.filter((r) => r.source !== 'strava'));
      const codes = [...all.keys()];
      const { rows } = await this.pool.query<{ code: string; achieved_at: Date; inserted: boolean }>(
        `INSERT INTO user_badges (user_id, code, achieved_at, private_only)
         SELECT $1, x.code, x.achieved_at, x.private_only
           FROM unnest($2::text[], $3::timestamptz[], $4::boolean[]) AS x(code, achieved_at, private_only)
         ON CONFLICT (user_id, code) DO UPDATE SET private_only = false
           WHERE user_badges.private_only AND NOT EXCLUDED.private_only
         RETURNING code, achieved_at, (xmax = 0) AS inserted`,
        [userId, codes, codes.map((c) => all.get(c)!), codes.map((c) => !shareable.has(c))],
      );
      const fresh = rows.filter((r) => r.inserted);
      const recent = fresh.filter((r) => r.achieved_at.getTime() >= Date.now() - NOTIFY_WINDOW_MS).map((r) => r.code);
      if (opts.notify && recent.length) await this.notifyEarned(userId, recent);
      return fresh.map((r) => r.code);
    } catch (err) {
      this.logger.warn(`Gagal menghitung lencana: ${err instanceof Error ? err.message : 'unknown'}`);
      return [];
    }
  }

  /** Daftar semua lencana dengan status. [forViewer] = orang lain: lencana private_only disembunyikan. */
  async list(userId: string, forViewer: boolean) {
    const { rows } = await this.pool.query<{ code: string; achieved_at: Date; private_only: boolean }>(
      'SELECT code, achieved_at, private_only FROM user_badges WHERE user_id = $1',
      [userId],
    );
    const earned = new Map(rows.filter((r) => !forViewer || !r.private_only).map((r) => [r.code, r]));
    const runs = await this.runs(userId);
    return {
      items: BADGES.filter((b) => !forViewer || earned.has(b.code)).map((b) => {
        const e = earned.get(b.code);
        return {
          code: b.code,
          group: b.group,
          title: b.title,
          description: b.description,
          earned: Boolean(e),
          earnedAt: e ? e.achieved_at.toISOString() : null,
          ...(forViewer ? {} : { privateOnly: e?.private_only ?? false }),
        };
      }),
      currentStreakWeeks: currentStreakWeeks(forViewer ? runs.filter((r) => r.source !== 'strava') : runs),
    };
  }

  async onAccountDeletion(db: Queryable, userId: string): Promise<void> {
    await db.query('DELETE FROM user_badges WHERE user_id = $1', [userId]);
  }

  private async runs(userId: string): Promise<(BadgeRun & { source: string })[]> {
    const { rows } = await this.pool.query<RunRow>(
      'SELECT started_at, distance_m, avg_pace_s_per_km, source FROM runs WHERE user_id = $1 ORDER BY started_at',
      [userId],
    );
    return rows.map((r) => ({ startedAt: r.started_at, distanceM: r.distance_m, avgPaceSPerKm: r.avg_pace_s_per_km, source: r.source }));
  }

  private async notifyEarned(userId: string, codes: string[]) {
    const first = BADGES.find((b) => b.code === codes[0]);
    await this.notifications.notify([userId], {
      category: 'achievement',
      inbox: { type: 'badge_earned', data: { badges: codes.join(',') } },
      push: {
        title: 'Lencana baru!',
        body: codes.length === 1 ? `Kamu mendapat lencana "${first?.title ?? 'baru'}"` : `Kamu mendapat ${codes.length} lencana baru`,
        data: { type: 'badge_earned' },
        tag: 'badge',
      },
    });
  }
}
