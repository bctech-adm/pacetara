import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { snapToGrid } from '../buddies/buddies.service.js';
import { monthWib, prevMonth } from '../league/league.service.js';
import { CHECKIN_RADIUS_M, distanceM, isCheckInOpen, makeQrToken, QR_STEP_S, qrKey, verifyQrToken } from './attendance.js';

const key = qrKey(randomBytes(32).toString('base64'));
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

describe('token QR absensi', () => {
  it('berlaku untuk step sekarang dan sebelumnya saja', () => {
    const now = 1_800_000_000_000;
    const { token, expiresAt } = makeQrToken(key, S1, now);
    expect(verifyQrToken(key, S1, token, now)).toBe('ok');
    expect(verifyQrToken(key, S1, token, now + QR_STEP_S * 1000)).toBe('ok');
    expect(verifyQrToken(key, S1, token, now + 2 * QR_STEP_S * 1000)).toBe('expired');
    expect(expiresAt.getTime()).toBeGreaterThan(now);
    expect(expiresAt.getTime() - now).toBeLessThanOrEqual(QR_STEP_S * 1000);
  });

  it('terikat ke sesi dan kunci; format rusak ditolak', () => {
    const { token } = makeQrToken(key, S1);
    expect(verifyQrToken(key, S2, token)).toBe('wrong_session');
    expect(verifyQrToken(qrKey(randomBytes(32).toString('base64')), S1, token)).toBe('invalid');
    // Mengganti sesi di token tanpa kunci tidak menghasilkan mac yang sah.
    expect(verifyQrToken(key, S2, token.replace(S1, S2))).toBe('invalid');
    for (const bad of ['', 'PTQR1', 'PTQR1.a.b.c', `PTQR1.${S1}.x.${'a'.repeat(22)}`, `XXXX.${S1}.1.${'a'.repeat(22)}`]) {
      expect(verifyQrToken(key, S1, bad)).toBe('invalid');
    }
  });
});

describe('check-in GPS', () => {
  it('jarak haversine dan jendela waktu', () => {
    const a = { lat: -6.9025, lng: 107.6187 };
    expect(distanceM(a, a)).toBe(0);
    expect(distanceM(a, { lat: a.lat + 0.001, lng: a.lng })).toBeGreaterThan(100);
    expect(distanceM(a, { lat: a.lat + 0.001, lng: a.lng })).toBeLessThan(CHECKIN_RADIUS_M);
    const start = new Date(1_800_000_000_000);
    expect(isCheckInOpen(start, start.getTime() - 31 * 60_000)).toBe(false);
    expect(isCheckInOpen(start, start.getTime() - 29 * 60_000)).toBe(true);
    expect(isCheckInOpen(start, start.getTime() + 3 * 3_600_000 + 1)).toBe(false);
  });
});

describe('cari teman & liga', () => {
  it('area dibulatkan ke titik tengah sel grid 0,02°', () => {
    expect(snapToGrid(-6.9025)).toBe(-6.91);
    expect(snapToGrid(107.6187)).toBe(107.61);
    expect(snapToGrid(-6.9001)).toBe(snapToGrid(-6.9199));
  });

  it('bulan WIB', () => {
    expect(monthWib(new Date('2026-11-30T17:30:00Z'))).toBe('2026-12-01'); // 00:30 WIB 1 Des
    expect(monthWib(new Date('2026-11-30T16:30:00Z'))).toBe('2026-11-01');
    expect(prevMonth('2026-01-01')).toBe('2025-12-01');
  });
});
