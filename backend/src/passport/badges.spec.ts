import { describe, expect, it } from 'vitest';
import { type BadgeRun, computeBadges, currentStreakWeeks, isEligible, wibWeekIndex } from './badges.js';

const run = (iso: string, km: number, pace = 360): BadgeRun => ({ startedAt: new Date(iso), distanceM: km * 1000, avgPaceSPerKm: pace });

describe('badges', () => {
  it('minggu WIB dimulai Senin 00:00 WIB', () => {
    // Senin 9 Nov 2026 00:30 WIB = Minggu 8 Nov 17:30 UTC.
    const mon = wibWeekIndex(new Date('2026-11-08T17:30:00Z'));
    const sunBefore = wibWeekIndex(new Date('2026-11-08T16:30:00Z')); // Minggu 23:30 WIB
    const sunAfter = wibWeekIndex(new Date('2026-11-15T16:59:00Z')); // Minggu 15 Nov 23:59 WIB
    expect(mon).toBe(sunBefore + 1);
    expect(sunAfter).toBe(mon);
  });

  it('lari tidak sah diabaikan (< 1 km atau pace kendaraan)', () => {
    expect(isEligible(run('2026-11-01T00:00:00Z', 0.5))).toBe(false);
    expect(isEligible(run('2026-11-01T00:00:00Z', 10, 100))).toBe(false);
    expect(computeBadges([run('2026-11-01T00:00:00Z', 50, 120)]).size).toBe(0);
  });

  it('jarak pertama, total kumulatif, dan waktu tercapai', () => {
    const b = computeBadges([
      run('2026-01-05T00:00:00Z', 3),
      run('2026-01-06T00:00:00Z', 10.2),
      run('2026-01-20T00:00:00Z', 21.1),
      run('2026-02-01T00:00:00Z', 20),
    ]);
    expect(b.get('first_run')?.toISOString()).toBe('2026-01-05T00:00:00.000Z');
    expect(b.get('first_5k')?.toISOString()).toBe('2026-01-06T00:00:00.000Z');
    expect(b.get('first_10k')?.toISOString()).toBe('2026-01-06T00:00:00.000Z');
    expect(b.get('first_hm')?.toISOString()).toBe('2026-01-20T00:00:00.000Z');
    expect(b.has('first_fm')).toBe(false);
    expect(b.get('total_50')?.toISOString()).toBe('2026-02-01T00:00:00.000Z'); // 3 + 10,2 + 21,1 + 20 = 54,3
    expect(b.has('total_100')).toBe(false);
  });

  it('konsistensi: minggu berturut-turut, putus mengulang hitungan', () => {
    const weekly = (start: string, n: number) =>
      Array.from({ length: n }, (_, i) => run(new Date(new Date(start).getTime() + i * 7 * 86_400_000).toISOString(), 2));
    const b = computeBadges([...weekly('2026-01-05T01:00:00Z', 3), ...weekly('2026-02-09T01:00:00Z', 4)]);
    expect(b.get('streak_4')?.toISOString()).toBe('2026-03-02T01:00:00.000Z');
    expect(b.has('streak_12')).toBe(false);
    expect(currentStreakWeeks(weekly('2026-10-19T01:00:00Z', 4), new Date('2026-11-11T00:00:00Z'))).toBe(4);
    // Minggu ini belum lari: tetap dihitung sampai minggu lalu.
    expect(currentStreakWeeks(weekly('2026-10-12T01:00:00Z', 4), new Date('2026-11-11T00:00:00Z'))).toBe(4);
    expect(currentStreakWeeks(weekly('2026-10-05T01:00:00Z', 3), new Date('2026-11-11T00:00:00Z'))).toBe(0);
  });
});
