import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password.js';
import { TokenService } from '../src/auth/token.service.js';
import type { Env } from '../src/config/env.js';
import { FieldCrypto } from '../src/crypto/field-crypto.js';
import { PubSubOidcVerifier } from '../src/subscriptions/oidc.js';
import { PlayApi, PlayApiError, type PlayClient, type SubscriptionPurchaseV2, type VoidedPurchase } from '../src/subscriptions/play-api.js';
import type { SubscriptionJob } from '../src/subscriptions/subscription-queue.js';
import { SubscriptionQueue } from '../src/subscriptions/subscription-queue.js';
import { SubscriptionsService } from '../src/subscriptions/subscriptions.service.js';
import { createTestApp, freshIp, hasTestInfra, resetData, type TestApp } from './helpers.js';

const PASSWORD = 'rahasia-sekali-123';
const DAY = 86_400_000;
const PKG = 'tech.bimacreative.pacetara';
const AUD = 'https://api.test/v1/subscriptions/play/rtdn';
const PUSH_EMAIL = 'rtdn-push@proj.iam.gserviceaccount.com';
const ENV = {
  GOOGLE_PLAY_PACKAGE_NAME: PKG,
  PLAY_SERVICE_ACCOUNT_B64: Buffer.from('{}').toString('base64'),
  PLAY_PRODUCT_PREMIUM: 'pt_premium',
  PLAY_PRODUCT_PRO: 'pt_pro',
  PLAY_PRODUCT_PRO_UNLIMITED: 'pt_pro_unlimited',
  PLAY_RTDN_AUDIENCE: AUD,
  PLAY_RTDN_SERVICE_ACCOUNT_EMAIL: PUSH_EMAIL,
};

