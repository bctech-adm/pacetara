import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TokenService } from '../src/auth/token.service.js';
import { FieldCrypto } from '../src/crypto/field-crypto.js';
import { haversine, type Point } from '../src/runs/geo.js';
import { createTestApp, freshIp, hasTestInfra, resetData, type TestApp } from './helpers.js';

/** Rute 5 km: berangkat dari "rumah", lari lurus 2,5 km ke utara lalu kembali (pace 6:00/km, titik tiap 10 m). */
function homeLoop5k(home: [number, number] = [-6.9, 107.6]): Point[] {
  const degPerM = 1 / 111_195;
  const pts: Point[] = [];
  for (let d = 0; d <= 5000; d += 10) {
    const along = d <= 2500 ? d : 5000 - d;
    // Rute balik bergeser 15 m ke timur agar tidak menumpuk persis.
    const east = d > 2500 ? 15 * degPerM : 0;
    pts.push([home[0] + along * degPerM, home[1] + east, (d / 1000) * 360, 700]);
  }
  return pts;
}

describe.skipIf(!hasTestInfra)('Modul 1.4 Tracking lari (e2e)', () => {
  let t: TestApp;
  let crypto: FieldCrypto;
  let phoneSeq = 20_000_000;

  beforeAll(async () => {
    t = await createTestApp();
    crypto = new FieldCrypto(t.env.DATA_ENCRYPTION_KEY, t.env.BLIND_INDEX_KEY);
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await resetData(t);
    t.storage.objects.clear();
  });

  async function user(opts: { plan?: 'free' | 'premium' } = {}) {
    const id = randomUUID();
    const email = `${id}@example.com`;
    const phone = `+62813${phoneSeq++}`;
    await t.pool.query(
      `INSERT INTO users (id, email_enc, email_bidx, email_verified_at, phone_enc, phone_bidx, phone_verified_at,
                          google_sub, display_name, plan, privacy_accepted_at, privacy_version)
       VALUES ($1, $2, $3, now(), $4, $5, now(), $6, 'Pelari', $7, now(), 'test')`,
      [
        id,
        crypto.encrypt(email, `users.email:${id}`),
        crypto.blindIndex('email', email),
        crypto.encrypt(phone, `users.phone:${id}`),
        crypto.blindIndex('phone', phone),
        `g-${id}`,
        opts.plan ?? 'free',
      ],
    );
    const tokens = await t.app.get(TokenService).issue(id, 'user');
    return { id, auth: { Authorization: `Bearer ${tokens.accessToken}` } };
  }

  const api = (auth: Record<string, string>) => {
    const ip = freshIp();
    const w = (r: request.Test) => r.set('X-Forwarded-For', ip).set(auth);
    return {
      get: (p: string) => w(request(t.http).get(p)),
      post: (p: string, body?: object) => w(request(t.http).post(p)).send(body ?? {}),
      patch: (p: string, body: object) => w(request(t.http).patch(p)).send(body),
      del: (p: string) => w(request(t.http).delete(p)),
    };
  };

  const runBody = (overrides: Record<string, unknown> = {}) => {
    const started = new Date(Date.now() - 2 * 3600 * 1000);
    return {
      clientRunId: randomUUID(),
      title: 'Lari pagi',
      visibility: 'public',
      startedAt: started.toISOString(),
      endedAt: new Date(started.getTime() + 1800 * 1000).toISOString(),
      segments: [homeLoop5k()],
      ...overrides,
    };
  };

  // ---------- Selesai jika: lari 5 km terekam utuh, rute tersimpan tanpa titik rumah ----------

  it('lari 5 km tersimpan utuh: jarak, waktu, dan pace dihitung server', async () => {
    const runner = await user();
    const res = await api(runner.auth).post('/v1/runs', runBody()).expect(201);
    expect(res.body.distanceM).toBeGreaterThan(4990);
    expect(res.body.distanceM).toBeLessThan(5020);
    expect(res.body.movingTimeS).toBe(1800);
    expect(res.body.avgPaceSPerKm).toBeGreaterThan(355);
    expect(res.body.avgPaceSPerKm).toBeLessThan(362);
    // Pemilik melihat rute utuh (titik rumah termasuk).
    expect(res.body.route[0]).toHaveLength(501);
  });

  it('orang lain melihat rute tanpa titik rumah (zona privasi 250 m)', async () => {
    const runner = await user();
    const created = await api(runner.auth).post('/v1/runs', runBody()).expect(201);
    const viewer = await user();
    const seen = await api(viewer.auth).get(`/v1/runs/${created.body.id}`).expect(200);
    const home = homeLoop5k()[0]!;
    const points = (seen.body.route as Point[][]).flat();
    expect(points.length).toBeGreaterThan(300);
    for (const p of points) expect(haversine(p, home)).toBeGreaterThanOrEqual(250);
    expect(seen.body).not.toHaveProperty('publicRoute');
    expect(seen.body.isOwner).toBe(false);
    // Statistik tetap utuh walau rute dipotong.
    expect(seen.body.distanceM).toBeGreaterThan(4990);
  });

  it('radius zona privasi bisa diperbesar', async () => {
    const runner = await user();
    await api(runner.auth).post('/v1/runs', {}).expect(400);
    await request(t.http).put('/v1/runs/privacy-zone').set(runner.auth).set('X-Forwarded-For', freshIp()).send({ radiusM: 800 }).expect(204);
    const created = await api(runner.auth).post('/v1/runs', runBody()).expect(201);
    const home = homeLoop5k()[0]!;
    for (const p of (created.body.publicRoute as Point[][]).flat()) expect(haversine(p, home)).toBeGreaterThanOrEqual(800);
  });

  it('rute tersimpan terenkripsi di database', async () => {
    const runner = await user();
    await api(runner.auth).post('/v1/runs', runBody()).expect(201);
    const { rows } = await t.pool.query<{ route_full_enc: Buffer; route_public_enc: Buffer }>('SELECT route_full_enc, route_public_enc FROM runs');
    for (const col of [rows[0]!.route_full_enc, rows[0]!.route_public_enc]) {
      expect(col.includes(Buffer.from('-6.9'))).toBe(false);
      expect(col.includes(Buffer.from('107.6'))).toBe(false);
    }
  });

  it('upload ulang dengan clientRunId sama tidak membuat lari ganda', async () => {
    const runner = await user();
    const body = runBody();
    const a = await api(runner.auth).post('/v1/runs', body).expect(201);
    const b = await api(runner.auth).post('/v1/runs', body).expect(200);
    expect(b.body.id).toBe(a.body.id);
    expect((await t.pool.query('SELECT 1 FROM runs')).rowCount).toBe(1);
  });

  it('jarak tidak bisa dikarang: lompatan GPS dibuang server', async () => {
    const runner = await user();
    const route = homeLoop5k();
    route.splice(100, 0, [-6.0, 107.6, route[100]![2] - 1, 700]); // titik palsu ~100 km jauhnya
    const res = await api(runner.auth).post('/v1/runs', runBody({ segments: [route] })).expect(201);
    expect(res.body.distanceM).toBeLessThan(5020);
  });

  it('validasi: waktu di masa depan dan titik di luar jangkauan ditolak', async () => {
    const runner = await user();
    const future = new Date(Date.now() + 3600 * 1000);
    expect((await api(runner.auth).post('/v1/runs', runBody({ startedAt: future.toISOString(), endedAt: new Date(future.getTime() + 1000).toISOString() }))).status).toBe(400);
    expect((await api(runner.auth).post('/v1/runs', runBody({ segments: [[[95, 107, 0, null]]] }))).status).toBe(400);
  });

  // ---------- Visibilitas ----------

  it('visibilitas: hanya saya / komunitas / semua', async () => {
    const runner = await user();
    const stranger = await user();
    const friend = await user();
    const priv = await api(runner.auth).post('/v1/runs', runBody({ visibility: 'private' })).expect(201);
    const comm = await api(runner.auth).post('/v1/runs', runBody({ visibility: 'community' })).expect(201);
    const pub = await api(runner.auth).post('/v1/runs', runBody({ visibility: 'public' })).expect(201);

    // Teman sekomunitas.
    const c = await api(runner.auth).post('/v1/communities', { name: 'Klub Lari', city: 'Bandung', visibility: 'open' }).expect(201);
    await api(friend.auth).post(`/v1/communities/${c.body.id}/join`).expect(200);

    expect((await api(stranger.auth).get(`/v1/runs/${priv.body.id}`)).status).toBe(404);
    expect((await api(stranger.auth).get(`/v1/runs/${comm.body.id}`)).status).toBe(404);
    expect((await api(stranger.auth).get(`/v1/runs/${pub.body.id}`)).status).toBe(200);

    expect((await api(friend.auth).get(`/v1/runs/${priv.body.id}`)).status).toBe(404);
    expect((await api(friend.auth).get(`/v1/runs/${comm.body.id}`)).status).toBe(200);

    const strangerList = await api(stranger.auth).get(`/v1/users/${runner.id}/runs`).expect(200);
    expect(strangerList.body.items.map((r: { id: string }) => r.id)).toEqual([pub.body.id]);
    const friendList = await api(friend.auth).get(`/v1/users/${runner.id}/runs`).expect(200);
    expect(friendList.body.items).toHaveLength(2);

    // Hanya pemilik yang bisa mengubah atau menghapus.
    expect((await api(friend.auth).patch(`/v1/runs/${comm.body.id}`, { title: 'diubah' })).status).toBe(404);
    expect((await api(friend.auth).del(`/v1/runs/${comm.body.id}`)).status).toBe(404);
  });

  it('ubah judul, catatan, visibilitas; hapus lari', async () => {
    const runner = await user();
    const run = await api(runner.auth).post('/v1/runs', runBody()).expect(201);
    const upd = await api(runner.auth).patch(`/v1/runs/${run.body.id}`, { title: 'Long run', notes: 'Kaki pegal', visibility: 'private' }).expect(200);
    expect(upd.body).toMatchObject({ title: 'Long run', notes: 'Kaki pegal', visibility: 'private' });
    await api(runner.auth).del(`/v1/runs/${run.body.id}`).expect(204);
    expect((await api(runner.auth).get(`/v1/runs/${run.body.id}`)).status).toBe(404);
  });

  // ---------- Foto ----------

  it('foto lari: metadata dibuang, maksimal 4, ikut aturan visibilitas', async () => {
    const runner = await user();
    const run = await api(runner.auth).post('/v1/runs', runBody({ visibility: 'private' })).expect(201);
    const jpeg = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#2a9d8f' } })
      .jpeg()
      .withExif({ IFD0: { Make: 'TestPhone' } })
      .toBuffer();
    let detail = run.body;
    for (let i = 0; i < 4; i++) {
      detail = (await request(t.http).post(`/v1/runs/${run.body.id}/photos`).set(runner.auth).set('X-Forwarded-For', freshIp()).attach('file', jpeg, 'a.jpg').expect(200)).body;
    }
    expect(detail.photos).toHaveLength(4);
    const fifth = await request(t.http).post(`/v1/runs/${run.body.id}/photos`).set(runner.auth).set('X-Forwarded-For', freshIp()).attach('file', jpeg, 'a.jpg');
    expect(fifth.status).toBe(409);
    for (const o of t.storage.objects.values()) expect((await sharp(o.body).metadata()).exif).toBeUndefined();

    const stranger = await user();
    expect((await api(stranger.auth).get(detail.photos[0].url)).status).toBe(404);
    expect((await api(runner.auth).get(detail.photos[0].url)).status).toBe(200);
  });

  // ---------- Batas paket & hapus akun ----------

  it('BATAS: riwayat paket gratis 90 hari; Premium melihat semua; data lama tidak dihapus', async () => {
    const runner = await user();
    const old = new Date(Date.now() - 120 * 86_400_000);
    // Lari lama (mis. dari antrean offline) tetap tersimpan, tetapi tersembunyi dari riwayat akun gratis.
    const oldRun = await api(runner.auth)
      .post('/v1/runs', runBody({ startedAt: old.toISOString(), endedAt: new Date(old.getTime() + 1800_000).toISOString() }))
      .expect(201);
    const blocked = await api(runner.auth).get(`/v1/runs/${oldRun.body.id}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.limit).toEqual({ kind: 'run_history', max: 90 });
    await api(runner.auth).post('/v1/runs', runBody()).expect(201);

    const list = await api(runner.auth).get('/v1/runs/mine').expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.historyLimit).toEqual({ days: 90, hiddenOlderRuns: 1 });

    await t.pool.query(`UPDATE users SET plan = 'premium' WHERE id = $1`, [runner.id]);
    const full = await api(runner.auth).get('/v1/runs/mine').expect(200);
    expect(full.body.items).toHaveLength(2);
    expect(full.body.historyLimit.days).toBeNull();
  });

  it('hapus akun menghapus semua lari dan foto', async () => {
    const runner = await user();
    const run = await api(runner.auth).post('/v1/runs', runBody()).expect(201);
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000' } }).png().toBuffer();
    await request(t.http).post(`/v1/runs/${run.body.id}/photos`).set(runner.auth).set('X-Forwarded-For', freshIp()).attach('file', png, 'a.png').expect(200);
    await api(runner.auth).post('/v1/me/delete', { confirm: 'HAPUS' }).expect(204);
    expect((await t.pool.query('SELECT 1 FROM runs')).rowCount).toBe(0);
    expect((await t.pool.query('SELECT 1 FROM run_photos')).rowCount).toBe(0);
    expect(t.storage.objects.size).toBe(0);
  });
});
