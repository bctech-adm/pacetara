import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Absensi (modul 2.6, Komunitas Pro). Fungsi murni: token QR berputar dan jarak check-in GPS.
 *
 * QR = `PTQR1.<sessionId>.<step>.<mac>`; step = floor(waktu / QR_STEP_S); mac = HMAC-SHA256(kunci turunan
 * BLIND_INDEX_KEY, "<sessionId>:<step>") dipotong 16 byte (base64url). Token terikat ke satu sesi (tidak bisa dipakai
 * di sesi lain) dan hanya diterima untuk step sekarang atau sebelumnya (berlaku maks. 2 x QR_STEP_S). Aplikasi admin
 * mengambil token baru tiap ~QR_STEP_S detik. Satu anggota hanya bisa hadir sekali per sesi (PK database).
 */
export const QR_STEP_S = 30;
const QR_PREFIX = 'PTQR1';

/** Jendela check-in: dari 30 menit sebelum mulai sampai 3 jam setelah mulai. */
export const CHECKIN_OPENS_BEFORE_MS = 30 * 60_000;
export const CHECKIN_CLOSES_AFTER_MS = 3 * 3_600_000;

/** Check-in GPS: posisi anggota maks. 200 m dari titik kumpul, akurasi GPS maks. 100 m. */
export const CHECKIN_RADIUS_M = 200;
export const CHECKIN_MAX_ACCURACY_M = 100;

export function qrKey(blindIndexKeyB64: string): Buffer {
  return createHmac('sha256', Buffer.from(blindIndexKeyB64, 'base64')).update('pacetara:attendance-qr:v1').digest();
}

function mac(key: Buffer, sessionId: string, step: number): string {
  return createHmac('sha256', key).update(`${sessionId}:${step}`).digest().subarray(0, 16).toString('base64url');
}

export function qrStep(now = Date.now()): number {
  return Math.floor(now / 1000 / QR_STEP_S);
}

export function makeQrToken(key: Buffer, sessionId: string, now = Date.now()): { token: string; expiresAt: Date } {
  const step = qrStep(now);
  return { token: `${QR_PREFIX}.${sessionId}.${step}.${mac(key, sessionId, step)}`, expiresAt: new Date((step + 1) * QR_STEP_S * 1000) };
}

export type QrCheck = 'ok' | 'invalid' | 'expired' | 'wrong_session';

export function verifyQrToken(key: Buffer, sessionId: string, token: string, now = Date.now()): QrCheck {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== QR_PREFIX || !/^\d{1,12}$/.test(parts[2]!) || !/^[A-Za-z0-9_-]{22}$/.test(parts[3]!)) return 'invalid';
  const [, sid, stepRaw, sig] = parts as [string, string, string, string];
  const step = Number(stepRaw);
  const expected = Buffer.from(mac(key, sid, step));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'invalid';
  if (sid !== sessionId) return 'wrong_session';
  const current = qrStep(now);
  if (step !== current && step !== current - 1) return 'expired';
  return 'ok';
}

/** Jarak permukaan bumi (meter), rumus haversine. */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function checkInWindow(startsAt: Date): { opensAt: Date; closesAt: Date } {
  return { opensAt: new Date(startsAt.getTime() - CHECKIN_OPENS_BEFORE_MS), closesAt: new Date(startsAt.getTime() + CHECKIN_CLOSES_AFTER_MS) };
}

export function isCheckInOpen(startsAt: Date, now = Date.now()): boolean {
  const w = checkInWindow(startsAt);
  return now >= w.opensAt.getTime() && now <= w.closesAt.getTime();
}
