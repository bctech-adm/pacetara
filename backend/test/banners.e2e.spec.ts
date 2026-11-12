import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TokenService } from '../src/auth/token.service.js';
import { BannersService, bannerQuote } from '../src/banners/banners.service.js';
import { FieldCrypto } from '../src/crypto/field-crypto.js';
import { createTestApp, freshIp, hasTestInfra, resetData, type TestApp } from './helpers.js';

let phoneSeq = 30_000_000;

describe('harga banner', () => {
  it('tarif harian × hari × kota; nasional = faktor', () => {
    expect(bannerQuote(50_000, 7, 2, 5)).toBe(700_000);
    expect(bannerQuote(50_000, 7, 0, 5)).toBe(1_750_000);
  });
});

describe.skipIf(!hasTestInfra)('Modul 3.3 Banner sponsor (e2e)', () => {
  let t: TestApp;
  let crypto: FieldCrypto;
  let banner: Buffer;
  let eventId: string;
  let todayStr: string;

  beforeAll(async () => {
    t = await createTestApp({ BANNER_PRICE_HOME: '50000', BANNER_PRICE_EVENTS: '40000', BANNER_PRICE_EVENT_DETAIL: '30000', BANNER_NATIONAL_FACTOR: '5' });
    crypto = new FieldCrypto(t.env.DATA_ENCRYPTION_KEY, t.env.BLIND_INDEX_KEY);
    banner = await sharp({ create: { width: 1500, height: 500, channels: 3, background: '#f0590e' } }).jpeg().toBuffer();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await resetData(t);
    await t.pool.query('DELETE FROM events');
    t.storage.objects.clear();
    t.midtrans.snaps = [];
    t.midtrans.statuses.clear();
    const { rows } = await t.pool.query<{ id: string }>(
      `INSERT INTO events (name, event_date, city, categories, registration_url) VALUES ('Bandung Marathon', (now() AT TIME ZONE 'Asia/Jakarta')::date + 30, 'Bandung', '{fm}', 'https://contoh.id/daftar') RETURNING id`,
    );
    eventId = rows[0]!.id;
    todayStr = await today();
  });

  type U = { id: string; auth: { Authorization: string } };

  async function user(name = 'Pelari', opts: { level?: 1 | 2; plan?: 'free' | 'premium'; city?: string } = {}): Promise<U> {
    const id = randomUUID();
    const email = `${id}@example.com`;
    const phone = `+62819${phoneSeq++}`;
    await t.pool.query(
      `INSERT INTO users (id, email_enc, email_bidx, email_verified_at, phone_enc, phone_bidx, phone_verified_at, password_hash, display_name, plan, city,
                          privacy_accepted_at, privacy_version)
       VALUES ($1, $2, $3, now(), $4, $5, now(), 'x', $6, $7, $8, now(), 'test')`,
      [id, crypto.encrypt(email, `users.email:${id}`), crypto.blindIndex('email', email), crypto.encrypt(phone, `users.phone:${id}`), crypto.blindIndex('phone', phone), name, opts.plan ?? 'free', opts.city ?? null],
    );
    if (opts.level === 2) await t.pool.query('UPDATE users SET verification_level = 2 WHERE id = $1', [id]);
    const tokens = await t.app.get(TokenService).issue(id, 'user');
    return { id, auth: { Authorization: `Bearer ${tokens.accessToken}` } };
  }

  async function admin(): Promise<U> {
    const u = await user('Admin');
    await t.pool.query(`UPDATE users SET role = 'super_admin' WHERE id = $1`, [u.id]);
    const tokens = await t.app.get(TokenService).issue(u.id, 'super_admin', undefined, { admin: true });
    return { id: u.id, auth: { Authorization: `Bearer ${tokens.accessToken}` } };
  }

  const api = (u: U) => {
    const w = (r: request.Test) => r.set('X-Forwarded-For', freshIp()).set(u.auth);
    return {
      get: (p: string) => w(request(t.http).get(p)),
      post: (p: string, body?: object) => w(request(t.http).post(p)).send(body ?? {}),
      del: (p: string) => w(request(t.http).delete(p)),
    };
  };

  const today = async (plusDays = 0) =>
    (await t.pool.query<{ d: string }>(`SELECT to_char((now() AT TIME ZONE 'Asia/Jakarta')::date + $1::int, 'YYYY-MM-DD') AS d`, [plusDays])).rows[0]!.d;

  function createBanner(u: U, data: Record<string, unknown>, image = banner) {
    return request(t.http)
      .post('/v1/sponsor/banners')
      .set('X-Forwarded-For', freshIp())
      .set(u.auth)
      .field('data', JSON.stringify({ slot: 'home', title: 'Diskon sepatu lari', cities: ['Bandung'], startsOn: todayStr, days: 7, ...data }))
      .attach('image', image, 'banner.jpg');
  }

  /** Buat, bayar (Midtrans palsu), dan setujui satu banner. */
  async function liveBanner(sponsor: U, adm: U, data: Record<string, unknown> = {}) {
    const b = await createBanner(sponsor, data).expect(201);
    await api(sponsor).post(`/v1/sponsor/banners/${b.body.id}/pay`).expect(200);
    const orderId = t.midtrans.snaps.at(-1)!.orderId;
    await request(t.http).post('/v1/payments/midtrans/notification').send(t.midtrans.settle(orderId)).expect(200);
    await api(adm).post(`/v1/admin/banners/${b.body.id}/approve`).expect(200);
    return b.body.id as string;
  }

  it('sponsor wajib Level 2; banner dibayar lalu masuk antrean, tayang setelah disetujui', async () => {
    const lvl1 = await user('Belum KTP');
    expect((await api(lvl1).get('/v1/sponsor/config').expect(403)).body).toMatchObject({ error: 'verification_required', requiredLevel: 2 });
    const sponsor = await user('Toko Sepatu', { level: 2 });
    const adm = await admin();
    const cfg = await api(sponsor).get('/v1/sponsor/config').expect(200);
    expect(cfg.body.slots).toEqual([{ slot: 'home', perDay: 50_000 }, { slot: 'events', perDay: 40_000 }, { slot: 'event_detail', perDay: 30_000 }]);
    expect((await api(sponsor).post('/v1/sponsor/quote', { slot: 'home', days: 7, cities: 0 })).body.amount).toBe(1_750_000);

    const b = await createBanner(sponsor, {}).expect(201);
    expect(b.body).toMatchObject({ status: 'pending_payment', amount: 350_000, cities: ['bandung'], state: 'pending_payment' });
    expect([...t.storage.objects.values()][0]!.contentType).toBe('image/webp');
    const meta = await sharp([...t.storage.objects.values()][0]!.body).metadata();
    expect([meta.width, meta.height, meta.exif]).toEqual([1200, 400, undefined]);

    // Pengguna di Bandung belum melihat banner (belum dibayar/disetujui).
    const viewer = await user('Pelari Bandung');
    expect((await api(viewer).post('/v1/banners/pick', { slot: 'home', city: 'Bandung' })).body.banner).toBeNull();

    await api(sponsor).post(`/v1/sponsor/banners/${b.body.id}/pay`).expect(200);
    expect(t.midtrans.snaps[0]).toMatchObject({ amount: 350_000, finishUrl: `${t.env.DASHBOARD_URL}?paid=banner` });
    await request(t.http).post('/v1/payments/midtrans/notification').send(t.midtrans.settle(t.midtrans.snaps[0]!.orderId)).expect(200);
    expect((await api(sponsor).get('/v1/sponsor/banners')).body.items[0].status).toBe('pending_review');
    // Belum disetujui: tetap tidak tayang.
    expect((await api(viewer).post('/v1/banners/pick', { slot: 'home', city: 'Bandung' })).body.banner).toBeNull();

    const queue = await api(adm).get('/v1/admin/banners').expect(200);
    expect(queue.body.items).toEqual([expect.objectContaining({ id: b.body.id, sponsor: 'Toko Sepatu', amount: 350_000 })]);
    await api(adm).get(`/v1/admin/banners/${b.body.id}/image`).expect(200).expect('Content-Type', 'image/webp');
    await api(adm).post(`/v1/admin/banners/${b.body.id}/approve`).expect(200);
    expect((await t.pool.query(`SELECT 1 FROM admin_audit_log WHERE action = 'banner.approve' AND target_id = $1`, [b.body.id])).rowCount).toBe(1);
    expect(t.push.to(sponsor.id).some((j) => j.data?.type === 'banner_approved')).toBe(true);

    const pick = await api(viewer).post('/v1/banners/pick', { slot: 'home', city: 'bandung' }).expect(200);
    expect(pick.body.banner).toMatchObject({ id: b.body.id, title: 'Diskon sepatu lari', sponsored: true });
    await api(viewer).get(pick.body.banner.imageUrl).expect(200);
    // Kota lain, slot lain: tidak tampil.
    expect((await api(viewer).post('/v1/banners/pick', { slot: 'home', city: 'Surabaya' })).body.banner).toBeNull();
    expect((await api(viewer).post('/v1/banners/pick', { slot: 'events', city: 'Bandung' })).body.banner).toBeNull();
    // Premium tanpa iklan, termasuk banner sponsor.
    const premium = await user('Premium', { plan: 'premium' });
    expect((await api(premium).post('/v1/banners/pick', { slot: 'home', city: 'Bandung' })).body.banner).toBeNull();
  });

  it('tayangan dan klik unik per pengguna per hari; dasbor menampilkan statistik', async () => {
    const sponsor = await user('Sponsor', { level: 2 });
    const adm = await admin();
    const id = await liveBanner(sponsor, adm, { cities: [], targetUrl: 'https://toko.contoh.id/promo' });
    const a = await user('A');
    const b = await user('B');
    for (let i = 0; i < 3; i++) await api(a).post(`/v1/banners/${id}/impression`).expect(204);
    await api(b).post(`/v1/banners/${id}/impression`).expect(204);
    const click = await api(a).post(`/v1/banners/${id}/click`).expect(200);
    expect(click.body).toEqual({ eventId: null, url: 'https://toko.contoh.id/promo' });
    await api(a).post(`/v1/banners/${id}/click`).expect(200);
    const stats = await api(sponsor).get(`/v1/sponsor/banners/${id}/stats`).expect(200);
    expect(stats.body.totals).toEqual({ impressions: 2, clicks: 1, ctr: 50 });
    expect((await api(sponsor).get('/v1/sponsor/banners')).body.items[0]).toMatchObject({ impressions: 2, clicks: 1, state: 'live' });
    // Sponsor lain tidak bisa melihat statistik banner ini.
    const other = await user('Sponsor lain', { level: 2 });
    await api(other).get(`/v1/sponsor/banners/${id}/stats`).expect(404);
  });

  it('banner detail event wajib tertaut ke event dan hanya tampil di event itu; turun otomatis setelah periode', async () => {
    const sponsor = await user('Sponsor', { level: 2 });
    const adm = await admin();
    expect((await createBanner(sponsor, { slot: 'event_detail' }).expect(400)).body.error).toBe('event_required');
    expect((await createBanner(sponsor, { slot: 'event_detail', eventId: randomUUID() }).expect(404)).body.error).toBe('event_not_found');
    expect((await createBanner(sponsor, { slot: 'events', eventId, targetUrl: 'https://x.id' }).expect(400)).body.error).toBe('one_target');
    const id = await liveBanner(sponsor, adm, { slot: 'event_detail', eventId });
    const viewer = await user('Pelari', { city: 'Bandung' });
    expect((await api(viewer).post('/v1/banners/pick', { slot: 'event_detail', city: 'Bandung', eventId })).body.banner).toMatchObject({ id, eventId });
    expect((await api(viewer).post('/v1/banners/pick', { slot: 'event_detail', city: 'Bandung', eventId: randomUUID() })).body.banner).toBeNull();
    expect((await api(viewer).post(`/v1/banners/${id}/click`)).body).toEqual({ eventId, url: null });

    await t.pool.query(`UPDATE sponsor_banners SET starts_on = starts_on - 8 WHERE id = $1`, [id]);
    expect((await api(viewer).post('/v1/banners/pick', { slot: 'event_detail', city: 'Bandung', eventId })).body.banner).toBeNull();
    await api(viewer).post(`/v1/banners/${id}/impression`).expect(404);
    expect((await api(sponsor).get('/v1/sponsor/banners')).body.items[0].state).toBe('ended');
  });

  it('validasi gambar dan tanggal; ditolak admin (alasan, gambar dihapus); batal; pembersihan', async () => {
    const sponsor = await user('Sponsor', { level: 2 });
    const adm = await admin();
    const square = await sharp({ create: { width: 800, height: 800, channels: 3, background: '#000' } }).png().toBuffer();
    expect((await createBanner(sponsor, {}, square).expect(422)).body.error).toBe('invalid_ratio');
    expect((await createBanner(sponsor, {}, Buffer.from('bukan gambar')).expect(415)).body.error).toBe('unsupported_image');
    const yesterday = await today(-1);
    expect((await createBanner(sponsor, { startsOn: yesterday }).expect(400)).body.error).toBe('invalid_start');
    expect((await createBanner(sponsor, { targetUrl: 'http://tidak-aman.id' }).expect(400)).body.error).toBe('invalid_url');

    const b = await createBanner(sponsor, {}).expect(201);
    await api(sponsor).post(`/v1/sponsor/banners/${b.body.id}/pay`).expect(200);
    await request(t.http).post('/v1/payments/midtrans/notification').send(t.midtrans.settle(t.midtrans.snaps[0]!.orderId)).expect(200);
    expect((await api(sponsor).del(`/v1/sponsor/banners/${b.body.id}`).expect(409)).body.error).toBe('banner_not_cancellable');
    await api(adm).post(`/v1/admin/banners/${b.body.id}/reject`, { reason: 'Gambar memuat klaim kesehatan menyesatkan' }).expect(204);
    expect(t.storage.objects.size).toBe(0);
    expect((await api(sponsor).get('/v1/sponsor/banners')).body.items[0]).toMatchObject({ status: 'rejected', rejectReason: 'Gambar memuat klaim kesehatan menyesatkan', imageUrl: null });

    const c = await createBanner(sponsor, {}).expect(201);
    await api(sponsor).del(`/v1/sponsor/banners/${c.body.id}`).expect(204);
    const d = await createBanner(sponsor, {}).expect(201);
    await t.pool.query(`UPDATE sponsor_banners SET created_at = now() - interval '3 days' WHERE id = $1`, [d.body.id]);
    expect(await t.app.get(BannersService).cleanup()).toBe(1);
    expect(t.storage.objects.size).toBe(0);

    // Tautan bayar masih berlaku (24 jam): tidak bisa dibatalkan sendiri, dan tidak dibersihkan worker.
    const e = await createBanner(sponsor, {}).expect(201);
    await api(sponsor).post(`/v1/sponsor/banners/${e.body.id}/pay`).expect(200);
    expect((await api(sponsor).del(`/v1/sponsor/banners/${e.body.id}`).expect(409)).body.error).toBe('payment_in_progress');
    await t.pool.query(`UPDATE sponsor_banners SET created_at = now() - interval '3 days' WHERE id = $1`, [e.body.id]);
    expect(await t.app.get(BannersService).cleanup()).toBe(0);
    // Tautan kedaluwarsa: dibersihkan.
    await t.pool.query(`UPDATE payments SET created_at = now() - interval '25 hours' WHERE ref_id = $1`, [e.body.id]);
    expect(await t.app.get(BannersService).cleanup()).toBe(1);
  });

  it('disetujui setelah tanggal mulai: periode digeser ke hari ini; hapus akun sponsor', async () => {
    const sponsor = await user('Sponsor', { level: 2 });
    const adm = await admin();
    const b = await createBanner(sponsor, {}).expect(201);
    await api(sponsor).post(`/v1/sponsor/banners/${b.body.id}/pay`).expect(200);
    await request(t.http).post('/v1/payments/midtrans/notification').send(t.midtrans.settle(t.midtrans.snaps[0]!.orderId)).expect(200);
    await t.pool.query(`UPDATE sponsor_banners SET starts_on = starts_on - 3 WHERE id = $1`, [b.body.id]);
    await api(adm).post(`/v1/admin/banners/${b.body.id}/approve`).expect(200);
    expect((await api(sponsor).get('/v1/sponsor/banners')).body.items[0].startsOn).toBe(await today());

    const pending = await createBanner(sponsor, {}).expect(201);
    await t.pool.query('UPDATE users SET password_hash = NULL, google_sub = $2 WHERE id = $1', [sponsor.id, `g-${sponsor.id}`]);
    await api(sponsor).post('/v1/me/delete', { confirm: 'HAPUS' }).expect(204);
    const rows = await t.pool.query('SELECT id, sponsor_id FROM sponsor_banners ORDER BY created_at');
    expect(rows.rows).toEqual([{ id: b.body.id, sponsor_id: null }]);
    expect(rows.rows.find((r) => r.id === pending.body.id)).toBeUndefined();
  });
});
