import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password.js';
import { TokenService } from '../src/auth/token.service.js';
import { FieldCrypto } from '../src/crypto/field-crypto.js';
import { ImportsService } from '../src/imports/imports.service.js';
import { ALLOWED_HOSTS, ProviderHttpError } from '../src/imports/provider-http.js';
import type { Point } from '../src/runs/geo.js';
import { createTestApp, freshIp, hasTestInfra, resetData, type TestApp } from './helpers.js';

const PASSWORD = 'rahasia-sekali-123';
const HOUR = 3600_000;
const PUSH_KEY = 'k'.repeat(40);
const ENV = {
  API_PUBLIC_URL: 'https://api.test',
  GARMIN_CLIENT_ID: 'garmin-client',
  GARMIN_CLIENT_SECRET: 'test-pw',
  GARMIN_PUSH_KEY: PUSH_KEY,
  STRAVA_CLIENT_ID: '12345',
  STRAVA_CLIENT_SECRET: 'test-pw',
  STRAVA_WEBHOOK_VERIFY_TOKEN: 'vtoken',
  STRAVA_WEBHOOK_SUBSCRIPTION_ID: '777',
};

/** Rute lurus [km] km ke utara dari [lat0] (titik tiap 10 m, pace 6:00/km), detik sejak mulai. */
function line(km: number, lat0 = -6.9): Point[] {
  const degPerM = 1 / 111_195;
  const pts: Point[] = [];
  for (let d = 0; d <= km * 1000; d += 10) pts.push([lat0 + d * degPerM, 107.6, (d / 1000) * 360, 700]);
  return pts;
}

