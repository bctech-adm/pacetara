import { describe, expect, it } from 'vitest';
import { clientIp } from './realtime.service.js';

const req = (xff: string | undefined, remote = '172.18.0.2') =>
  ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } }) as Parameters<typeof clientIp>[0];

describe('clientIp (sama dengan trust proxy Express)', () => {
  it('melewati sejumlah proxy tepercaya dari kanan', () => {
    expect(clientIp(req('203.0.113.7'), 1)).toBe('203.0.113.7');
    // Klien memalsukan XFF: entri palsu di kiri diabaikan.
    expect(clientIp(req('6.6.6.6, 203.0.113.7'), 1)).toBe('203.0.113.7');
    expect(clientIp(req('203.0.113.7, 10.0.0.5'), 2)).toBe('203.0.113.7');
  });
  it('tanpa proxy memakai alamat socket', () => {
    expect(clientIp(req('6.6.6.6'), 0)).toBe('172.18.0.2');
    expect(clientIp(req(undefined), 1)).toBe('172.18.0.2');
  });
});