/** Kunci "Google" uji: verifier OIDC asli, hanya sumber sertifikatnya yang diganti (tanpa internet). */
const google = generateKeyPairSync('rsa', { modulusLength: 2048 });
const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
class TestOidc extends PubSubOidcVerifier {
  protected override async loadCerts() {
    return { gk1: google.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  }
}
function oidcToken(claims: Record<string, unknown> = {}, key = google.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'gk1', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(
    JSON.stringify({ iss: 'https://accounts.google.com', aud: AUD, email: PUSH_EMAIL, email_verified: true, iat: now, exp: now + 3600, ...claims }),
  ).toString('base64url');
  return `${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`;
}

/** Google Play Developer API palsu. */
class FakePlay implements PlayClient {
  purchases = new Map<string, SubscriptionPurchaseV2>();
  acked: string[] = [];
  cancelled: string[] = [];
  voided: VoidedPurchase[] = [];
  calls = 0;
  reset() {
    this.purchases.clear();
    this.acked = [];
    this.cancelled = [];
    this.voided = [];
    this.calls = 0;
  }
  async getSubscription(token: string) {
    this.calls++;
    const p = this.purchases.get(token);
    if (!p) throw new PlayApiError(404);
    return structuredClone(p);
  }
  async acknowledge(_productId: string, token: string) {
    this.acked.push(token);
    const p = this.purchases.get(token);
    if (p) p.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
  }
  async cancel(_productId: string, token: string) {
    this.cancelled.push(token);
    const p = this.purchases.get(token);
    if (p) {
      p.subscriptionState = 'SUBSCRIPTION_STATE_CANCELED';
      for (const li of p.lineItems ?? []) li.autoRenewingPlan = { autoRenewEnabled: false };
    }
  }
  async listVoided() {
    return this.voided;
  }
}

class FakeSubscriptionQueue {
  jobs: SubscriptionJob[] = [];
  service?: SubscriptionsService;
  async enqueue(job: SubscriptionJob) {
    this.jobs.push(job);
  }
  async drain() {
    const out: unknown[] = [];
    while (this.jobs.length) out.push(await this.service!.processJob(this.jobs.shift()!));
    return out;
  }
}

describe.skipIf(!hasTestInfra)('Modul 2.5 Langganan (e2e)', () => {
  let t: TestApp;
  let subs: SubscriptionsService;
  let passwordHash: string;
  let phoneSeq = 72_000_000;
  const play = new FakePlay();
  const queue = new FakeSubscriptionQueue();

  beforeAll(async () => {
    t = await createTestApp(ENV, [
      { token: PlayApi, value: play },
      { token: SubscriptionQueue, value: queue },
      { token: PubSubOidcVerifier, value: new TestOidc({ ...ENV } as unknown as Env) },
    ]);
    subs = t.app.get(SubscriptionsService);
    queue.service = subs;
    passwordHash = await hashPassword(PASSWORD);
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await resetData(t);
    await t.pool.query('TRUNCATE play_subscriptions, plan_grants, play_rtdn_messages CASCADE');
    play.reset();
    queue.jobs = [];
  });

  type U = { id: string; auth: { Authorization: string } };

  async function user(name = 'Pelari', app: TestApp = t): Promise<U> {
    const crypto = new FieldCrypto(app.env.DATA_ENCRYPTION_KEY, app.env.BLIND_INDEX_KEY);
    const id = randomUUID();
    const email = `${id}@example.com`;
    const phone = `+62817${phoneSeq++}`;
    await app.pool.query(
      `INSERT INTO users (id, email_enc, email_bidx, email_verified_at, phone_enc, phone_bidx, phone_verified_at,
                          password_hash, display_name, privacy_accepted_at, privacy_version)
       VALUES ($1, $2, $3, now(), $4, $5, now(), $6, $7, now(), 'test')`,
      [id, crypto.encrypt(email, `users.email:${id}`), crypto.blindIndex('email', email), crypto.encrypt(phone, `users.phone:${id}`), crypto.blindIndex('phone', phone), passwordHash, name],
    );
    const tokens = await app.app.get(TokenService).issue(id, 'user');
    return { id, auth: { Authorization: `Bearer ${tokens.accessToken}` } };
  }

  async function admin(): Promise<U> {
    const u = await user('Admin');
    await t.pool.query(`UPDATE users SET role = 'super_admin' WHERE id = $1`, [u.id]);
    const tokens = await t.app.get(TokenService).issue(u.id, 'super_admin', undefined, { admin: true });
    return { id: u.id, auth: { Authorization: `Bearer ${tokens.accessToken}` } };
  }

  const api = (u: U) => ({
    get: (url: string) => request(t.http).get(url).set(u.auth).set('X-Forwarded-For', freshIp()),
    post: (url: string, body: object = {}) => request(t.http).post(url).set(u.auth).set('X-Forwarded-For', freshIp()).send(body),
    patch: (url: string, body: object = {}) => request(t.http).patch(url).set(u.auth).set('X-Forwarded-For', freshIp()).send(body),
  });

  async function community(owner: U): Promise<string> {
    const res = await api(owner).post('/v1/communities', { name: `Lari ${randomUUID().slice(0, 6)}`, city: 'Bandung', description: '', visibility: 'open' }).expect(201);
    return res.body.id as string;
  }

  /** Pembelian di "Play": token baru dengan obfuscatedExternalAccountId dari intent server. */
  function purchase(productId: string, accountId: string, over: Partial<SubscriptionPurchaseV2> = {}, expiresInDays = 30): string {
    const token = `tok.${randomUUID()}`;
    play.purchases.set(token, {
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      latestOrderId: `GPA.${randomUUID().slice(0, 8)}`,
      externalAccountIdentifiers: { obfuscatedExternalAccountId: accountId },
      lineItems: [{ productId, expiryTime: new Date(Date.now() + expiresInDays * DAY).toISOString(), autoRenewingPlan: { autoRenewEnabled: true } }],
      ...over,
    });
    return token;
  }

  async function buyPremium(u: U) {
    const intent = await api(u).post('/v1/subscriptions/play/intent', { plan: 'premium' }).expect(200);
    const token = purchase(intent.body.productId, intent.body.obfuscatedAccountId);
    const res = await api(u).post('/v1/subscriptions/play/verify', { productId: intent.body.productId, purchaseToken: token }).expect(200);
    return { token, res };
  }

  async function buyPro(u: U, communityId: string, plan: 'pro' | 'pro_unlimited' = 'pro', over: Partial<SubscriptionPurchaseV2> = {}) {
    const intent = await api(u).post('/v1/subscriptions/play/intent', { plan, communityId }).expect(200);
    const token = purchase(intent.body.productId, intent.body.obfuscatedAccountId, over);
    const res = await api(u).post('/v1/subscriptions/play/verify', { productId: intent.body.productId, purchaseToken: token, communityId }).expect(200);
    return { token, res, intent: intent.body };
  }

  function rtdn(payload: object, opts: { auth?: string | null; messageId?: string } = {}) {
    const data = Buffer.from(JSON.stringify({ version: '1.0', packageName: PKG, eventTimeMillis: String(Date.now()), ...payload })).toString('base64');
    const req = request(t.http).post('/v1/subscriptions/play/rtdn').set('X-Forwarded-For', freshIp());
    const auth = opts.auth === undefined ? `Bearer ${oidcToken()}` : opts.auth;
    if (auth) req.set('Authorization', auth);
    return req.send({ message: { data, messageId: opts.messageId ?? randomUUID(), publishTime: new Date().toISOString() }, subscription: 'projects/p/subscriptions/s' });
  }
  const subNotif = (token: string, notificationType: number) => ({ subscriptionNotification: { version: '1.0', notificationType, purchaseToken: token, subscriptionId: 'x' } });

  async function plan(u: U) {
    return (await t.pool.query<{ plan: string }>('SELECT plan FROM users WHERE id = $1', [u.id])).rows[0]!.plan;
  }
  async function cplan(id: string) {
    return (await t.pool.query<{ plan: string }>('SELECT plan FROM communities WHERE id = $1', [id])).rows[0]!.plan;
  }

  it('Premium: server memverifikasi ke Google, baru mengubah paket, lalu meng-acknowledge; batas gratis terangkat', async () => {
    const u = await user();
    const owners = [await user('A'), await user('B'), await user('C'), await user('D')];
    const ids = [];
    for (const o of owners) ids.push(await community(o));
    for (const id of ids.slice(0, 3)) await api(u).post(`/v1/communities/${id}/join`).expect(200);
    const blocked = await api(u).post(`/v1/communities/${ids[3]}/join`).expect(403);
    expect(blocked.body.limit.kind).toBe('user_join');

    // Modul 2.7: pengguna gratis melihat iklan; flag dari server, bukan dari aplikasi.
    expect((await api(u).get('/v1/me').expect(200)).body).toMatchObject({ plan: 'free', ads: true });
    const before = await api(u).get('/v1/subscriptions').expect(200);
    expect(before.body).toMatchObject({ enabled: true, products: { premium: 'pt_premium', pro: 'pt_pro', proUnlimited: 'pt_pro_unlimited' }, premium: { plan: 'free', subscription: null } });

    const { token, res } = await buyPremium(u);
    expect(res.body).toMatchObject({ userPlan: 'premium', subscription: { kind: 'premium', state: 'ACTIVE', active: true, autoRenewing: true, purchasedByMe: true } });
    expect(play.acked).toEqual([token]);
    const me = await api(u).get('/v1/me').expect(200);
    expect(me.body).toMatchObject({ plan: 'premium', badges: ['premium'], ads: false });
    await api(u).post(`/v1/communities/${ids[3]}/join`).expect(200);

    // Token tidak disimpan polos.
    const row = (await t.pool.query('SELECT token_enc, token_hash FROM play_subscriptions')).rows[0];
    expect(row.token_enc.toString('utf8')).not.toContain(token);
    expect(Buffer.compare(row.token_hash, createHash('sha256').update(token).digest())).toBe(0);

    // Verifikasi ulang token yang sama oleh pemiliknya: idempoten.
    await api(u).post('/v1/subscriptions/play/verify', { productId: 'pt_premium', purchaseToken: token }).expect(200);
    expect((await t.pool.query('SELECT count(*)::int AS n FROM play_subscriptions')).rows[0].n).toBe(1);
    // Sudah berlangganan: intent kedua ditolak agar tidak tertagih dua kali.
    await api(u).post('/v1/subscriptions/play/intent', { plan: 'premium' }).expect(409);
    // Lencana Premium di profil feed.
    const prof = await api(u).get(`/v1/feed/users/${u.id}`).expect(200);
    expect(prof.body.badges).toContain('premium');
  });

  it('token dipakai ulang akun lain ditolak; token palsu/produk salah ditolak; paket tidak berubah', async () => {
    const a = await user('A');
    const b = await user('B');
    const { token } = await buyPremium(a);
    const r = await api(b).post('/v1/subscriptions/play/verify', { productId: 'pt_premium', purchaseToken: token }).expect(403);
    expect(r.body.error).toBe('purchase_mismatch');
    expect(await plan(b)).toBe('free');

    // Pertahanan berlapis: token yang sudah terikat ke akun lain → 409 walau HMAC cocok.
    const intent = await api(b).post('/v1/subscriptions/play/intent', { plan: 'premium' }).expect(200);
    const tokB = purchase('pt_premium', intent.body.obfuscatedAccountId);
    await t.pool.query(
      `INSERT INTO play_subscriptions (token_hash, product_id, kind, user_id, state) VALUES ($1, 'pt_premium', 'premium', $2, 'ACTIVE')`,
      [createHash('sha256').update(tokB).digest(), a.id],
    );
    expect((await api(b).post('/v1/subscriptions/play/verify', { productId: 'pt_premium', purchaseToken: tokB }).expect(409)).body.error).toBe('purchase_already_linked');

    // Token tidak dikenal Google, produk tidak cocok, produk tak dikenal.
    expect((await api(b).post('/v1/subscriptions/play/verify', { productId: 'pt_premium', purchaseToken: 'tok.tidak-ada-1234' }).expect(400)).body.error).toBe('invalid_purchase');
    const tokPro = purchase('pt_pro', intent.body.obfuscatedAccountId);
    expect((await api(b).post('/v1/subscriptions/play/verify', { productId: 'pt_premium', purchaseToken: tokPro }).expect(400)).body.error).toBe('invalid_purchase');
    expect((await api(b).post('/v1/subscriptions/play/verify', { productId: 'lain', purchaseToken: tokPro }).expect(400)).body.error).toBe('unknown_product');
    expect(await plan(b)).toBe('free');
  });

  it('tidak ada endpoint yang membiarkan klien menyetel paket', async () => {
    const u = await user();
    const c = await community(u);
    await api(u).patch('/v1/me', { plan: 'premium' }).expect(400);
    await api(u).patch(`/v1/communities/${c}`, { plan: 'pro_unlimited' }).expect(400);
    await api(u).post('/v1/subscriptions/play/verify', { productId: 'pt_premium', purchaseToken: 'tok.abcdefghijk', plan: 'premium' }).expect(400);
    await api(u).post('/v1/admin/subscriptions/grants', { userId: u.id, plan: 'premium', days: 30, reason: 'coba' }).expect(403);
    expect(await plan(u)).toBe('free');
    expect(await cplan(c)).toBe('free');
  });

  it('Komunitas Pro: hanya pemilik yang bisa membeli; pembelian terikat ke komunitas', async () => {
    const owner = await user('Pemilik');
    const member = await user('Anggota');
    const c = await community(owner);
    const c2 = await community(await user('Lain'));
    await api(member).post(`/v1/communities/${c}/join`).expect(200);

    expect((await api(member).post('/v1/subscriptions/play/intent', { plan: 'pro', communityId: c }).expect(403)).body.error).toBe('not_owner');
    const multi = await api(owner).post(`/v1/communities/${c}/members/${member.id}/role`, { role: 'admin' }).expect(403);
    expect(multi.body.limit.kind).toBe('multi_admin');

    const { token, intent } = await buyPro(owner, c);
    expect(await cplan(c)).toBe('pro');
    expect(play.acked).toEqual([token]);
    // Anggota (bukan pemilik) mengirim token yang sama: ditolak, baik untuk komunitas itu maupun komunitas lain.
    expect((await api(member).post('/v1/subscriptions/play/verify', { productId: 'pt_pro', purchaseToken: token, communityId: c }).expect(403)).body.error).toBe('not_owner');
    expect((await api(member).post('/v1/subscriptions/play/verify', { productId: 'pt_pro', purchaseToken: token }).expect(403)).body.error).toBe('purchase_mismatch');
    // Pemilik memakai token Pro komunitas c untuk komunitas lain miliknya: HMAC tidak cocok.
    await t.pool.query(`UPDATE communities SET plan = 'pro' WHERE id = $1`, [c]); // agar boleh punya komunitas kedua
    const c3 = await community(owner);
    expect((await api(owner).post('/v1/subscriptions/play/verify', { productId: 'pt_pro', purchaseToken: token, communityId: c3 }).expect(403)).body.error).toBe('purchase_mismatch');
    expect(await cplan(c3)).toBe('free');
    expect(await cplan(c2)).toBe('free');

    // Multi-admin kini boleh; lencana Pro di halaman komunitas dan avatar admin.
    await api(owner).post(`/v1/communities/${c}/members/${member.id}/role`, { role: 'admin' }).expect(204);
    const members = await api(member).get(`/v1/communities/${c}/members`).expect(200);
    const byId = Object.fromEntries((members.body.items ?? members.body).map((m: { userId: string; badges: string[] }) => [m.userId, m.badges]));
    expect(byId[owner.id]).toContain('pro');
    expect(byId[member.id]).toContain('pro');
    expect((await api(member).get(`/v1/communities/${c}`).expect(200)).body.badges).toEqual(['pro']);

    // Pembelian dikirim ulang aplikasi tanpa communityId: komunitas ditemukan dari HMAC.
    const tok2 = purchase('pt_pro_unlimited', intent.obfuscatedAccountId);
    const res = await api(owner).post('/v1/subscriptions/play/verify', { productId: 'pt_pro_unlimited', purchaseToken: tok2 }).expect(200);
    expect(res.body).toMatchObject({ communityId: c, communityPlan: 'pro_unlimited' });

    const status = await api(owner).get('/v1/subscriptions').expect(200);
    const entry = status.body.communities.find((x: { id: string }) => x.id === c);
    expect(entry).toMatchObject({ plan: 'pro_unlimited', isOwner: true, subscription: { kind: 'pro_unlimited', active: true } });
  });

  it('RTDN: tanpa token, token palsu, aud/email salah ditolak 401; token sah diantrekan dan idempoten per messageId', async () => {
    const u = await user();
    const { token } = await buyPremium(u);
    await rtdn(subNotif(token, 2), { auth: null }).expect(401);
    await rtdn(subNotif(token, 2), { auth: 'Bearer palsu.palsu.palsu-palsu-palsu' }).expect(401);
    await rtdn(subNotif(token, 2), { auth: `Bearer ${oidcToken({}, attacker.privateKey)}` }).expect(401);
    await rtdn(subNotif(token, 2), { auth: `Bearer ${oidcToken({ aud: 'https://lain.test' })}` }).expect(401);
    await rtdn(subNotif(token, 2), { auth: `Bearer ${oidcToken({ email: 'orang@lain.test' })}` }).expect(401);
    await rtdn(subNotif(token, 2), { auth: `Bearer ${oidcToken({ exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200 })}` }).expect(401);
    expect(queue.jobs).toHaveLength(0);

    await rtdn(subNotif(token, 2), { messageId: 'm-1' }).expect(204);
    await rtdn(subNotif(token, 2), { messageId: 'm-1' }).expect(204);
    expect(queue.jobs).toHaveLength(1);
    // Token tidak polos di antrean.
    expect(JSON.stringify(queue.jobs[0])).not.toContain(token);
    // Paket lain / pesan rusak: di-ack tanpa diproses.
    await rtdn({ ...subNotif(token, 2), packageName: 'com.lain' }).expect(204);
    await request(t.http).post('/v1/subscriptions/play/rtdn').set('Authorization', `Bearer ${oidcToken()}`).send({ hello: 1 }).expect(204);
    expect(queue.jobs).toHaveLength(1);

    // Isi notifikasi tidak dipercaya: status diambil ulang dari Google (perpanjangan).
    const newExpiry = new Date(Date.now() + 60 * DAY);
    play.purchases.get(token)!.lineItems![0]!.expiryTime = newExpiry.toISOString();
    const callsBefore = play.calls;
    expect(await queue.drain()).toEqual(['updated']);
    expect(play.calls).toBe(callsBefore + 1);
    const row = (await t.pool.query('SELECT expires_at FROM play_subscriptions')).rows[0];
    expect(new Date(row.expires_at).getTime()).toBe(newExpiry.getTime());
  });

  it('kedaluwarsa, refund (voided / REVOKED), dan ON_HOLD menurunkan paket; batas kembali berlaku tanpa menghapus data', async () => {
    // Kedaluwarsa (RTDN EXPIRED).
    const u = await user();
    const owners = [await user(), await user(), await user(), await user(), await user()];
    const ids = [];
    for (const o of owners) ids.push(await community(o));
    const { token } = await buyPremium(u);
    for (const id of ids.slice(0, 4)) await api(u).post(`/v1/communities/${id}/join`).expect(200);
    const p = play.purchases.get(token)!;
    p.subscriptionState = 'SUBSCRIPTION_STATE_EXPIRED';
    p.lineItems![0]!.expiryTime = new Date(Date.now() - 1000).toISOString();
    await rtdn(subNotif(token, 13)).expect(204);
    await queue.drain();
    expect(await plan(u)).toBe('free');
    // Iklan kembali tampil setelah Premium berakhir (modul 2.7).
    expect((await api(u).get('/v1/me').expect(200)).body.ads).toBe(true);
    // Data tidak dihapus: tetap anggota 4 komunitas, tetapi tidak bisa bergabung lagi.
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM community_members WHERE user_id = $1 AND status = 'active'`, [u.id])).rows[0].n).toBe(4);
    expect((await api(u).post(`/v1/communities/${ids[4]}/join`).expect(403)).body.limit.kind).toBe('user_join');

    // Refund lewat voidedPurchaseNotification: dicabut walau Google masih ACTIVE.
    const v = await user();
    const { token: tv } = await buyPremium(v);
    await rtdn({ voidedPurchaseNotification: { purchaseToken: tv, orderId: 'GPA.1', productType: 1, refundType: 1 } }).expect(204);
    await queue.drain();
    expect(await plan(v)).toBe('free');
    expect((await t.pool.query('SELECT revoked_at FROM play_subscriptions WHERE user_id = $1', [v.id])).rows[0].revoked_at).not.toBeNull();
    // Verifikasi ulang token yang sudah di-refund tidak menghidupkannya lagi.
    await api(v).post('/v1/subscriptions/play/verify', { productId: 'pt_premium', purchaseToken: tv }).expect(200);
    expect(await plan(v)).toBe('free');

    // SUBSCRIPTION_REVOKED pada Komunitas Pro: komunitas kembali gratis, anggota tetap.
    const o = await user();
    const c = await community(o);
    const { token: tp } = await buyPro(o, c);
    const extra = [await user(), await user(), await user()];
    for (const m of extra) await api(m).post(`/v1/communities/${c}/join`).expect(200);
    play.purchases.get(tp)!.subscriptionState = 'SUBSCRIPTION_STATE_EXPIRED';
    await rtdn(subNotif(tp, 12)).expect(204);
    await queue.drain();
    expect(await cplan(c)).toBe('free');
    expect((await t.pool.query('SELECT member_count FROM communities WHERE id = $1', [c])).rows[0].member_count).toBe(4);
    expect((await api(await user()).post(`/v1/communities/${c}/join`).expect(403)).body.limit.kind).toBe('community_members');

    // Masa tenggang tetap berhak; account hold tidak.
    const g = await user();
    const { token: tg } = await buyPremium(g);
    play.purchases.get(tg)!.subscriptionState = 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD';
    await rtdn(subNotif(tg, 6)).expect(204);
    await queue.drain();
    expect(await plan(g)).toBe('premium');
    expect((await api(g).get('/v1/subscriptions').expect(200)).body.premium.subscription).toMatchObject({ paymentIssue: true, active: true });
    play.purchases.get(tg)!.subscriptionState = 'SUBSCRIPTION_STATE_ON_HOLD';
    await rtdn(subNotif(tg, 5)).expect(204);
    await queue.drain();
    expect(await plan(g)).toBe('free');
    // Pulih (RECOVERED).
    play.purchases.get(tg)!.subscriptionState = 'SUBSCRIPTION_STATE_ACTIVE';
    await rtdn(subNotif(tg, 1)).expect(204);
    await queue.drain();
    expect(await plan(g)).toBe('premium');
  });

  it('rekonsiliasi: langganan dibatalkan yang lewat masa berlaku diturunkan tanpa notifikasi; voidedPurchases.list; ack tertunda diulang', async () => {
    const u = await user();
    const { token } = await buyPremium(u);
    // Pengguna membatalkan (CANCELED) — tetap Premium sampai masa berlaku habis.
    play.purchases.get(token)!.subscriptionState = 'SUBSCRIPTION_STATE_CANCELED';
    await rtdn(subNotif(token, 3)).expect(204);
    await queue.drain();
    expect(await plan(u)).toBe('premium');
    // Masa berlaku lewat tanpa notifikasi: sapuan berkala menurunkan.
    await t.pool.query(`UPDATE play_subscriptions SET expires_at = now() - interval '1 minute', last_checked_at = now() WHERE user_id = $1`, [u.id]);
    const r = await subs.reconcile();
    expect(r.users).toBe(1);
    expect(await plan(u)).toBe('free');

    // Refund yang notifikasinya terlewat: ditemukan lewat voidedPurchases.list.
    const v = await user();
    const { token: tv } = await buyPremium(v);
    play.voided = [{ purchaseToken: tv, orderId: 'GPA.x' }];
    await t.redis.del('play:voided:last');
    const r2 = await subs.reconcile();
    expect(r2.voided).toBe(1);
    expect(await plan(v)).toBe('free');

    // Acknowledge yang gagal saat verifikasi diulang oleh rekonsiliasi.
    const w = await user();
    const intent = await api(w).post('/v1/subscriptions/play/intent', { plan: 'premium' }).expect(200);
    const tw = purchase('pt_premium', intent.body.obfuscatedAccountId);
    const ack = play.acknowledge.bind(play);
    play.acknowledge = async () => {
      throw new PlayApiError(500);
    };
    await api(w).post('/v1/subscriptions/play/verify', { productId: 'pt_premium', purchaseToken: tw }).expect(200);
    play.acknowledge = ack;
    expect(await plan(w)).toBe('premium');
    await t.pool.query(`UPDATE play_subscriptions SET last_checked_at = now() - interval '1 hour' WHERE user_id = $1`, [w.id]);
    await t.redis.set('play:voided:last', String(Date.now()));
    await subs.reconcile();
    expect(play.acked).toContain(tw);
    expect((await t.pool.query('SELECT acknowledged FROM play_subscriptions WHERE user_id = $1', [w.id])).rows[0].acknowledged).toBe(true);
  });

  it('linkedPurchaseToken: upgrade Pro → Pro Unlimited lewat RTDN mengikat token baru ke komunitas yang sama', async () => {
    const o = await user();
    const c = await community(o);
    const { token: oldTok, intent } = await buyPro(o, c);
    // Google menerbitkan token baru (upgrade) dengan linkedPurchaseToken; aplikasi belum sempat memverifikasi.
    const newTok = purchase('pt_pro_unlimited', intent.obfuscatedAccountId, { linkedPurchaseToken: oldTok });
    play.purchases.get(oldTok)!.subscriptionState = 'SUBSCRIPTION_STATE_EXPIRED';
    await rtdn(subNotif(newTok, 4)).expect(204);
    expect(await queue.drain()).toEqual(['linked']);
    expect(await cplan(c)).toBe('pro_unlimited');
    const rows = (await t.pool.query('SELECT kind, replaced_by, community_id, user_id FROM play_subscriptions ORDER BY created_at')).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].replaced_by).not.toBeNull();
    expect(rows[1]).toMatchObject({ kind: 'pro_unlimited', community_id: c, user_id: o.id });
    expect(play.acked).toContain(newTok);

    // Token baru yang menautkan token milik orang lain tidak bisa mengambil alih (HMAC akun lain).
    const x = await user();
    const xIntent = await api(x).post('/v1/subscriptions/play/intent', { plan: 'premium' }).expect(200);
    const evil = purchase('pt_pro', xIntent.body.obfuscatedAccountId, { linkedPurchaseToken: newTok });
    await rtdn(subNotif(evil, 4)).expect(204);
    expect(await queue.drain()).toEqual(['mismatch']);
    // Token yang sama sekali tidak dikenal (belum diverifikasi aplikasi) tidak diikat.
    const stranger = purchase('pt_premium', 'tidak-dikenal');
    await rtdn(subNotif(stranger, 4)).expect(204);
    expect(await queue.drain()).toEqual(['unknown']);
    expect(await cplan(c)).toBe('pro_unlimited');
  });

  it('panel: lihat status dan beri/cabut paket manual berbatas waktu, tercatat di log', async () => {
    const a = await admin();
    const u = await user();
    const o = await user();
    const c = await community(o);
    const g = await api(a).post('/v1/admin/subscriptions/grants', { userId: u.id, plan: 'premium', days: 7, reason: 'Uji tanpa Play' }).expect(201);
    expect(await plan(u)).toBe('premium');
    await api(a).post('/v1/admin/subscriptions/grants', { communityId: c, plan: 'pro', days: 1, reason: 'Kompensasi' }).expect(201);
    expect(await cplan(c)).toBe('pro');
    await api(a).post('/v1/admin/subscriptions/grants', { userId: u.id, plan: 'pro', days: 1, reason: 'Salah' }).expect(400);

    const view = await api(a).get(`/v1/admin/subscriptions/users/${u.id}`).expect(200);
    expect(view.body.grants[0]).toMatchObject({ plan: 'premium', active: true, reason: 'Uji tanpa Play' });
    const found = await api(a).post('/v1/admin/subscriptions/communities/search', { q: 'Lari' }).expect(200);
    expect(found.body.items.some((x: { id: string }) => x.id === c)).toBe(true);
    await api(a).get(`/v1/admin/subscriptions/communities/${c}`).expect(200);

    await api(a).post(`/v1/admin/subscriptions/grants/${g.body.id}/revoke`, { reason: 'Selesai uji' }).expect(204);
    expect(await plan(u)).toBe('free');
    // Pemberian yang lewat masa berlaku diturunkan oleh rekonsiliasi.
    await t.pool.query(`UPDATE plan_grants SET expires_at = now() - interval '1 minute' WHERE community_id = $1`, [c]);
    await subs.reconcile();
    expect(await cplan(c)).toBe('free');

    const log = (await t.pool.query(`SELECT action FROM admin_audit_log WHERE actor_id = $1 ORDER BY id`, [a.id])).rows.map((r) => r.action);
    expect(log).toEqual(expect.arrayContaining(['plan.grant', 'subscription.view', 'plan.revoke_grant']));
  });

  it('hapus akun: perpanjangan dihentikan, catatan akuntansi tanpa tautan ke akun', async () => {
    const u = await user();
    const { token } = await buyPremium(u);
    await api(u).post('/v1/me/delete', { password: PASSWORD, confirm: 'HAPUS' }).expect(204);
    expect(play.cancelled).toEqual([token]);
    const row = (await t.pool.query('SELECT user_id, token_enc, order_id, product_id FROM play_subscriptions')).rows[0];
    expect(row).toMatchObject({ user_id: null, token_enc: null, product_id: 'pt_premium' });
    expect(row.order_id).toMatch(/^GPA\./);
    expect(await plan(u)).toBe('free');
  });

  it('tanpa konfigurasi Play: 503 not_configured', async () => {
    const off = await createTestApp();
    try {
      const { auth } = await user('X', off);
      expect((await request(off.http).post('/v1/subscriptions/play/verify').set(auth).send({ productId: 'pacetara_premium', purchaseToken: 'tok.abcdefghijk' }).expect(503)).body.error).toBe('not_configured');
      await request(off.http).post('/v1/subscriptions/play/rtdn').send({}).expect(503);
      expect((await request(off.http).get('/v1/subscriptions').set(auth).expect(200)).body.enabled).toBe(false);
      expect((await request(off.http).get('/v1/auth/config').expect(200)).body.subscriptions).toBe(false);
    } finally {
      await off.close();
    }
  });
});