describe.skipIf(!hasTestInfra)('Modul 2.3 Impor data lari (e2e)', () => {
  let t: TestApp;
  let crypto: FieldCrypto;
  let phoneSeq = 71_000_000;
  let passwordHash: string;

  beforeAll(async () => {
    t = await createTestApp(ENV);
    crypto = new FieldCrypto(t.env.DATA_ENCRYPTION_KEY, t.env.BLIND_INDEX_KEY);
    passwordHash = await hashPassword(PASSWORD);
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await resetData(t);
    t.providerHttp.reset();
    t.imports.jobs = [];
  });

  type U = { id: string; auth: { Authorization: string } };

  async function user(name = 'Pelari'): Promise<U> {
    const id = randomUUID();
    const email = `${id}@example.com`;
    const phone = `+62817${phoneSeq++}`;
    await t.pool.query(
      `INSERT INTO users (id, email_enc, email_bidx, email_verified_at, phone_enc, phone_bidx, phone_verified_at,
                          password_hash, display_name, privacy_accepted_at, privacy_version)
       VALUES ($1, $2, $3, now(), $4, $5, now(), $6, $7, now(), 'test')`,
      [id, crypto.encrypt(email, `users.email:${id}`), crypto.blindIndex('email', email), crypto.encrypt(phone, `users.phone:${id}`), crypto.blindIndex('phone', phone), passwordHash, name],
    );
    const tokens = await t.app.get(TokenService).issue(id, 'user');
    return { id, auth: { Authorization: `Bearer ${tokens.accessToken}` } };
  }

  async function community(owner: U, members: U[] = []) {
    const res = await api(owner).post('/v1/communities', { name: `Lari ${randomUUID().slice(0, 6)}`, city: 'Bandung', description: '', visibility: 'open' }).expect(201);
    const id = res.body.id as string;
    await t.pool.query(`UPDATE communities SET plan = 'pro_unlimited' WHERE id = $1`, [id]);
    for (const m of members) {
      await t.pool.query(`INSERT INTO community_members (community_id, user_id, status, joined_at) VALUES ($1, $2, 'active', now())`, [id, m.id]);
    }
    return id;
  }

  const api = (u: U) => {
    const ip = freshIp();
    const w = (r: request.Test) => r.set('X-Forwarded-For', ip).set(u.auth);
    return {
      get: (p: string) => w(request(t.http).get(p)),
      post: (p: string, body?: object) => w(request(t.http).post(p)).send(body ?? {}),
      patch: (p: string, body?: object) => w(request(t.http).patch(p)).send(body ?? {}),
      del: (p: string) => w(request(t.http).delete(p)),
    };
  };
  const anon = () => {
    const ip = freshIp();
    return {
      get: (p: string) => request(t.http).get(p).set('X-Forwarded-For', ip),
      post: (p: string, body?: object) => request(t.http).post(p).set('X-Forwarded-For', ip).send(body ?? {}),
    };
  };

  const hcSession = (start: Date, km: number, extra: Record<string, unknown> = {}) => ({
    externalId: randomUUID(),
    exerciseType: 'running',
    startedAt: start.toISOString(),
    endedAt: new Date(start.getTime() + km * 360_000).toISOString(),
    distanceM: km * 1000,
    route: line(km),
    visibility: 'community',
    ...extra,
  });

  // ---------- Penyedia palsu ----------

  function stravaRoutes(opts: { athleteId?: number; activities?: object[]; streams?: Record<string, object> } = {}) {
    t.providerHttp.on(/^POST https:\/\/www\.strava\.com\/api\/v3\/oauth\/token$/, (_u, req) => ({
      access_token: req.form?.grant_type === 'refresh_token' ? 's-access-2' : 's-access',
      refresh_token: 's-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 6 * 3600,
      athlete: { id: opts.athleteId ?? 9001 },
    }));
    t.providerHttp.on(/^GET https:\/\/www\.strava\.com\/api\/v3\/athlete\/activities\?/, () => opts.activities ?? []);
    t.providerHttp.on(/^GET https:\/\/www\.strava\.com\/api\/v3\/activities\/\d+\/streams\?/, (u) => opts.streams?.[u.pathname.split('/')[4]!] ?? {});
    t.providerHttp.on(/^GET https:\/\/www\.strava\.com\/api\/v3\/activities\/\d+$/, (u) => {
      const found = (opts.activities ?? []).find((a) => String((a as { id: number }).id) === u.pathname.split('/')[4]);
      if (!found) throw new ProviderHttpError(404, 'www.strava.com menjawab 404');
      return found;
    });
    t.providerHttp.on(/^POST https:\/\/www\.strava\.com\/oauth\/deauthorize$/, () => ({}));
    t.providerHttp.on(/^GET https:\/\/www\.strava\.com\/api\/v3\/athlete$/, () => ({ id: opts.athleteId ?? 9001 }));
  }

  function garminRoutes(opts: { userId?: string; pull?: object[] } = {}) {
    t.providerHttp.on(/^POST https:\/\/diauth\.garmin\.com\/di-oauth2-service\/oauth\/token$/, () => ({ access_token: 'g-access', refresh_token: 'g-refresh', expires_in: 86_400, scope: 'ACTIVITY_EXPORT' }));
    t.providerHttp.on(/^GET https:\/\/apis\.garmin\.com\/wellness-api\/rest\/user\/id$/, () => ({ userId: opts.userId ?? 'garmin-user-1' }));
    t.providerHttp.on(/^DELETE https:\/\/apis\.garmin\.com\/wellness-api\/rest\/user\/registration$/, () => null);
    t.providerHttp.on(/^GET https:\/\/apis\.garmin\.com\/wellness-api\/rest\/activityDetails\?/, () => opts.pull ?? []);
  }

  const stravaActivity = (id: number, start: Date, km: number, sport = 'Run') => ({
    id,
    name: 'Morning Run',
    sport_type: sport,
    start_date: start.toISOString(),
    elapsed_time: km * 360,
    moving_time: km * 360,
    distance: km * 1000,
    total_elevation_gain: 5,
  });
  const stravaStreams = (km: number) => {
    const pts = line(km, -6.95);
    return { latlng: { data: pts.map((p) => [p[0], p[1]]) }, time: { data: pts.map((p) => p[2]) }, altitude: { data: pts.map((p) => p[3]) } };
  };
  const garminDetail = (garminUserId: string, activityId: number, start: Date, km: number) => {
    const s = Math.floor(start.getTime() / 1000);
    return {
      userId: garminUserId,
      summaryId: `${activityId}-detail`,
      activityId,
      summary: { activityName: 'Lari Garmin', activityType: 'RUNNING', startTimeInSeconds: s, durationInSeconds: km * 360, distanceInMeters: km * 1000 },
      samples: line(km, -6.8).map((p) => ({ startTimeInSeconds: s + p[2], latitudeInDegree: p[0], longitudeInDegree: p[1], elevationInMeters: p[3] })),
    };
  };

  /** Kode sekali pakai dari tombol deep link di halaman callback. */
  const completeCode = (html: string) => /complete=([A-Za-z0-9_-]+)/.exec(html.replaceAll('&#38;', '&'))?.[1] ?? null;

  /** connect → callback (browser) → complete (aplikasi). `completeAs` = akun yang menyelesaikan; null = tidak diselesaikan. */
  async function oauth(u: U, provider: 'garmin' | 'strava', query = 'code=kode-otorisasi&scope=read,activity:read_all', completeAs: U | null = u) {
    const { url } = (await api(u).post(`/v1/imports/${provider}/connect`).expect(200)).body as { url: string };
    const state = new URL(url).searchParams.get('state')!;
    const res = await anon().get(`/v1/imports/${provider}/callback?state=${encodeURIComponent(state)}&${query}`);
    const code = res.status === 200 ? completeCode(res.text) : null;
    const done = code && completeAs ? await api(completeAs).post(`/v1/imports/${provider}/complete`, { code }) : null;
    return { url, state, res, code, done };
  }

  // ---------- Tes ----------

  it('Health Connect: rute diproses seperti lari aplikasi, tanpa rute = statistik tak terverifikasi, idempoten', async () => {
    const ani = await user('Ani');
    const start = new Date(Date.now() - 5 * HOUR);
    const s = hcSession(start, 5);
    const r1 = (await api(ani).post('/v1/imports/health-connect', s).expect(200)).body;
    expect(r1.status).toBe('imported');
    const run = (await api(ani).get(`/v1/runs/${r1.runId}`).expect(200)).body;
    expect(run).toMatchObject({ source: 'health_connect', visibility: 'community', statsVerified: true });
    // Jarak dihitung server dari titik GPS (bukan angka kiriman), zona privasi memotong awal/akhir rute publik.
    expect(Math.abs(run.distanceM - 5000)).toBeLessThan(30);
    expect(run.publicRoute.flat().length).toBeLessThan(run.route.flat().length);
    const { rows } = await t.pool.query<{ route_full_enc: Buffer }>('SELECT route_full_enc FROM runs WHERE id = $1', [r1.runId]);
    expect(rows[0]!.route_full_enc.toString('latin1')).not.toContain('107.6');

    // Kirim ulang = tidak ganda.
    expect((await api(ani).post('/v1/imports/health-connect', s).expect(200)).body.status).toBe('already_imported');
    expect((await api(ani).post('/v1/imports/health-connect/check', { ids: [s.externalId, 'lain'] }).expect(200)).body.known).toEqual([s.externalId]);

    // Treadmill tanpa rute: statistik yang dilaporkan, ditandai tidak diverifikasi GPS.
    const tm = hcSession(new Date(Date.now() - 30 * HOUR), 3, { route: [], exerciseType: 'running_treadmill' });
    const r2 = (await api(ani).post('/v1/imports/health-connect', tm).expect(200)).body;
    const run2 = (await api(ani).get(`/v1/runs/${r2.runId}`).expect(200)).body;
    expect(run2).toMatchObject({ distanceM: 3000, statsVerified: false, route: [] });

    // Tidak masuk akal (100 km dalam 30 menit) → dilewati.
    const bad = hcSession(new Date(Date.now() - 50 * HOUR), 5, { route: [], distanceM: 100_000 });
    expect((await api(ani).post('/v1/imports/health-connect', bad).expect(200)).body).toMatchObject({ status: 'skipped', reason: 'implausible_speed' });
    // Validasi body ketat.
    await api(ani).post('/v1/imports/health-connect', { ...s, externalId: '../x' }).expect(400);
    await api(ani).post('/v1/imports/health-connect', { ...s, extra: 1 }).expect(400);

    // Dihapus pemilik lalu dipilih lagi: boleh diimpor ulang (pilihan eksplisit).
    await api(ani).del(`/v1/runs/${r1.runId}`).expect(204);
    expect((await api(ani).post('/v1/imports/health-connect', s).expect(200)).body.status).toBe('imported');
  });

  it('dedup: lari aplikasi > Garmin > Health Connect > Strava; tumpang-tindih tidak terhitung ganda', async () => {
    const ani = await user('Ani');
    // 1) Lari aplikasi dulu, lalu sesi Health Connect yang sama → duplikat.
    const t1 = new Date(Date.now() - 10 * HOUR);
    const app1 = await api(ani)
      .post('/v1/runs', { clientRunId: randomUUID(), title: 'Lari pagi', visibility: 'community', startedAt: t1.toISOString(), endedAt: new Date(t1.getTime() + 1800_000).toISOString(), segments: [line(5)] })
      .expect(201);
    const dup = (await api(ani).post('/v1/imports/health-connect', hcSession(new Date(t1.getTime() + 60_000), 5)).expect(200)).body;
    expect(dup).toMatchObject({ status: 'duplicate', runId: app1.body.id });

    // 2) Health Connect dulu, lalu lari aplikasi (unggahan antrean offline) → lari impor digantikan.
    const t2 = new Date(Date.now() - 20 * HOUR);
    const hc2 = (await api(ani).post('/v1/imports/health-connect', hcSession(t2, 5)).expect(200)).body;
    const app2 = await api(ani)
      .post('/v1/runs', { clientRunId: randomUUID(), title: 'Lari sore', visibility: 'community', startedAt: t2.toISOString(), endedAt: new Date(t2.getTime() + 1800_000).toISOString(), segments: [line(5)] })
      .expect(201);
    await api(ani).get(`/v1/runs/${hc2.runId}`).expect(404);
    const rec = await t.pool.query(`SELECT status, run_id FROM import_records WHERE user_id = $1 AND run_id = $2`, [ani.id, app2.body.id]);
    expect(rec.rows[0]).toMatchObject({ status: 'duplicate' });

    // 3) Health Connect, lalu Garmin (prioritas lebih tinggi) menggantikan, lalu Strava = duplikat.
    garminRoutes();
    stravaRoutes({ athleteId: 9001 });
    expect((await oauth(ani, 'garmin')).res.status).toBe(200);
    expect((await oauth(ani, 'strava')).res.status).toBe(200);
    t.imports.jobs = [];
    const t3 = new Date(Date.now() - 30 * HOUR);
    const hc3 = (await api(ani).post('/v1/imports/health-connect', hcSession(t3, 5)).expect(200)).body;
    await anon().post(`/v1/imports/garmin/push/${PUSH_KEY}`, { activityDetails: [garminDetail('garmin-user-1', 555, new Date(t3.getTime() + 30_000), 5)] }).expect(200);
    await t.imports.drain();
    await api(ani).get(`/v1/runs/${hc3.runId}`).expect(404);
    const garminRun = await t.pool.query<{ id: string; source: string }>(`SELECT id, source FROM runs WHERE user_id = $1 AND source = 'garmin'`, [ani.id]);
    expect(garminRun.rows).toHaveLength(1);

    const act = stravaActivity(4242, new Date(t3.getTime() + 10_000), 5);
    stravaRoutes({ athleteId: 9001, activities: [act], streams: { '4242': stravaStreams(5) } });
    await anon().post('/v1/imports/strava/webhook', { object_type: 'activity', object_id: 4242, aspect_type: 'create', owner_id: 9001, subscription_id: 777 }).expect(200);
    await t.imports.drain();
    const sr = await t.pool.query(`SELECT status, run_id FROM import_records WHERE user_id = $1 AND source = 'strava'`, [ani.id]);
    expect(sr.rows[0]).toMatchObject({ status: 'duplicate', run_id: garminRun.rows[0]!.id });

    // Total: 2 lari aplikasi + 1 Garmin, tanpa salinan.
    const mine = (await api(ani).get('/v1/runs/mine').expect(200)).body.items;
    expect(mine.map((r: { source: string }) => r.source).sort()).toEqual(['app', 'app', 'garmin']);
  });

  it('Strava: selalu privat, tidak bisa diubah, tidak di feed, tidak terlihat orang lain, lencana hanya untuk pemilik', async () => {
    const ani = await user('Ani');
    const budi = await user('Budi');
    await community(ani, [budi]);
    const start = new Date(Date.now() - 6 * HOUR);
    stravaRoutes({
      activities: [stravaActivity(1001, start, 6), stravaActivity(1002, new Date(Date.now() - 30 * HOUR), 20, 'Ride')],
      streams: { '1001': stravaStreams(6) },
    });
    const { res, done } = await oauth(ani, 'strava');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Satu langkah lagi');
    expect(done!.status).toBe(200);
    expect(t.imports.jobs).toEqual([{ kind: 'strava-sync', userId: ani.id }]);
    await t.imports.drain();

    const runs = await t.pool.query<{ id: string; visibility: string; stats_verified: boolean }>(`SELECT id, visibility, stats_verified FROM runs WHERE user_id = $1`, [ani.id]);
    expect(runs.rows).toHaveLength(1); // sepeda (Ride) tidak diimpor
    const runId = runs.rows[0]!.id;
    expect(runs.rows[0]).toMatchObject({ visibility: 'private', stats_verified: true });

    expect((await api(ani).patch(`/v1/runs/${runId}`, { visibility: 'public' }).expect(409)).body.error).toBe('strava_private');
    await api(ani).patch(`/v1/runs/${runId}`, { title: 'Ganti judul boleh' }).expect(200);
    expect((await api(ani).post('/v1/feed/posts', { runId, visibility: 'community' }).expect(409)).body.error).toBe('run_not_shareable');
    await api(budi).get(`/v1/runs/${runId}`).expect(404);
    expect((await api(budi).get(`/v1/users/${ani.id}/runs`).expect(200)).body.items).toHaveLength(0);
    // Database juga menolak lari Strava yang tidak privat.
    await expect(t.pool.query(`UPDATE runs SET visibility = 'public' WHERE id = $1`, [runId])).rejects.toThrow();

    const mineBadges = (await api(ani).get('/v1/passport/me').expect(200)).body.badges.items;
    expect(mineBadges.find((b: { code: string }) => b.code === 'first_5k')).toMatchObject({ earned: true, privateOnly: true });
    const seen = (await api(budi).get(`/v1/passport/users/${ani.id}`).expect(200)).body.badges.items;
    expect(seen).toHaveLength(0);

    // Lari Strava yang masuk lewat Health Connect juga diperlakukan sebagai Strava.
    const viaHc = (await api(ani).post('/v1/imports/health-connect', hcSession(new Date(Date.now() - 60 * HOUR), 3, { originPackage: 'com.strava', visibility: 'public' })).expect(200)).body;
    const hcRun = (await api(ani).get(`/v1/runs/${viaHc.runId}`).expect(200)).body;
    expect(hcRun).toMatchObject({ source: 'strava', visibility: 'private' });
  });

  it('OAuth: state acak terikat pengguna, sekali pakai, token terenkripsi; data pribadi tidak di URL', async () => {
    const ani = await user('Ani');
    stravaRoutes();
    const { url, state, res } = await oauth(ani, 'strava');
    const u = new URL(url);
    expect(u.origin).toBe('https://www.strava.com');
    expect(u.searchParams.get('redirect_uri')).toBe('https://api.test/v1/imports/strava/callback');
    expect(url).not.toContain(ani.id);
    expect(state.length).toBeGreaterThanOrEqual(40);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');

    // Dipakai lagi → ditolak.
    const again = await anon().get(`/v1/imports/strava/callback?state=${encodeURIComponent(state)}&code=x&scope=activity:read_all`);
    expect(again.status).toBe(400);
    expect(again.text).toContain('kedaluwarsa');

    const { rows } = await t.pool.query<{ user_id: string; access_token_enc: Buffer; refresh_token_enc: Buffer }>(`SELECT * FROM import_connections WHERE provider = 'strava'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(ani.id);
    expect(rows[0]!.access_token_enc.toString('latin1')).not.toContain('s-access');
    expect(rows[0]!.refresh_token_enc.toString('latin1')).not.toContain('s-refresh');

    // State palsu, state penyedia lain, dan pembatalan.
    expect((await anon().get('/v1/imports/strava/callback?state=palsu&code=x')).status).toBe(400);
    const g = (await api(ani).post('/v1/imports/garmin/connect').expect(200)).body.url as string;
    const gState = new URL(g).searchParams.get('state')!;
    expect((await anon().get(`/v1/imports/strava/callback?state=${encodeURIComponent(gState)}&code=x&scope=activity:read_all`)).status).toBe(400);
    expect(await t.redis.exists(`oauth:state:${gState}`)).toBe(0);
    const denied = await oauth(ani, 'strava', 'error=access_denied');
    expect(denied.res.status).toBe(400);
    expect(denied.res.text).toContain('Dibatalkan');
    // Izin aktivitas tidak dicentang.
    expect((await oauth(ani, 'strava', 'code=x&scope=read')).res.status).toBe(400);

    // Garmin memakai PKCE: code_verifier di permintaan token cocok dengan code_challenge di URL.
    garminRoutes();
    const gr = await oauth(ani, 'garmin');
    expect(gr.res.status).toBe(200);
    const challenge = new URL(gr.url).searchParams.get('code_challenge')!;
    const tokenCall = t.providerHttp.calls.find((c) => c.url.startsWith('https://diauth.garmin.com/'))!;
    expect(createHash('sha256').update(tokenCall.form!.code_verifier!).digest('base64url')).toBe(challenge);

    const status = (await api(ani).get('/v1/imports').expect(200)).body;
    expect(status.garmin).toMatchObject({ enabled: true, connected: true });
    expect(status.strava).toMatchObject({ enabled: true, connected: true, webhook: true });
  });

  it('OAuth: tautan otorisasi milik orang lain tidak bisa menautkan akun penyedia korban (login CSRF)', async () => {
    const penyerang = await user('Penyerang');
    const korban = await user('Korban');
    stravaRoutes();
    const authz = new URL((await oauth(penyerang, 'strava', undefined, null)).url);
    // Strava selalu menampilkan layar persetujuan (tidak redirect diam-diam).
    expect(authz.searchParams.get('approval_prompt')).toBe('force');

    // Korban membuka tautan penyerang: callback tidak menautkan apa pun, hanya memberi kode ke browser korban.
    const viaVictim = await oauth(penyerang, 'strava', undefined, korban);
    expect(viaVictim.res.status).toBe(200);
    expect(viaVictim.done!.status).toBe(403);
    expect(viaVictim.done!.body.error).toBe('wrong_account');
    expect((await t.pool.query(`SELECT 1 FROM import_connections WHERE provider = 'strava'`)).rowCount).toBe(0);
    // Kode sudah hangus setelah percobaan dari akun lain, jadi penyerang pun tidak bisa memakainya.
    expect((await api(penyerang).post('/v1/imports/strava/complete', { code: viaVictim.code }).expect(410)).body.error).toBe('link_expired');

    // Tanpa complete, callback saja tidak menautkan.
    const noComplete = await oauth(penyerang, 'strava', undefined, null);
    expect(noComplete.res.status).toBe(200);
    expect((await t.pool.query(`SELECT 1 FROM import_connections`)).rowCount).toBe(0);
    // Penyedia salah dan kode palsu ditolak.
    await api(penyerang).post('/v1/imports/garmin/complete', { code: noComplete.code }).expect(410);
    await api(penyerang).post('/v1/imports/strava/complete', { code: 'x'.repeat(40) }).expect(410);
    await anon().post('/v1/imports/strava/complete', { code: 'x'.repeat(40) }).expect(401);

    // Pemilik sah menautkan; akun Strava yang sama tidak bisa direbut akun lain (tidak dipindahkan diam-diam).
    expect((await oauth(korban, 'strava')).done!.status).toBe(200);
    const steal = await oauth(penyerang, 'strava');
    expect(steal.done!.status).toBe(409);
    expect(steal.done!.body.error).toBe('linked_elsewhere');
    const { rows } = await t.pool.query<{ user_id: string }>(`SELECT user_id FROM import_connections WHERE provider = 'strava'`);
    expect(rows.map((r) => r.user_id)).toEqual([korban.id]);
  });

  it('webhook: kunci/langganan salah ditolak, pengguna tak dikenal diabaikan, callbackURL di luar Garmin ditolak (SSRF)', async () => {
    const ani = await user('Ani');
    garminRoutes({ pull: [garminDetail('garmin-user-1', 777, new Date(Date.now() - 4 * HOUR), 5)] });
    stravaRoutes({ athleteId: 9001 });
    await oauth(ani, 'garmin');
    await oauth(ani, 'strava');
    t.imports.jobs = [];
    t.providerHttp.calls = [];

    await anon().post('/v1/imports/garmin/push/salah', { activities: [] }).expect(404);
    await anon().post(`/v1/imports/garmin/push/${'x'.repeat(40)}`, { activities: [] }).expect(404);
    await anon().post(`/v1/imports/garmin/push/${PUSH_KEY}`, { activities: 'bukan-array' }).expect(400);
    const unknown = await anon().post(`/v1/imports/garmin/push/${PUSH_KEY}`, { activityDetails: [{ userId: 'orang-lain', callbackURL: 'https://apis.garmin.com/wellness-api/rest/activityDetails?token=1' }] }).expect(200);
    expect(unknown.body).toMatchObject({ accepted: 0, ignored: 1 });

    const evil = [
      'http://169.254.169.254/latest/meta-data/',
      'http://apis.garmin.com/wellness-api/rest/activityDetails',
      'https://apis.garmin.com.evil.test/wellness-api/rest/activityDetails',
      'https://evil.test/wellness-api/rest/activityDetails',
      'https://apis.garmin.com:8443/wellness-api/rest/activityDetails',
      'https://user@apis.garmin.com/wellness-api/rest/activityDetails',
      'https://apis.garmin.com/lain/rest',
      'file:///etc/passwd',
    ];
    const rej = await anon().post(`/v1/imports/garmin/push/${PUSH_KEY}`, { activityDetails: evil.map((callbackURL) => ({ userId: 'garmin-user-1', callbackURL })) }).expect(200);
    expect(rej.body).toMatchObject({ accepted: 0, rejected: evil.length });
    expect(t.imports.jobs).toHaveLength(0);

    const good = 'https://apis.garmin.com/wellness-api/rest/activityDetails?uploadStartTimeInSeconds=1&uploadEndTimeInSeconds=2&token=abc';
    await anon().post(`/v1/imports/garmin/push/${PUSH_KEY}`, { activityDetails: [{ userId: 'garmin-user-1', callbackURL: good }] }).expect(200);
    expect(t.imports.jobs).toHaveLength(1);
    await t.imports.drain();
    const pull = t.providerHttp.calls.find((c) => c.url.startsWith('https://apis.garmin.com/wellness-api/rest/activityDetails'));
    expect(pull?.bearer).toBe('g-access');
    expect(t.providerHttp.calls.every((c) => ALLOWED_HOSTS.has(new URL(c.url).hostname))).toBe(true);
    const g = await t.pool.query(`SELECT visibility FROM runs WHERE user_id = $1 AND source = 'garmin'`, [ani.id]);
    expect(g.rows).toEqual([{ visibility: 'private' }]);
    // ProviderHttp menolak host di luar allowlist walau dipanggil langsung.
    await expect(t.app.get(ImportsService).garmin.pull('http://127.0.0.1/wellness-api/rest/x', 't')).rejects.toThrow();

    // Strava: verifikasi langganan.
    await anon().get('/v1/imports/strava/webhook?hub.mode=subscribe&hub.challenge=abc&hub.verify_token=salah').expect(403);
    expect((await anon().get('/v1/imports/strava/webhook?hub.mode=subscribe&hub.challenge=abc&hub.verify_token=vtoken').expect(200)).body).toEqual({ 'hub.challenge': 'abc' });
    const ev = { object_type: 'activity', object_id: 31337, aspect_type: 'create', owner_id: 9001, subscription_id: 777 };
    // Langganan salah: jawaban sama dengan event yang diabaikan (bukan 403), jadi tidak bisa ditebak.
    expect((await anon().post('/v1/imports/strava/webhook', { ...ev, subscription_id: 1 }).expect(200)).body).toEqual({ accepted: false });
    await anon().post('/v1/imports/strava/webhook', { ...ev, object_id: 'x' }).expect(400);
    expect((await anon().post('/v1/imports/strava/webhook', { ...ev, owner_id: 1 }).expect(200)).body).toEqual({ accepted: false });

    // Event sah: data ditarik dari API Strava (bukan dari isi event), lalu dihapus saat event delete.
    const act = stravaActivity(31337, new Date(Date.now() - 50 * HOUR), 4);
    stravaRoutes({ athleteId: 9001, activities: [act], streams: { '31337': stravaStreams(4) } });
    expect((await anon().post('/v1/imports/strava/webhook', ev).expect(200)).body).toEqual({ accepted: true });
    await t.imports.drain();
    const s = await t.pool.query<{ id: string }>(`SELECT id FROM runs WHERE user_id = $1 AND source = 'strava'`, [ani.id]);
    expect(s.rows).toHaveLength(1);
    // Event delete palsu (aktivitas masih ada di Strava): lari tidak dihapus.
    await anon().post('/v1/imports/strava/webhook', { ...ev, aspect_type: 'delete' }).expect(200);
    await t.imports.drain();
    expect((await t.pool.query(`SELECT 1 FROM runs WHERE id = $1`, [s.rows[0]!.id])).rows).toHaveLength(1);
    // Sungguh dihapus di Strava (404): salinannya ikut dihapus.
    stravaRoutes({ athleteId: 9001, activities: [] });
    await anon().post('/v1/imports/strava/webhook', { ...ev, aspect_type: 'delete', event_time: 2 }).expect(200);
    await t.imports.drain();
    expect((await t.pool.query(`SELECT 1 FROM runs WHERE id = $1`, [s.rows[0]!.id])).rows).toHaveLength(0);

    // Aktivitas acak (404 dari Strava) = dilewati tanpa diulang; event per pengguna dibatasi per jam.
    const before = t.providerHttp.calls.length;
    await anon().post('/v1/imports/strava/webhook', { ...ev, object_id: 99999 }).expect(200);
    await t.imports.drain();
    expect(t.providerHttp.calls.slice(before).filter((c) => c.url.includes('/activities/99999'))).toHaveLength(1);
    await t.redis.set(`strava:events:${ani.id}:${Math.floor(Date.now() / 3_600_000)}`, '60');
    expect((await anon().post('/v1/imports/strava/webhook', { ...ev, object_id: 99998 }).expect(200)).body).toEqual({ accepted: false });
    await t.redis.del(`strava:events:${ani.id}:${Math.floor(Date.now() / 3_600_000)}`);

    // Event "deauthorize" palsu: token masih diterima Strava → koneksi tetap.
    await anon().post('/v1/imports/strava/webhook', { object_type: 'athlete', object_id: 9001, aspect_type: 'update', owner_id: 9001, subscription_id: 777, updates: { authorized: 'false' } }).expect(200);
    await t.imports.drain();
    expect((await t.pool.query(`SELECT 1 FROM import_connections WHERE provider = 'strava'`)).rows).toHaveLength(1);
    // Sungguh dicabut: Strava menjawab 401 → koneksi dihapus.
    t.providerHttp.on(/^GET https:\/\/www\.strava\.com\/api\/v3\/athlete$/, () => {
      throw new ProviderHttpError(401, 'www.strava.com menjawab 401');
    });
    await anon().post('/v1/imports/strava/webhook', { object_type: 'athlete', object_id: 9001, aspect_type: 'update', owner_id: 9001, subscription_id: 777, updates: { authorized: 'false' } }).expect(200);
    await t.imports.drain();
    expect((await t.pool.query(`SELECT 1 FROM import_connections WHERE provider = 'strava'`)).rows).toHaveLength(0);
  });

  it('putus sambungan mencabut izin + opsi hapus lari impor; hapus akun menghapus koneksi, token, dan lari impor', async () => {
    const ani = await user('Ani');
    stravaRoutes({ activities: [stravaActivity(2001, new Date(Date.now() - 5 * HOUR), 5)], streams: { '2001': stravaStreams(5) } });
    garminRoutes();
    await oauth(ani, 'strava');
    await t.imports.drain();
    expect((await t.pool.query(`SELECT 1 FROM runs WHERE user_id = $1 AND source = 'strava'`, [ani.id])).rows).toHaveLength(1);

    // Sinkron manual dibatasi.
    await api(ani).post('/v1/imports/strava/sync').expect(202);
    expect((await api(ani).post('/v1/imports/strava/sync').expect(429)).body.error).toBe('sync_rate_limited');
    t.imports.jobs = [];

    const res = (await api(ani).del('/v1/imports/strava?deleteRuns=true').expect(200)).body;
    expect(res).toEqual({ deletedRuns: 1 });
    expect(t.providerHttp.calls.some((c) => c.url === 'https://www.strava.com/oauth/deauthorize' && c.bearer === 's-access')).toBe(true);
    expect((await t.pool.query(`SELECT 1 FROM import_connections WHERE user_id = $1`, [ani.id])).rows).toHaveLength(0);
    expect((await t.pool.query(`SELECT 1 FROM runs WHERE user_id = $1`, [ani.id])).rows).toHaveLength(0);
    await api(ani).post('/v1/imports/strava/sync').expect(404);

    // Hapus akun.
    await oauth(ani, 'garmin');
    await oauth(ani, 'strava');
    await t.imports.drain();
    await api(ani).post('/v1/imports/health-connect', hcSession(new Date(Date.now() - 40 * HOUR), 3)).expect(200);
    t.providerHttp.calls = [];
    await api(ani).post('/v1/me/delete', { password: PASSWORD, confirm: 'HAPUS' }).expect(204);
    for (const table of ['import_connections', 'import_records', 'runs']) {
      expect((await t.pool.query(`SELECT 1 FROM ${table} WHERE user_id = $1`, [ani.id])).rows).toHaveLength(0);
    }
    expect(t.providerHttp.calls.map((c) => `${c.method} ${new URL(c.url).hostname}`).sort()).toEqual(['DELETE apis.garmin.com', 'POST www.strava.com']);
  });

  it('fitur nonaktif tanpa env: endpoint 503 not_configured, config memberi tanda ke aplikasi', async () => {
    const off = await createTestApp();
    try {
      const id = randomUUID();
      await off.pool.query(
        `INSERT INTO users (id, email_enc, email_bidx, email_verified_at, phone_enc, phone_bidx, phone_verified_at, password_hash, display_name, privacy_accepted_at, privacy_version)
         VALUES ($1, $2, $3, now(), $4, $5, now(), $6, 'Off', now(), 'test')`,
        [
          id,
          Buffer.from('x'),
          crypto.blindIndex('email', `${id}@example.com`),
          Buffer.from('y'),
          crypto.blindIndex('phone', `+62817${phoneSeq++}`),
          passwordHash,
        ],
      );
      const token = (await off.app.get(TokenService).issue(id, 'user')).accessToken;
      const auth = { Authorization: `Bearer ${token}` };
      const ip = freshIp();
      const cfg = (await request(off.http).get('/v1/auth/config').set('X-Forwarded-For', ip).expect(200)).body;
      expect(cfg.imports).toEqual({ garmin: false, strava: false });
      const status = (await request(off.http).get('/v1/imports').set('X-Forwarded-For', ip).set(auth).expect(200)).body;
      expect(status).toMatchObject({ healthConnect: { enabled: true }, garmin: { enabled: false }, strava: { enabled: false } });
      for (const p of ['garmin', 'strava']) {
        expect((await request(off.http).post(`/v1/imports/${p}/connect`).set('X-Forwarded-For', ip).set(auth).expect(503)).body.error).toBe('not_configured');
      }
      await request(off.http).post(`/v1/imports/garmin/push/${PUSH_KEY}`).set('X-Forwarded-For', ip).send({}).expect(503);
      await request(off.http).get('/v1/imports/strava/webhook?hub.mode=subscribe&hub.challenge=a&hub.verify_token=b').set('X-Forwarded-For', ip).expect(503);
      expect((await request(off.http).get('/v1/imports/strava/callback?state=a&code=b').set('X-Forwarded-For', ip)).status).toBe(400);
      // Health Connect tidak butuh konfigurasi server.
      const hc = await request(off.http).post('/v1/imports/health-connect').set('X-Forwarded-For', ip).set(auth).send(hcSession(new Date(Date.now() - 3 * HOUR), 2)).expect(200);
      expect(hc.body.status).toBe('imported');
    } finally {
      await off.close();
    }
  });
});
