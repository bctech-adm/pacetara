import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TokenService } from '../src/auth/token.service.js';
import { FieldCrypto } from '../src/crypto/field-crypto.js';
import { MarketOrderSync } from '../src/market/market-orders.js';
import { MAX_ACTIVE_LISTINGS } from '../src/market/market.service.js';
import { PaymentsService } from '../src/payments/payments.service.js';
import { createTestApp, FakeXendit, freshIp, hasTestInfra, resetData, type TestApp } from './helpers.js';

let phoneSeq = 20_000_000;

describe.skipIf(!hasTestInfra)('Modul 3.2 Marketplace (e2e)', () => {
  let t: TestApp;
  let crypto: FieldCrypto;
  let photo: Buffer;
  const POLICY = '2026-11-12';

  beforeAll(async () => {
    t = await createTestApp({
      XENDIT_MASTER_ACCOUNT_ID: 'master_pt',
      AFFILIATE_TEMPLATES: '{"shopee.co.id":"https://aff.shopee.co.id/r?u={url}&id=PT"}',
      MARKET_POLICY_VERSION: POLICY,
    });
    crypto = new FieldCrypto(t.env.DATA_ENCRYPTION_KEY, t.env.BLIND_INDEX_KEY);
    photo = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#3366aa' } }).jpeg().toBuffer();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await resetData(t);
    t.xendit.enabled = true;
    t.xendit.accounts.clear();
    t.xendit.invoices.clear();
    t.xendit.splitRules = [];
    t.midtrans.snaps = [];
    t.midtrans.statuses.clear();
    t.storage.objects.clear();
    await t.pool.query('DELETE FROM provider_settings');
  });

  type U = { id: string; email: string; auth: { Authorization: string } };

  async function user(name = 'Pelari', opts: { level?: 1 | 2; policy?: boolean } = {}): Promise<U> {
    const id = randomUUID();
    const email = `${id}@example.com`;
    const phone = `+62818${phoneSeq++}`;
    await t.pool.query(
      `INSERT INTO users (id, email_enc, email_bidx, email_verified_at, phone_enc, phone_bidx, phone_verified_at, password_hash, display_name,
                          privacy_accepted_at, privacy_version, market_policy_version)
       VALUES ($1, $2, $3, now(), $4, $5, now(), 'x', $6, now(), 'test', $7)`,
      [id, crypto.encrypt(email, `users.email:${id}`), crypto.blindIndex('email', email), crypto.encrypt(phone, `users.phone:${id}`), crypto.blindIndex('phone', phone), name, opts.policy === false ? null : POLICY],
    );
    if (opts.level === 2) await t.pool.query('UPDATE users SET verification_level = 2 WHERE id = $1', [id]);
    const tokens = await t.app.get(TokenService).issue(id, 'user');
    return { id, email, auth: { Authorization: `Bearer ${tokens.accessToken}` } };
  }

  async function admin(): Promise<U> {
    const u = await user('Admin');
    await t.pool.query(`UPDATE users SET role = 'super_admin' WHERE id = $1`, [u.id]);
    const tokens = await t.app.get(TokenService).issue(u.id, 'super_admin', undefined, { admin: true });
    return { ...u, auth: { Authorization: `Bearer ${tokens.accessToken}` } };
  }

  const api = (u: U) => {
    const w = (r: request.Test) => r.set('X-Forwarded-For', freshIp()).set(u.auth);
    return {
      get: (p: string) => w(request(t.http).get(p)),
      post: (p: string, body?: object) => w(request(t.http).post(p)).send(body ?? {}),
      patch: (p: string, body: object) => w(request(t.http).patch(p)).send(body),
      del: (p: string) => w(request(t.http).delete(p)),
    };
  };

  function createListing(u: U, data: Record<string, unknown>, photos = 1) {
    let r = request(t.http)
      .post('/v1/market/listings')
      .set('X-Forwarded-For', freshIp())
      .set(u.auth)
      .field('data', JSON.stringify({ title: 'Sepatu lari bekas', category: 'shoes', condition: 'used', price: 450_000, city: 'Bandung', description: 'Ukuran 42', ...data }));
    for (let i = 0; i < photos; i++) r = r.attach('photos', photo, `p${i}.jpg`);
    return r;
  }

  /** Penjual Level 2 dengan akun Xendit live dan satu listing split. */
  async function liveSeller(stock = 2) {
    const s = await user('Toko Lari', { level: 2 });
    await api(s).post('/v1/market/seller').expect(200);
    const acct = [...t.xendit.accounts.keys()].at(-1)!;
    t.xendit.accounts.get(acct)!.status = 'LIVE';
    await request(t.http).post('/v1/market/xendit/account').set('x-callback-token', FakeXendit.TOKEN).send({ data: { id: acct } }).expect(200);
    const l = await createListing(s, { model: 'split', stock, price: 200_000 }).expect(201);
    return { seller: s, acct, listingId: l.body.id as string };
  }

  const xenditPay = async (invoiceUrl: string) => {
    const id = invoiceUrl.split('/').at(-1)!;
    t.xendit.invoices.get(id)!.status = 'PAID';
    const inv = t.xendit.invoices.get(id)!;
    await request(t.http).post('/v1/market/xendit/invoice').set('x-callback-token', FakeXendit.TOKEN).send({ external_id: inv.external_id, status: 'PAID' }).expect(200);
  };

  it('kebijakan transaksi wajib sebelum memasang; listing afiliasi tayang dan tautan memakai template afiliasi', async () => {
    const s = await user('Penjual', { policy: false });
    const cfg = await api(s).get('/v1/market/config').expect(200);
    expect(cfg.body).toMatchObject({ policyAccepted: false, policyVersion: POLICY, fee: { percent: 5, flat: 0 }, splitEnabled: true });
    expect((await createListing(s, { model: 'affiliate', affiliateUrl: 'https://shopee.co.id/p/1' }).expect(428)).body.error).toBe('policy_required');
    expect((await api(s).post('/v1/market/policy', { version: '2020-01-01' }).expect(428)).body.error).toBe('policy_outdated');
    await api(s).post('/v1/market/policy', { version: POLICY }).expect(200);

    expect((await createListing(s, { model: 'affiliate', affiliateUrl: 'https://shopee.co.id.evil.com/p' }).expect(400)).body.error).toBe('invalid_affiliate_url');
    expect((await createListing(s, { model: 'affiliate', affiliateUrl: 'https://shopee.co.id/p/1' }, 0).expect(400)).body.error).toBe('photos_required');
    const res = await createListing(s, { model: 'affiliate', affiliateUrl: 'https://shopee.co.id/p/1' }, 2).expect(201);
    expect(res.body).toMatchObject({ model: 'affiliate', status: 'active', mine: true, canBuy: false, photos: [expect.any(String), expect.any(String)] });
    expect(t.storage.objects.size).toBe(2);

    const b = await user('Pembeli');
    const found = await api(b).post('/v1/market/listings/search', { q: 'sepatu', city: 'bandung' }).expect(200);
    expect(found.body.items.map((x: { id: string }) => x.id)).toEqual([res.body.id]);
    await api(b).get(res.body.photos[0]).expect(200).expect('Content-Type', 'image/webp');
    const go = await api(b).post(`/v1/market/listings/${res.body.id}/go`).expect(200);
    expect(go.body.url).toBe('https://aff.shopee.co.id/r?u=https%3A%2F%2Fshopee.co.id%2Fp%2F1&id=PT');
    expect((await api(s).get(`/v1/market/listings/${res.body.id}`)).body.clicks).toBe(1);
  });

  it('biaya listing dan boost dibayar lewat Midtrans; status dipastikan ulang ke API dan efek diterapkan sekali', async () => {
    const s = await user('Penjual');
    const l = await createListing(s, { model: 'listing_fee' }).expect(201);
    expect(l.body.status).toBe('pending_payment');
    const b = await user('Pembeli');
    expect((await api(b).post('/v1/market/listings/search', {})).body.items).toHaveLength(0);
    await api(b).get(`/v1/market/listings/${l.body.id}`).expect(404);

    // Bukan pemilik tidak bisa membuat pembayaran untuk listing orang lain.
    await api(b).post(`/v1/market/listings/${l.body.id}/pay`, { purpose: 'listing_fee' }).expect(404);
    const pay = await api(s).post(`/v1/market/listings/${l.body.id}/pay`, { purpose: 'listing_fee' }).expect(200);
    expect(pay.body.redirectUrl).toMatch(/^https:\/\/app\.sandbox\.midtrans\.com\//);
    // Pemanggilan ulang memakai transaksi menunggu yang sama.
    expect((await api(s).post(`/v1/market/listings/${l.body.id}/pay`, { purpose: 'listing_fee' })).body.paymentId).toBe(pay.body.paymentId);
    const snap = t.midtrans.snaps[0]!;
    expect(snap).toMatchObject({ amount: 15_000, finishUrl: `${t.env.DASHBOARD_URL}?paid=listing` });
    expect(snap.orderId).not.toContain(s.id);

    const notify = (body: object) => request(t.http).post('/v1/payments/midtrans/notification').send(body);
    const good = t.midtrans.settle(snap.orderId);
    await notify({ ...good, signature_key: 'x'.repeat(128) }).expect(401);
    // Nominal di Midtrans berbeda dari catatan kita: tidak diterapkan.
    const wrong = t.midtrans.settle(snap.orderId, 'settlement', '1.00');
    await notify(wrong).expect(200);
    expect((await api(s).get(`/v1/market/listings/${l.body.id}`)).body.status).toBe('pending_payment');

    await notify(t.midtrans.settle(snap.orderId, 'settlement', '15000.00')).expect(200);
    const after = await api(s).get(`/v1/market/listings/${l.body.id}`).expect(200);
    expect(after.body.status).toBe('active');
    const days = (new Date(after.body.activeUntil).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    await notify(t.midtrans.settle(snap.orderId)).expect(200);
    expect(new Date((await api(s).get(`/v1/market/listings/${l.body.id}`)).body.activeUntil).getTime()).toBe(new Date(after.body.activeUntil).getTime());
    const paid = await api(s).get('/v1/payments/mine').expect(200);
    expect(paid.body.items[0]).toMatchObject({ purpose: 'listing_fee', status: 'paid', applied: true, amount: 15_000, redirectUrl: null });
    expect(t.push.to(s.id).some((j) => j.data?.type === 'market_listing_paid')).toBe(true);

    // Boost: tampil paling atas.
    await createListing(s, { model: 'affiliate', affiliateUrl: 'https://www.tokopedia.com/x/1', title: 'Jam lari baru' }).expect(201);
    expect((await api(b).post('/v1/market/listings/search', {})).body.items[0].title).toBe('Jam lari baru');
    await api(s).post(`/v1/market/listings/${l.body.id}/pay`, { purpose: 'listing_boost' }).expect(200);
    await notify(t.midtrans.settle(t.midtrans.snaps[1]!.orderId)).expect(200);
    const top = (await api(b).post('/v1/market/listings/search', {})).body.items[0];
    expect(top).toMatchObject({ id: l.body.id, boosted: true });

    // Rekonsiliasi worker juga bisa menerapkan pembayaran yang notifikasinya hilang.
    await t.pool.query(`UPDATE payments SET created_at = now() - interval '1 hour'`);
    expect(await t.app.get(PaymentsService).reconcile()).toMatchObject({ expired: 0 });
  });

  it('split payment: Level 2 + akun Xendit live; pesanan, invoice dengan split rule, bayar, kirim, selesai', async () => {
    const lvl1 = await user('Belum KTP');
    expect((await createListing(lvl1, { model: 'split', stock: 1 }).expect(403)).body).toMatchObject({ error: 'verification_required', requiredLevel: 2 });
    expect((await api(lvl1).post('/v1/market/seller').expect(403)).body.error).toBe('verification_required');
    const lvl2 = await user('Sudah KTP', { level: 2 });
    expect((await createListing(lvl2, { model: 'split', stock: 1 }).expect(409)).body.error).toBe('seller_not_live');
    await api(lvl2).post('/v1/market/seller').expect(200);
    expect([...t.xendit.accounts.values()][0]!.email).toBe(lvl2.email);
    expect((await api(lvl2).get('/v1/market/seller')).body.status).toBe('invited');
    await request(t.http).post('/v1/market/xendit/account').set('x-callback-token', 'salah').send({ data: { id: 'acc_1' } }).expect(401);

    const { seller, acct, listingId } = await liveSeller(2);
    expect(t.push.to(seller.id).some((j) => j.data?.type === 'market_seller_live')).toBe(true);
    const buyer = await user('Pembeli');
    const detail = await api(buyer).get(`/v1/market/listings/${listingId}`).expect(200);
    expect(detail.body).toMatchObject({ canBuy: true, stock: 2, seller: { displayName: 'Toko Lari', verified: true } });

    expect((await api(seller).post(`/v1/market/listings/${listingId}/orders`, { qty: 1 }).expect(400)).body.error).toBe('invalid_target');
    expect((await api(buyer).post(`/v1/market/listings/${listingId}/orders`, { qty: 3 }).expect(409)).body.error).toBe('out_of_stock');
    const o = await api(buyer).post(`/v1/market/listings/${listingId}/orders`, { qty: 1 }).expect(201);
    expect(o.body).toMatchObject({ status: 'pending', amount: 200_000, role: 'buyer', invoiceUrl: expect.stringMatching(/^https:\/\/checkout\.xendit\.co\//) });
    expect(o.body.fee).toBeUndefined(); // komisi tidak ditampilkan ke pembeli
    const inv = [...t.xendit.invoices.values()][0]!;
    expect(inv).toMatchObject({ forUserId: acct, amount: 200_000, splitRuleId: t.xendit.splitRules[0]!.id });
    expect(t.xendit.splitRules).toEqual([expect.objectContaining({ percent: 5, destinationAccountId: 'master_pt' })]);
    expect((await api(buyer).get(`/v1/market/listings/${listingId}`)).body.stock).toBe(1);

    await request(t.http).post('/v1/market/xendit/invoice').set('x-callback-token', 'salah').send({ external_id: inv.external_id }).expect(401);
    // Callback "PAID" palsu tanpa invoice benar-benar lunas di Xendit: diabaikan.
    await request(t.http).post('/v1/market/xendit/invoice').set('x-callback-token', FakeXendit.TOKEN).send({ external_id: inv.external_id, status: 'PAID' }).expect(200);
    expect((await api(buyer).get(`/v1/market/orders/${o.body.id}`)).body.status).toBe('pending');
    await xenditPay(o.body.invoiceUrl);
    const sellerView = await api(seller).get(`/v1/market/orders/${o.body.id}`).expect(200);
    expect(sellerView.body).toMatchObject({ status: 'paid', fee: 10_000, sellerReceives: 190_000, role: 'seller', invoiceUrl: null });
    expect(t.push.to(seller.id).some((j) => j.data?.type === 'market_order_paid')).toBe(true);

    expect((await api(buyer).post(`/v1/market/orders/${o.body.id}/ship`).expect(404)).body.error).toBe('order_not_found');
    await api(seller).post(`/v1/market/orders/${o.body.id}/ship`, { trackingNote: 'JNE 1234' }).expect(200);
    await api(buyer).post(`/v1/market/orders/${o.body.id}/complete`).expect(200);
    expect((await api(seller).get(`/v1/market/orders/${o.body.id}`)).body.status).toBe('completed');
    const other = await user('Orang lain');
    await api(other).get(`/v1/market/orders/${o.body.id}`).expect(404);

    // Split rule dipakai ulang untuk pesanan berikutnya.
    await api(buyer).post(`/v1/market/listings/${listingId}/orders`, { qty: 1 }).expect(201);
    expect(t.xendit.splitRules).toHaveLength(1);
  });

  it('hubungi penjual membuka chat pribadi; batal, kedaluwarsa, dan selesai otomatis', async () => {
    const { seller, listingId } = await liveSeller(3);
    const buyer = await user('Pembeli');
    // Belum terhubung: chat pribadi ditolak (tidak satu komunitas).
    expect((await api(buyer).post("/v1/chat/direct", { userId: seller.id }).expect(403)).body.error).toBe("no_shared_community");
    const conv = await api(buyer).post(`/v1/market/listings/${listingId}/contact`).expect(200);
    expect(conv.body.id).toBeDefined();
    await api(buyer).post(`/v1/chat/conversations/${conv.body.id}/messages`, { clientMsgId: randomUUID(), kind: 'text', text: 'Masih ada ukuran 42?' }).expect(201);

    const o1 = await api(buyer).post(`/v1/market/listings/${listingId}/orders`, { qty: 2 }).expect(201);
    await api(buyer).post(`/v1/market/orders/${o1.body.id}/cancel`).expect(200);
    expect((await api(buyer).get(`/v1/market/listings/${listingId}`)).body.stock).toBe(3);
    expect(t.xendit.invoices.get(o1.body.invoiceUrl.split('/').at(-1))!.status).toBe('EXPIRED');

    const o2 = await api(buyer).post(`/v1/market/listings/${listingId}/orders`, { qty: 1 }).expect(201);
    // Satu pesanan menunggu per listing per pembeli (stok tidak bisa ditahan berlapis).
    expect((await api(buyer).post(`/v1/market/listings/${listingId}/orders`, { qty: 1 }).expect(409)).body.error).toBe('order_pending');
    const buyer2 = await user('Pembeli Dua');
    const o3 = await api(buyer2).post(`/v1/market/listings/${listingId}/orders`, { qty: 1 }).expect(201);
    await xenditPay(o3.body.invoiceUrl);
    await api(seller).post(`/v1/market/orders/${o3.body.id}/ship`).expect(200);
    await t.pool.query(`UPDATE market_orders SET created_at = now() - interval '3 hours' WHERE id = $1`, [o2.body.id]);
    await t.pool.query(`UPDATE market_orders SET shipped_at = now() - interval '8 days' WHERE id = $1`, [o3.body.id]);
    await t.pool.query(`UPDATE market_listings SET active_until = now() - interval '1 minute' WHERE id <> $1`, [listingId]);
    const r = await t.app.get(MarketOrderSync).maintenance();
    expect(r).toMatchObject({ expiredOrders: 1, autoCompleted: 1 });
    expect((await api(buyer).get(`/v1/market/orders/${o2.body.id}`)).body.status).toBe('expired');
    expect((await api(buyer2).get(`/v1/market/orders/${o3.body.id}`)).body.status).toBe('completed');
    expect((await api(buyer).get(`/v1/market/listings/${listingId}`)).body.stock).toBe(2);
  });

  it('sengketa diputuskan admin (tercatat); sanksi penjual menyembunyikan listing split', async () => {
    const { seller, listingId } = await liveSeller(2);
    const buyer = await user('Pembeli');
    const adm = await admin();
    const o = await api(buyer).post(`/v1/market/listings/${listingId}/orders`, { qty: 1 }).expect(201);
    expect((await api(buyer).post(`/v1/market/orders/${o.body.id}/dispute`, { reason: 'Barang belum datang dua minggu' }).expect(409)).body.error).toBe('invalid_order_state');
    await xenditPay(o.body.invoiceUrl);
    await api(buyer).post(`/v1/market/orders/${o.body.id}/dispute`, { reason: 'Barang tidak sesuai foto, sol robek' }).expect(200);
    expect(t.push.to(seller.id).some((j) => j.data?.type === 'market_order_disputed')).toBe(true);

    const list = await api(adm).get('/v1/admin/market/orders?status=disputed').expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('sol robek');
    const reason = await api(adm).get(`/v1/admin/market/orders/${o.body.id}/dispute`).expect(200);
    expect(reason.body.reason).toBe('Barang tidak sesuai foto, sol robek');
    await api(adm).post(`/v1/admin/market/orders/${o.body.id}/resolve`, { outcome: 'refunded', note: 'Refund penuh lewat dasbor Xendit' }).expect(204);
    expect((await api(buyer).get(`/v1/market/orders/${o.body.id}`)).body).toMatchObject({ status: 'refunded', resolutionNote: 'Refund penuh lewat dasbor Xendit' });
    const logs = await t.pool.query(`SELECT action FROM admin_audit_log WHERE target_id = $1 ORDER BY id`, [o.body.id]);
    expect(logs.rows.map((r) => r.action)).toEqual(['market.view_dispute', 'market.resolve_refunded']);

    await api(adm).post(`/v1/admin/market/sellers/${seller.id}/suspend`, { reason: 'Banyak sengketa' }).expect(204);
    expect((await api(buyer).post('/v1/market/listings/search', {})).body.items).toHaveLength(0);
    await api(buyer).get(`/v1/market/listings/${listingId}`).expect(404);
    await api(adm).post(`/v1/admin/market/sellers/${seller.id}/restore`, { reason: 'Sudah diperbaiki' }).expect(204);
    // Pulih = status disinkron ulang dari Xendit (masih LIVE).
    expect((await api(seller).get('/v1/market/seller')).body.status).toBe('live');
  });

  it('laporan listing: 3 pelapor menyembunyikan, turunkan menghapus foto', async () => {
    const s = await user('Penjual');
    const adm = await admin();
    const l = await createListing(s, { model: 'affiliate', affiliateUrl: 'https://www.tokopedia.com/x/2' }, 2).expect(201);
    expect((await api(s).post('/v1/reports', { targetType: 'listing', targetId: l.body.id, reason: 'scam' }).expect(400)).body.error).toBe('cannot_report_self');
    for (let i = 0; i < 3; i++) {
      const r = await user(`Pelapor ${i}`);
      await api(r).post('/v1/reports', { targetType: 'listing', targetId: l.body.id, reason: 'scam' }).expect(201);
      // Penjual listing tayang juga bisa dilaporkan sebagai pengguna.
      if (i === 0) await api(r).post('/v1/reports', { targetType: 'user', targetId: s.id, reason: 'scam' }).expect(201);
    }
    const b = await user('Pembeli');
    expect((await api(b).post('/v1/market/listings/search', {})).body.items).toHaveLength(0);
    expect((await api(s).get(`/v1/market/listings/${l.body.id}`)).body.hidden).toBe(true);
    expect((await api(s).del(`/v1/market/listings/${l.body.id}`).expect(409)).body.error).toBe('content_held');
    expect((await api(s).patch(`/v1/market/listings/${l.body.id}`, { title: 'Judul baru yang bersih' }).expect(409)).body.error).toBe('content_held');
    expect((await api(s).post(`/v1/market/listings/${l.body.id}/renew`).expect(409)).body.error).toBe('content_held');

    const detail = await api(adm).get(`/v1/admin/reports/listing/${l.body.id}`).expect(200);
    expect(detail.body.target).toMatchObject({ title: 'Sepatu lari bekas', seller: { id: s.id }, photos: 2 });
    await api(adm).post(`/v1/admin/reports/listing/${l.body.id}/resolve`, { action: 'remove' }).expect(204);
    expect(t.storage.objects.size).toBe(0);
    await api(s).get(`/v1/market/listings/${l.body.id}`).expect(404);
  });

  it('cabut Level 2 menghentikan split; renew listing kedaluwarsa dihitung ke batas; batal berulang dibatasi', async () => {
    const { seller, listingId } = await liveSeller(5);
    const buyer = await user('Pembeli');
    const adm = await admin();

    // Siklus batal → pesan ulang dibatasi per hari.
    for (let i = 0; i < 5; i++) {
      const o = await api(buyer).post(`/v1/market/listings/${listingId}/orders`, { qty: 1 }).expect(201);
      await api(buyer).post(`/v1/market/orders/${o.body.id}/cancel`).expect(200);
    }
    expect((await api(buyer).post(`/v1/market/listings/${listingId}/orders`, { qty: 1 }).expect(429)).body.error).toBe('too_many_cancelled');

    // Renew listing kedaluwarsa tidak bisa melewati batas listing aktif.
    await t.pool.query(`UPDATE market_listings SET status = 'expired' WHERE id = $1`, [listingId]);
    await t.pool.query(
      `INSERT INTO market_listings (seller_id, model, title, description, category, condition, price, city, status, active_until, created_at, affiliate_url)
       SELECT $1, 'affiliate', 'Isi ' || g, '', 'shoes', 'used', 100000, 'Bandung', 'active', now() + interval '10 days', now() - interval '3 days', 'https://www.tokopedia.com/x'
         FROM generate_series(1, ${MAX_ACTIVE_LISTINGS}) g`,
      [seller.id],
    );
    expect((await api(seller).post(`/v1/market/listings/${listingId}/renew`).expect(409)).body.error).toBe('listing_limit');
    await t.pool.query(`DELETE FROM market_listings WHERE seller_id = $1 AND id <> $2`, [seller.id, listingId]);
    await api(seller).post(`/v1/market/listings/${listingId}/renew`).expect(200);
    expect((await api(buyer).get(`/v1/market/listings/${listingId}`)).status).toBe(200);

    // Level 2 dicabut: akun penjual ditangguhkan, listing split berhenti tayang dan tidak bisa diperpanjang.
    await api(adm).post(`/v1/admin/kyc/users/${seller.id}/revoke`, { reason: 'Memakai KTP orang lain' }).expect(204);
    expect((await api(seller).get('/v1/market/seller')).body.status).toBe('suspended');
    await api(buyer).get(`/v1/market/listings/${listingId}`).expect(404);
    expect((await api(seller).post(`/v1/market/listings/${listingId}/renew`)).status).toBe(403);
  });

  it('hapus akun: ditolak selama ada pesanan berjalan; setelah selesai listing dihapus, pesanan tetap tanpa tautan akun', async () => {
    const { seller, listingId } = await liveSeller(2);
    const buyer = await user('Pembeli');
    await t.pool.query('UPDATE users SET password_hash = NULL, google_sub = $2 WHERE id = $1', [seller.id, `g-${seller.id}`]);
    const o = await api(buyer).post(`/v1/market/listings/${listingId}/orders`, { qty: 1 }).expect(201);
    await xenditPay(o.body.invoiceUrl);
    expect((await api(seller).post('/v1/me/delete', { confirm: 'HAPUS' }).expect(409)).body.error).toBe('open_orders');
    await api(buyer).post(`/v1/market/orders/${o.body.id}/complete`).expect(200);
    await api(seller).post('/v1/me/delete', { confirm: 'HAPUS' }).expect(204);
    expect((await t.pool.query('SELECT count(*)::int AS n FROM market_listings')).rows[0].n).toBe(0);
    expect(t.storage.objects.size).toBe(0);
    const kept = await t.pool.query('SELECT seller_id, buyer_id, amount, status FROM market_orders WHERE id = $1', [o.body.id]);
    expect(kept.rows[0]).toMatchObject({ seller_id: null, buyer_id: buyer.id, status: 'completed' });
    expect((await t.pool.query('SELECT user_id FROM market_seller_accounts')).rows[0].user_id).toBeNull();
    expect((await api(buyer).get(`/v1/market/orders/${o.body.id}`)).body.counterpart).toEqual({ id: null, displayName: 'Pengguna dihapus' });
  });

  it('tanpa konfigurasi Xendit: split payment 503', async () => {
    t.xendit.enabled = false;
    const s = await user('Penjual', { level: 2 });
    expect((await createListing(s, { model: 'split', stock: 1 }).expect(503)).body.error).toBe('not_configured');
    expect((await api(s).post('/v1/market/seller').expect(503)).body.error).toBe('not_configured');
    expect((await api(s).get('/v1/market/config')).body.splitEnabled).toBe(false);
  });
});
