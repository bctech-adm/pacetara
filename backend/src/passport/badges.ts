/**
 * Lencana pencapaian otomatis (PRD 2.2): jarak pertama, total jarak kumulatif, konsistensi mingguan.
 * Fungsi di sini murni (tanpa database) agar mudah diuji; BadgesService yang menyimpan hasilnya.
 */

export type BadgeGroup = 'distance' | 'total' | 'streak';

export interface BadgeDef {
  code: string;
  group: BadgeGroup;
  title: string;
  description: string;
  /** Jarak satu lari (m), total jarak (m), atau jumlah minggu berturut-turut. */
  threshold: number;
}

export const BADGES: readonly BadgeDef[] = [
  { code: 'first_run', group: 'distance', title: 'Lari pertama', description: 'Menyelesaikan lari pertama (min. 1 km)', threshold: 1000 },
  { code: 'first_5k', group: 'distance', title: '5K pertama', description: 'Menyelesaikan lari 5 km dalam sekali lari', threshold: 5000 },
  { code: 'first_10k', group: 'distance', title: '10K pertama', description: 'Menyelesaikan lari 10 km dalam sekali lari', threshold: 10_000 },
  { code: 'first_hm', group: 'distance', title: 'Half marathon pertama', description: 'Menyelesaikan lari 21,1 km dalam sekali lari', threshold: 21_097 },
  { code: 'first_fm', group: 'distance', title: 'Marathon pertama', description: 'Menyelesaikan lari 42,2 km dalam sekali lari', threshold: 42_195 },
  { code: 'total_50', group: 'total', title: '50 km', description: 'Total jarak lari 50 km', threshold: 50_000 },
  { code: 'total_100', group: 'total', title: '100 km', description: 'Total jarak lari 100 km', threshold: 100_000 },
  { code: 'total_500', group: 'total', title: '500 km', description: 'Total jarak lari 500 km', threshold: 500_000 },
  { code: 'total_1000', group: 'total', title: '1.000 km', description: 'Total jarak lari 1.000 km', threshold: 1_000_000 },
  { code: 'streak_4', group: 'streak', title: 'Konsisten 4 minggu', description: 'Lari minimal sekali seminggu selama 4 minggu berturut-turut', threshold: 4 },
  { code: 'streak_12', group: 'streak', title: 'Konsisten 12 minggu', description: 'Lari minimal sekali seminggu selama 12 minggu berturut-turut', threshold: 12 },
  { code: 'streak_26', group: 'streak', title: 'Konsisten 26 minggu', description: 'Lari minimal sekali seminggu selama 26 minggu berturut-turut', threshold: 26 },
];

export const BADGE_CODES = new Set(BADGES.map((b) => b.code));

/**
 * Lari yang sah untuk lencana: min. 1 km dan pace rata-rata tidak lebih cepat dari 2:30/km
 * (lebih cepat dari rekor dunia = kemungkinan besar kendaraan atau GPS rusak).
 */
export const MIN_BADGE_DISTANCE_M = 1000;
export const MIN_PLAUSIBLE_PACE_S_PER_KM = 150;

export interface BadgeRun {
  startedAt: Date;
  distanceM: number;
  avgPaceSPerKm: number | null;
}

export function isEligible(r: BadgeRun): boolean {
  return r.distanceM >= MIN_BADGE_DISTANCE_M && r.avgPaceSPerKm !== null && r.avgPaceSPerKm >= MIN_PLAUSIBLE_PACE_S_PER_KM;
}

const WIB_OFFSET_MS = 7 * 3600 * 1000; // Asia/Jakarta, tanpa musim panas.
const DAY_MS = 86_400_000;

/** Nomor minggu WIB (minggu mulai Senin 00:00 WIB), untuk menghitung minggu berturut-turut. */
export function wibWeekIndex(d: Date): number {
  const day = Math.floor((d.getTime() + WIB_OFFSET_MS) / DAY_MS); // hari ke-n sejak 1970-01-01 WIB (Kamis)
  // 1970-01-05 (hari ke-4) adalah Senin.
  return Math.floor((day - 4) / 7);
}

/**
 * Lencana yang tercapai dari daftar lari, beserta waktu tercapainya (waktu mulai lari yang
 * memenuhinya). Lari yang tidak sah diabaikan.
 */
export function computeBadges(runs: BadgeRun[]): Map<string, Date> {
  const out = new Map<string, Date>();
  const sorted = runs.filter(isEligible).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

  let total = 0;
  let prevWeek: number | null = null;
  let streak = 0;
  for (const r of sorted) {
    for (const b of BADGES) {
      if (out.has(b.code)) continue;
      if (b.group === 'distance' && r.distanceM >= b.threshold) out.set(b.code, r.startedAt);
    }
    total += r.distanceM;
    for (const b of BADGES) {
      if (!out.has(b.code) && b.group === 'total' && total >= b.threshold) out.set(b.code, r.startedAt);
    }
    const week = wibWeekIndex(r.startedAt);
    if (week !== prevWeek) {
      streak = prevWeek !== null && week === prevWeek + 1 ? streak + 1 : 1;
      prevWeek = week;
      for (const b of BADGES) {
        if (!out.has(b.code) && b.group === 'streak' && streak >= b.threshold) out.set(b.code, r.startedAt);
      }
    }
  }
  return out;
}

/** Minggu berturut-turut sampai minggu ini (minggu ini belum lari = dihitung sampai minggu lalu). */
export function currentStreakWeeks(runs: BadgeRun[], now = new Date()): number {
  const weeks = new Set(runs.filter(isEligible).map((r) => wibWeekIndex(r.startedAt)));
  let w = wibWeekIndex(now);
  if (!weeks.has(w)) w -= 1;
  let n = 0;
  while (weeks.has(w)) {
    n++;
    w--;
  }
  return n;
}
