import type { Queryable } from '../common/db.js';

/**
 * Deduplikasi lari antar-sumber (modul 2.3). Lari yang sama sering datang dari beberapa jalur
 * (jam Garmin → Garmin Connect → Health Connect → Strava), jadi lari yang tumpang-tindih waktunya
 * minimal OVERLAP_THRESHOLD dianggap lari yang sama dan hanya satu yang disimpan.
 *
 * Prioritas: app (GPS diverifikasi server, bisa dibagikan) > garmin (sumber asli perangkat) >
 * health_connect (agregator, sering berisi salinan dari aplikasi lain) > strava (hanya riwayat pribadi).
 */
export const SOURCE_PRIORITY: Record<string, number> = { app: 4, garmin: 3, health_connect: 2, strava: 1 };
export const OVERLAP_THRESHOLD = 0.5;

/** Irisan waktu dibagi durasi lari yang lebih pendek (lari pendek di dalam lari panjang = 100%). */
export function overlapRatio(a: { start: Date; end: Date }, b: { start: Date; end: Date }): number {
  const inter = Math.min(a.end.getTime(), b.end.getTime()) - Math.max(a.start.getTime(), b.start.getTime());
  if (inter <= 0) return 0;
  const shorter = Math.max(1000, Math.min(a.end.getTime() - a.start.getTime(), b.end.getTime() - b.start.getTime()));
  return Math.min(1, inter / shorter);
}

export interface OverlapRun {
  id: string;
  source: string;
  start: Date;
  end: Date;
}

/** Lari milik pengguna yang tumpang-tindih ≥ OVERLAP_THRESHOLD dengan rentang [start, end]. */
export async function findOverlaps(db: Queryable, userId: string, start: Date, end: Date, excludeId?: string): Promise<OverlapRun[]> {
  // Rentang nol detik diperlakukan sebagai 1 detik agar tetap bisa ditemukan.
  const endQ = new Date(Math.max(end.getTime(), start.getTime() + 1000));
  const { rows } = await db.query<{ id: string; source: string; started_at: Date; ended_at: Date }>(
    `SELECT id, source, started_at, ended_at FROM runs
      WHERE user_id = $1 AND started_at < $3 AND ended_at > $2 AND ($4::uuid IS NULL OR id <> $4)`,
    [userId, start, endQ, excludeId ?? null],
  );
  return rows
    .map((r) => ({ id: r.id, source: r.source, start: r.started_at, end: r.ended_at }))
    .filter((r) => overlapRatio(r, { start, end }) >= OVERLAP_THRESHOLD);
}

/** Kunci per pengguna selama transaksi agar dua impor/unggahan bersamaan tidak lolos deduplikasi. */
export async function lockUserRuns(db: Queryable, userId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('runs:' || $1, 0))`, [userId]);
}

/** Hapus lari (dalam transaksi). Mengembalikan kunci foto yang harus dihapus dari penyimpanan. */
export async function deleteRuns(db: Queryable, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query<{ storage_key: string }>('DELETE FROM run_photos WHERE run_id = ANY($1::uuid[]) RETURNING storage_key', [ids]);
  await db.query('DELETE FROM runs WHERE id = ANY($1::uuid[])', [ids]);
  return rows.map((r) => r.storage_key);
}
