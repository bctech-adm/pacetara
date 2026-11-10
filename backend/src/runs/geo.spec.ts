import { describe, expect, it } from 'vitest';
import { applyPrivacyZone, cleanPoints, computeStats, haversine, type Point } from './geo.js';

/** Rute lurus ke utara dari Bandung: `meters` panjangnya, satu titik tiap `step` m, pace `pace` dtk/km. */
export function straightRoute(meters: number, step = 10, pace = 360, start: [number, number] = [-6.9, 107.6]): Point[] {
  const degPerM = 1 / 111_195;
  const pts: Point[] = [];
  for (let d = 0; d <= meters; d += step) {
    pts.push([start[0] + d * degPerM, start[1], (d / 1000) * pace, 700]);
  }
  return pts;
}

describe('geo', () => {
  it('haversine: 1 derajat lintang ≈ 111,2 km', () => {
    expect(haversine([0, 0], [1, 0])).toBeCloseTo(111_195, -2);
  });

  it('lari 5 km terhitung 5 km dengan pace yang benar', () => {
    const stats = computeStats([cleanPoints(straightRoute(5000))]);
    expect(stats.distanceM).toBeGreaterThan(4990);
    expect(stats.distanceM).toBeLessThan(5010);
    expect(stats.movingTimeS).toBe(1800);
    expect(stats.avgPaceSPerKm).toBeCloseTo(360, -1);
  });

  it('lompatan GPS (mobil/teleport) dibuang', () => {
    const route = straightRoute(1000);
    route.splice(50, 0, [-6.5, 107.6, route[50]![2] - 0.5, 700]); // lompat ~44 km dalam setengah detik
    const stats = computeStats([cleanPoints(route)]);
    expect(stats.distanceM).toBeLessThan(1010);
  });

  it('jeda: jarak dan waktu antar-segmen tidak dihitung', () => {
    const a = straightRoute(1000);
    const b = straightRoute(1000, 10, 360, [-6.89, 107.6]).map(([lat, lng, t, alt]) => [lat, lng, t + 3600, alt] as Point);
    const stats = computeStats([a, b]);
    expect(stats.distanceM).toBeLessThan(2010);
    expect(stats.movingTimeS).toBe(720);
  });

  it('zona privasi menyembunyikan titik di sekitar awal dan akhir', () => {
    const route = straightRoute(3000);
    const [visible] = applyPrivacyZone([route], 250);
    expect(visible).toBeDefined();
    const start = route[0]!;
    const end = route.at(-1)!;
    for (const p of visible!) {
      expect(haversine(p, start)).toBeGreaterThanOrEqual(250);
      expect(haversine(p, end)).toBeGreaterThanOrEqual(250);
    }
  });

  it('lari putar balik ke rumah: bagian tengah yang lewat dekat rumah juga disembunyikan', () => {
    const out = straightRoute(1500);
    const back = [...out].reverse().map(([lat, lng], i) => [lat, lng, 540 + i * 3.6, 700] as Point);
    const zoned = applyPrivacyZone([[...out, ...back.slice(1)]], 300);
    for (const p of zoned.flat()) expect(haversine(p, out[0]!)).toBeGreaterThanOrEqual(300);
  });

  it('lari seluruhnya di dalam zona privasi menghasilkan rute publik kosong', () => {
    expect(applyPrivacyZone([straightRoute(200)], 250)).toEqual([]);
  });
});
