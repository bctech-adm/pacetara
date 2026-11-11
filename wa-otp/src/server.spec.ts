import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { maskPhone, NotOnWhatsAppError, type OtpProvider, ProviderUnavailableError, sosMessage } from './provider.js';
import { createOtpServer } from './server.js';

const SECRET = 's'.repeat(40);
const sendOtp = vi.fn<OtpProvider['sendOtp']>();
const sendSos = vi.fn<OtpProvider['sendSos']>();
const provider: OtpProvider = {
  name: 'fake',
  start: async () => {},
  stop: async () => {},
  isReady: () => true,
  sendOtp,
  sendSos,
};

const server = createOtpServer(provider, SECRET);
let base = '';

describe('wa-otp server', () => {
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = (body: unknown, secret = SECRET) =>
  fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shared-secret': secret },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  it('health menunjukkan status provider', async () => {
    const r = await fetch(`${base}/health`);
    expect(await r.json()).toEqual({ provider: 'fake', ready: true });
  });

  it('menolak rahasia yang salah', async () => {
    expect((await post({ phone: '+6281234567890', code: '123456' }, 'salah')).status).toBe(401);
    expect(sendOtp).not.toHaveBeenCalled();
  });

  it('menolak input tidak valid', async () => {
    expect((await post({ phone: '081234', code: '123456' })).status).toBe(400);
    expect((await post({ phone: '+6281234567890', code: 'abc' })).status).toBe(400);
    expect((await post('{bukan json')).status).toBe(400);
  });

  it('mengirim OTP', async () => {
    sendOtp.mockResolvedValueOnce();
    expect((await post({ phone: '+6281234567890', code: '123456' })).status).toBe(204);
    expect(sendOtp).toHaveBeenCalledWith('+6281234567890', '123456');
  });

  it('memetakan galat provider agar API bisa beralih ke email', async () => {
    sendOtp.mockRejectedValueOnce(new NotOnWhatsAppError());
    expect((await post({ phone: '+6281234567890', code: '123456' })).status).toBe(422);
    sendOtp.mockRejectedValueOnce(new ProviderUnavailableError());
    expect((await post({ phone: '+6281234567890', code: '123456' })).status).toBe(503);
    sendOtp.mockRejectedValueOnce(new Error('boom'));
    expect((await post({ phone: '+6281234567890', code: '123456' })).status).toBe(502);
  });

  it('menolak body terlalu besar', async () => {
    const r = await post({ phone: '+6281234567890', code: '123456', pad: 'x'.repeat(5000) }).catch(() => null);
    expect(r === null || r.status >= 400).toBe(true);
  });

  it('SOS: validasi input, teks disusun di layanan, nama tidak bisa menyisipkan format', async () => {
    const sos = (body: unknown) =>
      fetch(`${base}/sos`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shared-secret': SECRET }, body: JSON.stringify(body) });
    const ok = { phone: '+6281234567890', name: 'Ani', lat: -6.2, lng: 106.8, accuracyM: 12, at: '2026-11-11T00:30:00Z' };
    expect((await sos({ ...ok, lat: 200 })).status).toBe(400);
    expect((await sos({ ...ok, name: '' })).status).toBe(400);
    expect((await sos({ ...ok, text: 'pesan bebas' })).status).toBe(204);
    expect(sendSos).toHaveBeenLastCalledWith('+6281234567890', { name: 'Ani', lat: -6.2, lng: 106.8, accuracyM: 12, at: '2026-11-11T00:30:00Z' });
    sendSos.mockRejectedValueOnce(new NotOnWhatsAppError());
    expect((await sos(ok)).status).toBe(422);

    const text = sosMessage({ name: '*Ani*\nKlik link palsu', lat: -6.2, lng: 106.8, accuracyM: 12.4, at: '2026-11-11T00:30:00Z' });
    expect(text).toContain('SOS dari Ani Klik link palsu');
    expect(text).toContain('https://maps.google.com/?q=-6.200000,106.800000');
    expect(text).toContain('akurasi ±12 m, pukul 07:30 WIB');
    expect(text).not.toContain('**');
  });
});

describe('maskPhone', () => {
  it('menyamarkan bagian tengah nomor', () => {
    expect(maskPhone('+6281234567890')).toBe('+6281****7890');
  });
});
