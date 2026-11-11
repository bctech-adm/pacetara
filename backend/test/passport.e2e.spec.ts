import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password.js';
import { TokenService } from '../src/auth/token.service.js';
import { FieldCrypto } from '../src/crypto/field-crypto.js';
import { MEDAL_UPLOADS_PER_DAY } from '../src/passport/passport.service.js';
import type { Point } from '../src/runs/geo.js';
import { createTestApp, freshIp, hasTestInfra, resetData, type TestApp } from './helpers.js';

const PASSWORD = 'rahasia-sekali-123';
const DAY = 86_400_000;
const WIB = 7 * 3600 * 1000;

/** Rute lurus [km] km ke utara (titik tiap 10 m, pace 6:00/km). */
function line(km: number): Point[] {
  const degPerM = 1 / 111_195;
  const pts: Point[] = [];
  for (let d = 0; d <= km * 1000; d += 10) pts.push([-6.9 + d * degPerM, 107.6, (d / 1000) * 360, 700]);
  return pts;
}

/** Awal minggu WIB saat ini (Senin 00:00 WIB) sebagai instan UTC. */
function wibWeekStart(now = new Date()): Date {
  const local = new Date(now.getTime() + WIB);
  const dow = (local.getUTCDay() + 6) % 7; // 0 = Senin
  const mondayLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - dow);
  return new Date(mondayLocal - WIB);
}

/** Awal bulan WIB [offset] bulan dari bulan ini, sebagai instan UTC. */
function wibMonthStart(offset: number, now = new Date()): Date {
  const local = new Date(now.getTime() + WIB);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + offset, 1) - WIB);
}

const ymd = (d: Date) => new Date(d.getTime() + WIB).toISOString().slice(0, 10);

