/**
 * Perhitungan rute di server. Aplikasi mengirim titik GPS mentah (sudah disaring ringan); server
 * membersihkan ulang dan menghitung statistik sendiri agar jarak tidak bisa dikarang oleh klien
 * (penting untuk liga dan papan peringkat di Fase 2).
 */

/** [lat, lng, detik sejak mulai, ketinggian m | null] */
export type Point = [number, number, number, number | null];

const EARTH_R = 6_371_008.8;
/** 12,5 m/s ≈ 45 km/jam: di atas ini dianggap lompatan GPS, bukan lari. */
export const MAX_SPEED_MPS = 12.5;
/** Jeda lebih lama dari ini antara dua titik tidak dihitung sebagai waktu bergerak. */
const MAX_GAP_S = 30;

const rad = (d: number) => (d * Math.PI) / 180;

export function haversine(a: Pick<Point, 0 | 1> | readonly number[], b: Pick<Point, 0 | 1> | readonly number[]): number {
  const [lat1, lng1] = a as number[];
  const [lat2, lng2] = b as number[];
  const dLat = rad(lat2! - lat1!);
  const dLng = rad(lng2! - lng1!);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1!)) * Math.cos(rad(lat2!)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Membuang titik yang waktunya mundur, duplikat, atau melompat lebih cepat dari MAX_SPEED_MPS. */
export function cleanPoints(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const prev = out.at(-1);
    if (!prev) {
      out.push(p);
      continue;
    }
    const dt = p[2] - prev[2];
    if (dt <= 0) continue;
    const d = haversine(prev, p);
    if (d / dt > MAX_SPEED_MPS) continue;
    out.push(p);
  }
  return out;
}

/**
 * Statistik dari titik yang sudah bersih. `segments` = potongan rute antara jeda (pause); jarak
 * antar-segmen tidak dihitung. Waktu bergerak = jumlah selisih waktu antartitik dalam segmen
 * (selisih > MAX_GAP_S dianggap berhenti).
 */
export function computeStats(segments: Point[][]) {
  let distance = 0;
  let moving = 0;
  let gain = 0;
  let hasAlt = false;
  for (const seg of segments) {
    for (let i = 1; i < seg.length; i++) {
      const a = seg[i - 1]!;
      const b = seg[i]!;
      distance += haversine(a, b);
      const dt = b[2] - a[2];
      if (dt > 0 && dt <= MAX_GAP_S) moving += dt;
      if (a[3] !== null && b[3] !== null) {
        hasAlt = true;
        const up = b[3] - a[3];
        if (up > 0) gain += up;
      }
    }
  }
  const distanceM = Math.round(distance);
  const movingS = Math.round(moving);
  return {
    distanceM,
    movingTimeS: movingS,
    // Pace hanya bermakna untuk jarak minimal 100 m.
    avgPaceSPerKm: distanceM >= 100 && movingS > 0 ? Math.round(movingS / (distanceM / 1000)) : null,
    elevationGainM: hasAlt ? Math.round(gain) : null,
  };
}

/**
 * Zona privasi: menyembunyikan semua titik dalam `radiusM` dari titik AWAL dan titik AKHIR rute,
 * termasuk bagian tengah rute yang kebetulan lewat dekat rumah lagi. Hasilnya bisa kosong jika
 * seluruh lari berada di dalam zona (lari keliling kompleks): itu disengaja.
 */
export function applyPrivacyZone(segments: Point[][], radiusM: number): Point[][] {
  const all = segments.flat();
  const start = all[0];
  const end = all.at(-1);
  if (!start || !end) return [];
  const result: Point[][] = [];
  for (const seg of segments) {
    let current: Point[] = [];
    for (const p of seg) {
      const hidden = haversine(p, start) < radiusM || haversine(p, end) < radiusM;
      if (hidden) {
        if (current.length > 1) result.push(current);
        current = [];
      } else {
        current.push(p);
      }
    }
    if (current.length > 1) result.push(current);
  }
  return result;
}

/** Membulatkan koordinat ke 5 desimal (~1 m) untuk disimpan/ditampilkan. */
export function roundSegments(segments: Point[][]): Point[][] {
  return segments.map((s) =>
    s.map(([lat, lng, t, alt]) => [
      Math.round(lat * 1e5) / 1e5,
      Math.round(lng * 1e5) / 1e5,
      Math.round(t),
      alt === null ? null : Math.round(alt),
    ]),
  );
}