describe.skipIf(!hasTestInfra)('Modul 2.2 Riwayat dan paspor lari (e2e)', () => {
  let t: TestApp;
  let crypto: FieldCrypto;
  let phoneSeq = 70_000_000;
  let passwordHash: string;
  let jpeg: Buffer;

  beforeAll(async () => {
    t = await createTestApp();
    crypto = new FieldCrypto(t.env.DATA_ENCRYPTION_KEY, t.env.BLIND_INDEX_KEY);
    passwordHash = await hashPassword(PASSWORD);
    jpeg = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#d4a017' } })
      .jpeg()
      .withExif({ IFD0: { Make: 'TestPhone', ImageDescription: 'rumah-saya' } })
      .toBuffer();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await resetData(t);
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
      put: (p: string, body?: object) => w(request(t.http).put(p)).send(body ?? {}),
      patch: (p: string, body?: object) => w(request(t.http).patch(p)).send(body ?? {}),
      del: (p: string) => w(request(t.http).delete(p)),
      raw: (p: string) => w(request(t.http).post(p)),
    };
  };

  /** Lari langsung ke database (waktu persis, tanpa lencana/notifikasi). */
  async function insertRun(u: U, startedAt: Date, distanceM: number, opts: { source?: string; pace?: number } = {}) {
    const pace = opts.pace ?? 360;
    const moving = Math.round((distanceM / 1000) * pace);
    await t.pool.query(
      `INSERT INTO runs (user_id, client_run_id, source, title, visibility, started_at, ended_at, distance_m, moving_time_s, elapsed_time_s, avg_pace_s_per_km)
       VALUES ($1, $2, $3, 'Lari', 'private', $4, $4::timestamptz + make_interval(secs => $5), $6, $5, $5, $7)`,
      [u.id, randomUUID(), opts.source ?? 'app', startedAt, moving, distanceM, pace],
    );
  }

  async function apiRun(u: U, km: number) {
    const started = new Date(Date.now() - 3 * 3600 * 1000);
    await api(u)
      .post('/v1/runs', {
        clientRunId: randomUUID(),
        title: 'Lari pagi',
        visibility: 'private',
        startedAt: started.toISOString(),
        endedAt: new Date(started.getTime() + km * 360 * 1000).toISOString(),
        segments: [line(km)],
      })
      .expect(201);
  }

  const addMedal = (u: U, data: object = { title: 'Medali Bandung 10K' }) =>
    api(u).raw('/v1/passport/medals').field('data', JSON.stringify(data)).attach('photo', jpeg, 'medal.jpg');

  it('statistik minggu dan bulan dihitung dalam WIB, minggu mulai Senin', async () => {
    const ani = await user('Ani');
    const w0 = wibWeekStart();
    // Minggu lalu (WIB): Senin 00:30 WIB dan Minggu 23:30 WIB. Senin 00:30 WIB = Minggu 17:30 UTC,
    // jadi agregasi UTC akan salah menaruhnya di minggu sebelumnya.
    await insertRun(ani, new Date(w0.getTime() - 7 * DAY + 30 * 60_000), 5000);
    await insertRun(ani, new Date(w0.getTime() - 30 * 60_000), 3000);
    // Dua minggu lalu: Minggu 23:30 WIB.
    await insertRun(ani, new Date(w0.getTime() - 7 * DAY - 30 * 60_000), 2000);

    const week = (await api(ani).get('/v1/runs/mine/stats?period=week').expect(200)).body;
    expect(week).toMatchObject({ period: 'week', timezone: 'Asia/Jakarta', weekStartsOn: 'monday', full: false });
    expect(week.buckets).toHaveLength(12);
    const last = week.buckets.at(-2);
    expect(last).toMatchObject({ start: ymd(new Date(w0.getTime() - 7 * DAY)), runs: 2, distanceM: 8000, movingTimeS: 2880, avgPaceSPerKm: 360 });
    expect(week.buckets.at(-3)).toMatchObject({ runs: 1, distanceM: 2000 });
    expect(week.buckets.at(-1)).toMatchObject({ start: ymd(w0), runs: 0, distanceM: 0, avgPaceSPerKm: null });
    expect(week.totals).toMatchObject({ runs: 3, distanceM: 10_000, longestRunM: 5000 });
    expect(week.records).toBeNull();

    // Bulan: lari pada tanggal 1 pukul 00:30 WIB bulan lalu masuk bulan lalu (di UTC masih bulan sebelumnya).
    const bob = await user('Bob');
    const m1 = wibMonthStart(-1);
    await insertRun(bob, new Date(m1.getTime() + 30 * 60_000), 4000);
    const month = (await api(bob).get('/v1/runs/mine/stats?period=month').expect(200)).body;
    const prev = month.buckets.find((b: { start: string }) => b.start === ymd(m1));
    expect(prev).toMatchObject({ runs: 1, distanceM: 4000 });
    expect(month.buckets.reduce((n: number, b: { runs: number }) => n + b.runs, 0)).toBe(1);
  });

  it('paket gratis: statistik hanya jendela 90 hari, tanpa tahunan/rekor; Premium lengkap', async () => {
    const ani = await user('Ani');
    await insertRun(ani, new Date(Date.now() - 2 * DAY), 10_500, { pace: 330 });
    await insertRun(ani, new Date(Date.now() - 120 * DAY), 21_200, { pace: 400 });

    const free = (await api(ani).get('/v1/runs/mine/stats?period=week&count=52').expect(200)).body;
    expect(free.historyLimit.days).toBe(90);
    expect(free.buckets.length).toBeLessThanOrEqual(15); // dipotong ke jendela 90 hari
    expect(free.totals).toMatchObject({ runs: 1, distanceM: 10_500 });
    const year = await api(ani).get('/v1/runs/mine/stats?period=year').expect(403);
    expect(year.body).toMatchObject({ error: 'limit_reached', limit: { kind: 'full_stats' } });

    await t.pool.query(`UPDATE users SET plan = 'premium' WHERE id = $1`, [ani.id]);
    const full = (await api(ani).get('/v1/runs/mine/stats?period=week&count=52').expect(200)).body;
    expect(full.full).toBe(true);
    expect(full.buckets).toHaveLength(52);
    expect(full.totals).toMatchObject({ runs: 2, distanceM: 31_700, longestRunM: 21_200 });
    expect(full.records['5k']).toMatchObject({ avgPaceSPerKm: 330, timeS: 1650 });
    expect(full.records['10k']).toMatchObject({ avgPaceSPerKm: 330, timeS: 3300 });
    expect(full.records.hm).toMatchObject({ avgPaceSPerKm: 400 });
    expect(full.records.fm).toBeNull();
    const yr = (await api(ani).get('/v1/runs/mine/stats?period=year').expect(200)).body;
    expect(yr.buckets).toHaveLength(5);
    await api(ani).get('/v1/runs/mine/stats?period=day').expect(400);
  });

  it('rak medali: foto diproses (EXIF dibuang), batas gratis 5 di server, Premium tanpa batas, turun paket tidak menghapus', async () => {
    const ani = await user('Ani');
    const first = await addMedal(ani, { title: 'Jakarta Marathon', category: 'fm', eventDate: '2026-10-26' }).expect(201);
    expect(first.body).toMatchObject({ title: 'Jakarta Marathon', category: 'fm', eventDate: '2026-10-26' });
    const stored = [...t.storage.objects.entries()].filter(([k]) => k.startsWith(`passport/${ani.id}/`));
    expect(stored).toHaveLength(1);
    const meta = await sharp(stored[0]![1].body).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.exif).toBeUndefined();
    await api(ani).get(first.body.photoUrl).expect(200);

    for (let i = 0; i < 4; i++) await addMedal(ani).expect(201);
    const over = await addMedal(ani).expect(403);
    expect(over.body).toMatchObject({ error: 'limit_reached', limit: { kind: 'medals', max: 5 } });
    expect((await api(ani).get('/v1/passport/me').expect(200)).body.medalLimit).toEqual({ limit: 5, used: 5, reached: true });
    // Gambar ditolak sebelum batas tidak menyisakan berkas.
    expect([...t.storage.objects.keys()].filter((k) => k.startsWith(`passport/${ani.id}/`))).toHaveLength(5);

    // Premium: bisa menambah; turun ke gratis: tetap terlihat, tidak bisa menambah, bisa menghapus.
    await t.pool.query(`UPDATE users SET plan = 'premium' WHERE id = $1`, [ani.id]);
    await addMedal(ani).expect(201);
    await addMedal(ani).expect(201);
    await t.pool.query(`UPDATE users SET plan = 'free' WHERE id = $1`, [ani.id]);
    const me = (await api(ani).get('/v1/passport/me').expect(200)).body;
    expect(me.medals).toHaveLength(7);
    expect(me.medalLimit).toEqual({ limit: 5, used: 7, reached: true });
    await addMedal(ani).expect(403);
    await api(ani).del(`/v1/passport/medals/${first.body.id}`).expect(204);
    expect(t.storage.objects.has(stored[0]![0])).toBe(false);
    await addMedal(ani).expect(403); // 6 masih di atas batas 5

    // Validasi: bukan gambar, tanpa foto, tanggal masa depan.
    const bob = await user('Bob');
    await api(bob).raw('/v1/passport/medals').field('data', JSON.stringify({ title: 'x' })).attach('photo', Buffer.from('bukan gambar'), 'a.jpg').expect(415);
    await api(bob).post('/v1/passport/medals', { data: JSON.stringify({ title: 'x' }) }).expect(400);
    await addMedal(bob, { title: 'Masa depan', eventDate: '2999-01-01' }).expect(400);
    expect([...t.storage.objects.keys()].filter((k) => k.startsWith(`passport/${bob.id}/`))).toHaveLength(0);
  });

  it('batas medali ditegakkan dalam transaksi: 8 unggahan bersamaan → tepat 5 berhasil; batas unggah harian', async () => {
    const ani = await user('Ani');
    const results = await Promise.all(Array.from({ length: 8 }, () => addMedal(ani)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(results.filter((r) => r.status === 403)).toHaveLength(3);
    expect(Number((await t.pool.query('SELECT count(*) AS n FROM passport_medals WHERE user_id = $1', [ani.id])).rows[0].n)).toBe(5);
    expect([...t.storage.objects.keys()].filter((k) => k.startsWith(`passport/${ani.id}/`))).toHaveLength(5);

    const bob = await user('Bob');
    await t.redis.set(`medal:day:${bob.id}`, String(MEDAL_UPLOADS_PER_DAY));
    expect((await addMedal(bob).expect(429)).body.error).toBe('medal_rate_limited');
  });

  it('hasil resmi: tautan hanya ke event yang ditandai ikut dan sudah lewat; event bebas; ubah dan hapus', async () => {
    const ani = await user('Ani');
    const yesterday = new Date(Date.now() - DAY + WIB).toISOString().slice(0, 10);
    const { rows } = await t.pool.query<{ id: string }>(
      `INSERT INTO events (name, event_date, city, categories, registration_url) VALUES
         ('Bandung Half Marathon', $1, 'Bandung', '{hm}', 'https://x.id'),
         ('Event Lain', $1, 'Bandung', '{5k}', 'https://x.id'),
         ('Event Besok', (now() AT TIME ZONE 'Asia/Jakarta')::date + 5, 'Bandung', '{10k}', 'https://x.id')
       RETURNING id`,
      [yesterday],
    );
    const [joined, notJoined, future] = rows.map((r) => r.id);
    for (const e of [joined, future]) await t.pool.query('INSERT INTO event_participants (event_id, user_id) VALUES ($1, $2)', [e, ani.id]);

    const events = (await api(ani).get('/v1/passport/events').expect(200)).body.items;
    expect(events.map((e: { id: string }) => e.id)).toEqual([joined]);

    const r = await api(ani).post('/v1/passport/results', { eventId: joined, category: 'hm', officialTimeS: 7200 }).expect(201);
    expect(r.body).toMatchObject({ eventName: 'Bandung Half Marathon', eventDate: yesterday, distanceM: 21_097, officialTimeS: 7200, avgPaceSPerKm: 341 });
    expect((await api(ani).post('/v1/passport/results', { eventId: joined, category: 'hm', officialTimeS: 7000 }).expect(409)).body.error).toBe('result_exists');
    expect((await api(ani).post('/v1/passport/results', { eventId: notJoined, category: '5k', officialTimeS: 1500 }).expect(409)).body.error).toBe('event_not_joined');
    expect((await api(ani).post('/v1/passport/results', { eventId: future, category: '10k', officialTimeS: 3000 }).expect(409)).body.error).toBe('event_not_joined');
    expect((await api(ani).get('/v1/passport/events').expect(200)).body.items[0].hasResult).toBe(true);

    // Event bebas (tidak ada di kalender).
    const free = await api(ani).post('/v1/passport/results', { eventName: 'Borobudur Marathon 2019', eventDate: '2019-11-17', category: 'fm', officialTimeS: 16_200 }).expect(201);
    expect(free.body).toMatchObject({ eventId: null, distanceM: 42_195 });
    await api(ani).post('/v1/passport/results', { eventName: 'Masa depan', eventDate: '2999-01-01', category: '5k', officialTimeS: 1500 }).expect(400);
    await api(ani).post('/v1/passport/results', { category: '5k', officialTimeS: 1500 }).expect(400);

    const upd = await api(ani).patch(`/v1/passport/results/${free.body.id}`, { officialTimeS: 15_000 }).expect(200);
    expect(upd.body.officialTimeS).toBe(15_000);
    const bob = await user('Bob');
    await api(bob).patch(`/v1/passport/results/${free.body.id}`, { officialTimeS: 1 }).expect(400);
    await api(bob).patch(`/v1/passport/results/${free.body.id}`, { officialTimeS: 100 }).expect(404);
    await api(bob).del(`/v1/passport/results/${free.body.id}`).expect(404);
    await api(ani).del(`/v1/passport/results/${free.body.id}`).expect(204);

    // Event dihapus: hasil tetap dengan nama tersalin.
    await t.pool.query('DELETE FROM events WHERE id = $1', [joined]);
    const me = (await api(ani).get('/v1/passport/me').expect(200)).body;
    expect(me.results).toHaveLength(1);
    expect(me.results[0]).toMatchObject({ eventId: null, eventName: 'Bandung Half Marathon' });
  });

  it('lencana: dihitung saat lari disimpan + notifikasi; lari lama diisi tanpa notifikasi; Strava hanya untuk pemilik', async () => {
    const ani = await user('Ani');
    await apiRun(ani, 5.2);
    const me = (await api(ani).get('/v1/passport/me').expect(200)).body;
    const earned = me.badges.items.filter((b: { earned: boolean }) => b.earned).map((b: { code: string }) => b.code);
    expect(earned.sort()).toEqual(['first_5k', 'first_run']);
    expect(me.badges.items.length).toBeGreaterThan(10); // pemilik melihat yang terkunci juga
    expect(me.badges.currentStreakWeeks).toBe(1);
    const inbox = (await api(ani).get('/v1/notifications').expect(200)).body.items;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ type: 'badge_earned', data: { badges: expect.stringContaining('first_5k') } });
    expect(t.push.to(ani.id).at(-1)).toMatchObject({ title: 'Lencana baru!', data: { category: 'achievement' } });

    // Lari kedua tidak membuat lencana ulang atau notifikasi baru.
    await apiRun(ani, 5.2);
    expect((await api(ani).get('/v1/notifications').expect(200)).body.items).toHaveLength(1);

    // Lari lama (sebelum modul ini): diisi saat paspor dibuka, waktu tercapai = waktu lari, tanpa notifikasi.
    const bob = await user('Bob');
    const old = new Date(Date.now() - 200 * DAY);
    await insertRun(bob, old, 10_100);
    await insertRun(bob, new Date(old.getTime() + 7 * DAY), 3000);
    await insertRun(bob, new Date(old.getTime() + 14 * DAY), 3000);
    await insertRun(bob, new Date(old.getTime() + 21 * DAY), 3000);
    // Lari palsu (pace kendaraan) tidak dihitung.
    await insertRun(bob, new Date(old.getTime() + 22 * DAY), 50_000, { pace: 90 });
    const b = (await api(bob).get('/v1/passport/me').expect(200)).body.badges.items;
    const got = Object.fromEntries(b.filter((x: { earned: boolean }) => x.earned).map((x: { code: string; earnedAt: string }) => [x.code, x.earnedAt]));
    expect(Object.keys(got).sort()).toEqual(['first_10k', 'first_5k', 'first_run', 'streak_4']);
    expect(got.first_10k).toBe(old.toISOString());
    expect((await api(bob).get('/v1/notifications').expect(200)).body.items).toHaveLength(0);

    // Strava: dihitung untuk pemilik (ditandai privateOnly), tidak terlihat oleh anggota komunitas.
    const citra = await user('Citra');
    await community(ani, [citra]);
    await insertRun(ani, new Date(Date.now() - DAY), 21_500, { source: 'strava' });
    const mine = (await api(ani).get('/v1/passport/me').expect(200)).body.badges.items;
    expect(mine.find((x: { code: string }) => x.code === 'first_hm')).toMatchObject({ earned: true, privateOnly: true });
    const seen = (await api(citra).get(`/v1/passport/users/${ani.id}`).expect(200)).body.badges.items.map((x: { code: string }) => x.code);
    expect(seen.sort()).toEqual(['first_5k', 'first_run']);
    // Setelah lari app 21 km, lencana HM tidak lagi privat.
    await insertRun(ani, new Date(Date.now() - 3600_000), 21_200);
    await api(ani).get('/v1/passport/me').expect(200);
    const seen2 = (await api(citra).get(`/v1/passport/users/${ani.id}`).expect(200)).body.badges.items.map((x: { code: string }) => x.code);
    expect(seen2).toContain('first_hm');
  });

  it('hak akses paspor: sesama anggota komunitas (bawaan), privat, blokir, orang luar = 404', async () => {
    const ani = await user('Ani');
    const budi = await user('Budi');
    const citra = await user('Citra');
    await community(ani, [budi]);
    const medal = (await addMedal(ani).expect(201)).body;
    await api(ani).post('/v1/passport/results', { eventName: 'Fun Run', eventDate: '2026-01-01', category: 'fun', officialTimeS: 3600 }).expect(201);

    const seen = (await api(budi).get(`/v1/passport/users/${ani.id}`).expect(200)).body;
    expect(seen).toMatchObject({ isMe: false, displayName: 'Ani' });
    expect(seen.medals).toHaveLength(1);
    expect(seen.results).toHaveLength(1);
    expect(seen.medalLimit).toBeUndefined();
    await api(budi).get(medal.photoUrl).expect(200);

    await api(citra).get(`/v1/passport/users/${ani.id}`).expect(404);
    await api(citra).get(medal.photoUrl).expect(404);
    await api(citra).del(`/v1/passport/medals/${medal.id}`).expect(404);
    await api(budi).del(`/v1/passport/medals/${medal.id}`).expect(404);

    // Privat: hanya pemilik.
    expect((await api(ani).put('/v1/passport/settings', { visibility: 'private' }).expect(200)).body).toEqual({ visibility: 'private' });
    expect((await api(ani).get('/v1/passport/me').expect(200)).body.visibility).toBe('private');
    await api(budi).get(`/v1/passport/users/${ani.id}`).expect(404);
    await api(budi).get(medal.photoUrl).expect(404);
    await api(ani).get(medal.photoUrl).expect(200);
    await api(ani).put('/v1/passport/settings', { visibility: 'public' }).expect(400);
    await api(ani).put('/v1/passport/settings', { visibility: 'community' }).expect(200);

    // Blokir feed (arah mana pun) dan akun ditangguhkan.
    await api(ani).post(`/v1/feed/users/${budi.id}/block`).expect(204);
    await api(budi).get(`/v1/passport/users/${ani.id}`).expect(404);
    await api(ani).del(`/v1/feed/users/${budi.id}/block`).expect(204);
    await api(budi).get(`/v1/passport/users/${ani.id}`).expect(200);
    await t.pool.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [ani.id]);
    await api(budi).get(`/v1/passport/users/${ani.id}`).expect(404);
  });

  it('hapus akun: medali beserta foto, hasil, dan lencana terhapus', async () => {
    const ani = await user('Ani');
    await addMedal(ani).expect(201);
    await api(ani).post('/v1/passport/results', { eventName: 'Fun Run', eventDate: '2026-01-01', category: 'fun', officialTimeS: 3600 }).expect(201);
    await apiRun(ani, 5.1);
    expect(Number((await t.pool.query('SELECT count(*) AS n FROM user_badges WHERE user_id = $1', [ani.id])).rows[0].n)).toBeGreaterThan(0);

    await request(t.http).post('/v1/me/delete').set(ani.auth).send({ password: PASSWORD, confirm: 'HAPUS' }).expect(204);

    for (const table of ['passport_medals', 'passport_results', 'user_badges']) {
      expect(Number((await t.pool.query(`SELECT count(*) AS n FROM ${table} WHERE user_id = $1`, [ani.id])).rows[0].n)).toBe(0);
    }
    expect([...t.storage.objects.keys()].filter((k) => k.startsWith(`passport/${ani.id}/`))).toHaveLength(0);
  });
});
