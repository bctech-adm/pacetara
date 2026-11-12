import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TokenService } from '../src/auth/token.service.js';
import { FieldCrypto } from '../src/crypto/field-crypto.js';
import { LeagueService, monthWib } from '../src/league/league.service.js';
import { makeQrToken, qrKey, verifyQrToken } from '../src/schedules/attendance.js';
import { SchedulesService } from '../src/schedules/schedules.service.js';
import { createTestApp, freshIp, hasTestInfra, resetData, type TestApp } from './helpers.js';

/** Titik kumpul uji: Gedung Sate, Bandung. */
const SATE = { lat: -6.9025, lng: 107.6187 };

describe.skipIf(!hasTestInfra)('Modul 2.6 Fitur komunitas lanjutan (e2e)', () => {
  let t: TestApp;
  let crypto: FieldCrypto;
  let phoneSeq = 26_000_000;

  beforeAll(async () => {
    t = await createTestApp();
    crypto = new FieldCrypto(t.env.DATA_ENCRYPTION_KEY, t.env.BLIND_INDEX_KEY);
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await resetData(t);
    t.push.jobs = [];
  });

  type U = { id: string; auth: { Authorization: string } };

  async function user(name = 'Pelari', plan: 'free' | 'premium' = 'free'): Promise<U> {
    const id = randomUUID();
    const email = `${id}@example.com`;
    const phone = `+62818${phoneSeq++}`;
    // Tanpa kata sandi (seperti akun Google): hapus akun cukup konfirmasi "HAPUS".
    await t.pool.query(
      `INSERT INTO users (id, email_enc, email_bidx, email_verified_at, phone_enc, phone_bidx, phone_verified_at,
                          google_sub, display_name, plan, privacy_accepted_at, privacy_version)
       VALUES ($1, $2, $3, now(), $4, $5, now(), $8, $6, $7, now(), 'test')`,
      [id, crypto.encrypt(email, `users.email:${id}`), crypto.blindIndex('email', email), crypto.encrypt(phone, `users.phone:${id}`), crypto.blindIndex('phone', phone), name, plan, `g-${id}`],
    );
    const tokens = await t.app.get(TokenService).issue(id, 'user');
    return { id, auth: { Authorization: `Bearer ${tokens.accessToken}` } };
  }

  async function admin(): Promise<U> {
    const u = await user('Super Admin');
    await t.pool.query(`UPDATE users SET role = 'super_admin' WHERE id = $1`, [u.id]);
    const tokens = await t.app.get(TokenService).issue(u.id, 'super_admin', undefined, { admin: true });
    return { id: u.id, auth: { Authorization: `Bearer ${tokens.accessToken}` } };
  }

  /** Komunitas dengan anggota (bergabung 2 hari lalu). */
  async function community(owner: U, members: U[] = [], opts: { plan?: 'free' | 'pro' | 'pro_unlimited'; city?: string; name?: string } = {}) {
    const res = await api(owner)
      .post('/v1/communities', { name: opts.name ?? `Lari ${randomUUID().slice(0, 6)}`, city: opts.city ?? 'Bandung', description: '', visibility: 'open' })
      .expect(201);
    const id = res.body.id as string;
    await t.pool.query(`UPDATE communities SET plan = $2, member_count = $3 WHERE id = $1`, [id, opts.plan ?? 'pro_unlimited', 1 + members.length]);
    await t.pool.query(`UPDATE community_members SET joined_at = now() - interval '2 days' WHERE community_id = $1`, [id]);
    for (const m of members) {
      await t.pool.query(`INSERT INTO community_members (community_id, user_id, status, joined_at) VALUES ($1, $2, 'active', now() - interval '2 days')`, [id, m.id]);
    }
    return id;
  }

  const setPlan = (id: string, plan: 'free' | 'pro' | 'pro_unlimited') => t.pool.query('UPDATE communities SET plan = $2 WHERE id = $1', [id, plan]);

  const api = (u: U) => {
    const ip = freshIp();
    const w = (r: request.Test) => r.set('X-Forwarded-For', ip).set(u.auth);
    return {
      get: (p: string) => w(request(t.http).get(p)),
      post: (p: string, body?: object) => w(request(t.http).post(p)).send(body ?? {}),
      put: (p: string, body: object) => w(request(t.http).put(p)).send(body),
      patch: (p: string, body: object) => w(request(t.http).patch(p)).send(body),
      del: (p: string) => w(request(t.http).delete(p)),
    };
  };

  const sessionBody = (over: Record<string, unknown> = {}) => ({
    title: 'Lari pagi Gasibu',
    locationName: 'Lapangan Gasibu',
    point: SATE,
    startsAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    distanceM: 5000,
    paceTargetSPerKm: 390,
    ...over,
  });

  // ---------- Jadwal + RSVP ----------

  describe('jadwal lari rutin + RSVP', () => {
    it('jadwal rutin membentuk sesi mingguan (WIB) yang bisa di-RSVP anggota; gratis untuk komunitas non-Pro', async () => {
      const owner = await user('Pemilik');
      const ani = await user('Ani');
      const outsider = await user('Luar');
      const cid = await community(owner, [ani], { plan: 'free' });

      // Besok (WIB), jam 05:30.
      const tomorrow = new Date(Date.now() + 7 * 3_600_000 + 86_400_000);
      const weekday = ((tomorrow.getUTCDay() + 6) % 7) + 1; // hari ISO besok (WIB)
      const sch = await api(owner)
        .post(`/v1/communities/${cid}/schedules`, { title: 'Long run Sabtu', weekday, startTime: '05:30', locationName: 'Gasibu', point: SATE, distanceM: 15000 })
        .expect(201);
      expect(sch.body).toMatchObject({ weekday, startTime: '05:30', timezone: 'Asia/Jakarta' });

      const list = await api(ani).get(`/v1/communities/${cid}/sessions`).expect(200);
      expect(list.body.items.length).toBeGreaterThanOrEqual(4);
      expect(list.body.attendanceEnabled).toBe(false);
      for (const s of list.body.items as { startsAt: string }[]) {
        const local = new Date(new Date(s.startsAt).getTime() + 7 * 3_600_000);
        expect(local.getUTCHours()).toBe(5);
        expect(local.getUTCMinutes()).toBe(30);
        expect(((local.getUTCDay() + 6) % 7) + 1).toBe(weekday);
      }
      // Idempoten: membuka daftar lagi dan job worker tidak menggandakan sesi.
      await t.app.get(SchedulesService).runJobs();
      const again = await api(ani).get(`/v1/communities/${cid}/sessions`).expect(200);
      expect(again.body.items.length).toBe(list.body.items.length);

      const first = list.body.items[0].id as string;
      const r = await api(ani).post(`/v1/sessions/${first}/rsvp`, { going: true }).expect(200);
      expect(r.body.rsvp).toEqual({ going: 1, notGoing: 0, mine: 'going' });
      expect(r.body.goingMembers).toEqual([expect.objectContaining({ userId: ani.id, displayName: 'Ani' })]);

      // Orang luar: 404 untuk daftar, detail, dan RSVP.
      await api(outsider).get(`/v1/communities/${cid}/sessions`).expect(404);
      await api(outsider).get(`/v1/sessions/${first}`).expect(404);
      await api(outsider).post(`/v1/sessions/${first}/rsvp`, { going: true }).expect(404);
      // Anggota biasa tidak bisa membuat jadwal.
      expect((await api(ani).post(`/v1/communities/${cid}/schedules`, { title: 'X jadwal', weekday: 1, startTime: '06:00', locationName: 'Gasibu' })).body.error).toBe('not_admin');

      // Notifikasi jadwal baru ke anggota (kategori schedule), tanpa lokasi di teks push.
      const job = t.push.to(ani.id).find((j) => j.data.category === 'schedule');
      expect(job).toBeDefined();
      expect(job!.body).not.toContain('Gasibu');

      // Ubah jam: sesi mendatang dibentuk ulang (RSVP lama ikut hilang).
      await api(owner).patch(`/v1/communities/${cid}/schedules/${sch.body.id}`, { startTime: '06:00' }).expect(200);
      const moved = await api(ani).get(`/v1/communities/${cid}/sessions`).expect(200);
      expect(moved.body.items.every((s: { startsAt: string; rsvp: { going: number } }) => new Date(new Date(s.startsAt).getTime() + 7 * 3_600_000).getUTCHours() === 6 && s.rsvp.going === 0)).toBe(true);

      // Hapus jadwal: sesi mendatang terhapus.
      await api(owner).del(`/v1/communities/${cid}/schedules/${sch.body.id}`).expect(204);
      expect((await api(ani).get(`/v1/communities/${cid}/sessions`).expect(200)).body.items).toHaveLength(0);
    });

    it('sesi sekali jalan: pengingat 2 jam sebelum ke yang RSVP ikut; batal memberi tahu; tidak bisa RSVP sesi batal', async () => {
      const owner = await user('Pemilik');
      const ani = await user('Ani');
      const budi = await user('Budi');
      const cid = await community(owner, [ani, budi], { plan: 'free' });
      const s = await api(owner).post(`/v1/communities/${cid}/sessions`, sessionBody({ startsAt: new Date(Date.now() + 90 * 60_000).toISOString() })).expect(201);
      await api(ani).post(`/v1/sessions/${s.body.id}/rsvp`, { going: true }).expect(200);
      await api(budi).post(`/v1/sessions/${s.body.id}/rsvp`, { going: false }).expect(200);
      t.push.jobs = [];
      const out = await t.app.get(SchedulesService).runJobs();
      expect(out.reminded).toBe(1);
      expect(t.push.to(ani.id).map((j) => j.data.type)).toEqual(['session_reminder']);
      expect(t.push.to(budi.id)).toHaveLength(0);
      expect((await t.app.get(SchedulesService).runJobs()).reminded).toBe(0); // sekali saja

      await api(owner).post(`/v1/sessions/${s.body.id}/cancel`).expect(204);
      expect(t.push.to(ani.id).map((j) => j.data.type)).toContain('session_cancelled');
      expect((await api(budi).post(`/v1/sessions/${s.body.id}/rsvp`, { going: true })).body.error).toBe('session_cancelled');
      // Sesi di masa lalu ditolak.
      expect((await api(owner).post(`/v1/communities/${cid}/sessions`, sessionBody({ startsAt: new Date(Date.now() - 60_000).toISOString() }))).body.error).toBe('session_in_past');
    });

    it('komunitas yang diturunkan super admin tertutup untuk fitur jadwal (404)', async () => {
      const owner = await user('Pemilik');
      const cid = await community(owner);
      const s = await api(owner).post(`/v1/communities/${cid}/sessions`, sessionBody()).expect(201);
      await t.pool.query('UPDATE communities SET removed_at = now() WHERE id = $1', [cid]);
      await api(owner).get(`/v1/communities/${cid}/sessions`).expect(404);
      await api(owner).get(`/v1/sessions/${s.body.id}`).expect(404);
    });
  });

  // ---------- Absensi ----------

  describe('absensi QR / GPS (Pro)', () => {
    it('QR: hanya Pro; token berputar, kedaluwarsa, tidak bisa dipakai di sesi lain; sekali hadir per sesi', async () => {
      const owner = await user('Pemilik');
      const ani = await user('Ani');
      const cid = await community(owner, [ani], { plan: 'free' });
      const s1 = (await api(owner).post(`/v1/communities/${cid}/sessions`, sessionBody()).expect(201)).body.id as string;
      const s2 = (await api(owner).post(`/v1/communities/${cid}/sessions`, sessionBody({ title: 'Sesi kedua' })).expect(201)).body.id as string;

      // Gratis: QR dan check-in ditolak dengan limit_reached (dialog upgrade 2.5).
      const locked = await api(owner).get(`/v1/sessions/${s1}/qr`).expect(403);
      expect(locked.body).toMatchObject({ error: 'limit_reached', limit: { kind: 'attendance' } });
      expect((await api(ani).post(`/v1/sessions/${s1}/check-in/qr`, { token: 'PTQR1.x.1.aaaaaaaaaaaaaaaaaaaaaa' })).body.error).toBe('limit_reached');

      await setPlan(cid, 'pro');
      expect((await api(ani).get(`/v1/sessions/${s1}/qr`)).body.error).toBe('not_admin');
      const qr = await api(owner).get(`/v1/sessions/${s1}/qr`).expect(200);
      expect(qr.body.refreshAfterS).toBe(30);

      // Token sesi lain ditolak.
      const other = await api(owner).get(`/v1/sessions/${s2}/qr`).expect(200);
      expect((await api(ani).post(`/v1/sessions/${s1}/check-in/qr`, { token: other.body.token })).body.error).toBe('qr_invalid');
      // Token kedaluwarsa (2 menit lalu) dan token palsu.
      const key = qrKey(t.env.BLIND_INDEX_KEY);
      const old = makeQrToken(key, s1, Date.now() - 120_000).token;
      expect((await api(ani).post(`/v1/sessions/${s1}/check-in/qr`, { token: old })).body.error).toBe('qr_expired');
      const forged = `${qr.body.token.slice(0, -4)}AAAA`;
      expect((await api(ani).post(`/v1/sessions/${s1}/check-in/qr`, { token: forged })).body.error).toBe('qr_invalid');
      expect(verifyQrToken(key, s1, qr.body.token)).toBe('ok');

      const ok = await api(ani).post(`/v1/sessions/${s1}/check-in/qr`, { token: qr.body.token }).expect(200);
      expect(ok.body).toMatchObject({ present: true, method: 'qr', alreadyCheckedIn: false });
      const again = await api(ani).post(`/v1/sessions/${s1}/check-in/qr`, { token: qr.body.token }).expect(200);
      expect(again.body.alreadyCheckedIn).toBe(true);
      expect((await t.pool.query('SELECT count(*)::int AS n FROM session_attendance')).rows[0].n).toBe(1);

      // Rekap admin; anggota biasa tidak boleh.
      const rec = await api(owner).get(`/v1/sessions/${s1}/attendance`).expect(200);
      expect(rec.body.present).toBe(1);
      expect(rec.body.members.find((m: { userId: string }) => m.userId === ani.id)).toMatchObject({ present: true, method: 'qr' });
      expect((await api(ani).get(`/v1/sessions/${s1}/attendance`)).body.error).toBe('not_admin');
      const sum = await api(owner).get(`/v1/communities/${cid}/attendance`).expect(200);
      expect(sum.body.members.find((m: { userId: string }) => m.userId === ani.id).attended).toBe(1);

      // Pro berakhir: rekap tetap bisa dibaca, check-in dikunci.
      await setPlan(cid, 'free');
      await api(owner).get(`/v1/sessions/${s1}/attendance`).expect(200);
      expect((await api(owner).post(`/v1/sessions/${s1}/attendance/${owner.id}`, { present: true })).body.error).toBe('limit_reached');
    });

    it('QR di luar jendela sesi ditolak', async () => {
      const owner = await user('Pemilik');
      const cid = await community(owner);
      const s = (await api(owner).post(`/v1/communities/${cid}/sessions`, sessionBody({ startsAt: new Date(Date.now() + 5 * 3_600_000).toISOString() })).expect(201)).body.id;
      expect((await api(owner).get(`/v1/sessions/${s}/qr`)).body.error).toBe('checkin_closed');
    });

    it('GPS: di luar radius / akurasi buruk / lokasi palsu ditolak; lokasi tidak disimpan di mana pun', async () => {
      const owner = await user('Pemilik');
      const ani = await user('Ani');
      const cid = await community(owner, [ani]);
      const s = (await api(owner).post(`/v1/communities/${cid}/sessions`, sessionBody()).expect(201)).body.id as string;
      const far = { lat: SATE.lat + 0.01, lng: SATE.lng, accuracyM: 10 }; // ±1,1 km
      const res = await api(ani).post(`/v1/sessions/${s}/check-in/gps`, far).expect(403);
      expect(res.body.error).toBe('too_far');
      expect((await api(ani).post(`/v1/sessions/${s}/check-in/gps`, { ...SATE, accuracyM: 500 })).body.error).toBe('gps_inaccurate');
      expect((await api(ani).post(`/v1/sessions/${s}/check-in/gps`, { ...SATE, accuracyM: 5, mocked: true })).body.error).toBe('mock_location');

      const near = { lat: SATE.lat + 0.0009, lng: SATE.lng + 0.0004, accuracyM: 12 }; // ±110 m
      const ok = await api(ani).post(`/v1/sessions/${s}/check-in/gps`, near).expect(200);
      expect(ok.body).toMatchObject({ present: true, method: 'gps' });

      // Tidak ada koordinat check-in yang tersimpan: tabel absensi tidak punya kolom lokasi, dan nilai yang dikirim
      // tidak muncul di database maupun Redis.
      const { rows: cols } = await t.pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'session_attendance'`);
      expect(cols.map((c) => c.column_name).sort()).toEqual(['checked_at', 'marked_by', 'method', 'session_id', 'user_id']);
      const dump = JSON.stringify((await t.pool.query('SELECT * FROM session_attendance')).rows);
      expect(dump).not.toContain(String(near.lat));
      const keys = await t.redis.keys('*');
      for (const k of keys) {
        const type = await t.redis.type(k);
        if (type === 'string') expect(await t.redis.get(k)).not.toContain(String(near.lat));
      }

      // Sesi tanpa titik kumpul: GPS tidak tersedia.
      const s2 = (await api(owner).post(`/v1/communities/${cid}/sessions`, sessionBody({ point: null })).expect(201)).body.id;
      expect((await api(ani).post(`/v1/sessions/${s2}/check-in/gps`, near)).body.error).toBe('no_meeting_point');
    });
  });

  // ---------- Liga + statistik ----------

  describe('liga antar komunitas + statistik komunitas (Pro)', () => {
    async function run(u: U, o: { km: number; source?: string; verified?: boolean; visibility?: string; startedAgoMin?: number }) {
      const started = new Date(Date.now() - (o.startedAgoMin ?? 30) * 60_000);
      const dist = Math.round(o.km * 1000);
      const moving = Math.round(o.km * 360); // 6:00/km
      await t.pool.query(
        `INSERT INTO runs (user_id, client_run_id, source, title, visibility, started_at, ended_at, distance_m, moving_time_s, elapsed_time_s, avg_pace_s_per_km, stats_verified)
         VALUES ($1, $2, $3, 'Lari', $4, $5, $6, $7, $8, $8, 360, $9)`,
        [u.id, randomUUID(), o.source ?? 'app', o.visibility ?? 'community', started, new Date(started.getTime() + moving * 1000), dist, moving, o.verified ?? true],
      );
    }

    it('menghitung hanya lari sah non-Strava, terverifikasi, bukan privat, sejak bergabung; komunitas non-Pro tidak ikut', async () => {
      const a1 = await user('A1');
      const a2 = await user('A2');
      const b1 = await user('B1');
      const c1 = await user('C1');
      const late = await user('Baru');
      const A = await community(a1, [a2], { plan: 'pro', name: 'Alpha Runners' });
      const B = await community(b1, [], { plan: 'pro_unlimited', name: 'Bravo Runners' });
      const C = await community(c1, [], { plan: 'free', name: 'Charlie Runners' });
      const J = await community(await user('J'), [], { plan: 'pro', city: 'Jakarta' });
      void J;

      await run(a1, { km: 10 });
      await run(a2, { km: 5, source: 'garmin' });
      await run(a1, { km: 20, source: 'strava', visibility: 'private' }); // Strava: tidak dihitung
      await run(a2, { km: 15, source: 'health_connect', verified: false }); // statistik tidak terverifikasi
      await run(a1, { km: 8, visibility: 'private' }); // "hanya saya"
      await run(a1, { km: 0.5 }); // < 1 km
      await run(b1, { km: 12 });
      await run(c1, { km: 100 }); // komunitas gratis
      // Anggota baru: lari sebelum bergabung tidak dihitung.
      await t.pool.query(`INSERT INTO community_members (community_id, user_id, status, joined_at) VALUES ($1, $2, 'active', now())`, [B, late.id]);
      await run(late, { km: 50, startedAgoMin: 120 });

      const league = t.app.get(LeagueService);
      await league.runJob();
      const { rows } = await t.pool.query<{ community_id: string; total_m: string; runs: number; active_members: number; score: number; rank: number }>(
        'SELECT community_id, total_m, runs, active_members, score, rank FROM league_snapshots WHERE month = $1::date',
        [monthWib(new Date())],
      );
      const snap = new Map(rows.map((r) => [r.community_id, r]));
      expect(snap.has(C)).toBe(false);
      expect(snap.get(A)).toMatchObject({ total_m: '15000', runs: 2, active_members: 2, score: 3000 });
      expect(snap.get(B)).toMatchObject({ total_m: '12000', runs: 1, active_members: 1, score: 2400 });

      // Papan peringkat per kota, terlihat pengguna Level 1; komunitas gratis tidak tampil.
      const res = await api(c1).get('/v1/league?city=bandung').expect(200);
      expect(res.body.items.map((i: { community: { name: string }; rank: number }) => [i.rank, i.community.name])).toEqual([
        [1, 'Alpha Runners'],
        [2, 'Bravo Runners'],
      ]);
      expect(JSON.stringify(res.body)).not.toContain('A1'); // tanpa nama pelari
      expect(res.body.cities.map((c: { city: string }) => c.city).sort()).toEqual(['Bandung', 'Jakarta']);
      // Admin komunitas gratis melihat ajakan upgrade.
      expect(res.body.mine).toEqual([expect.objectContaining({ communityId: C, participating: false, upgradeRequired: true, isOwner: true })]);
      const mineA = await api(a2).get('/v1/league').expect(200);
      expect(mineA.body.city).toBe('Bandung');
      expect(mineA.body.mine).toEqual([expect.objectContaining({ communityId: A, participating: true, rank: 1, upgradeRequired: false })]);

      // Statistik komunitas: admin Pro saja; anggota biasa 403, orang luar 404, gratis limit_reached.
      const st = await api(a1).get(`/v1/communities/${A}/stats?period=month&count=2`).expect(200);
      expect(st.body.series).toHaveLength(2);
      expect(st.body.series[1]).toMatchObject({ totalM: 15000, runs: 2, activeMembers: 2 });
      expect((await api(a2).get(`/v1/communities/${A}/stats`)).body.error).toBe('not_admin');
      await api(b1).get(`/v1/communities/${A}/stats`).expect(404);
      expect((await api(c1).get(`/v1/communities/${C}/stats`)).body).toMatchObject({ error: 'limit_reached', limit: { kind: 'community_stats' } });

      // Pro berakhir: hilang dari liga pada snapshot berikutnya.
      await setPlan(A, 'free');
      await league.runJob();
      const after = await api(c1).get('/v1/league?city=Bandung').expect(200);
      expect(after.body.items.map((i: { community: { id: string } }) => i.community.id)).toEqual([B]);
    });
  });

  // ---------- Cari teman ----------

  describe('cari teman lari', () => {
    const profile = (over: Record<string, unknown> = {}) => ({ paceSPerKm: 360, city: 'Bandung', area: SATE, slots: ['pagi'], consent: true, ...over });

    it('opt-in eksplisit; gratis per kota, filter Premium ditegakkan server; non-opt-in dan diblokir tidak bocor', async () => {
      const me = await user('Saya');
      const ani = await user('Ani');
      const budi = await user('Budi');
      const hidden = await user('Rahasia'); // tanpa profil
      const off = await user('Nonaktif'); // profil dimatikan
      const blocked = await user('Diblokir');
      const jkt = await user('Jakarta');

      expect((await api(me).post('/v1/buddies/search', {})).body.error).toBe('buddy_profile_required');
      expect((await api(me).put('/v1/buddies/profile', profile({ consent: false }))).body.error).toBe('consent_required');
      const p = await api(me).put('/v1/buddies/profile', profile()).expect(200);
      // Area dibulatkan ke grid (tidak sama dengan titik yang dikirim).
      expect(p.body.profile.area).not.toEqual(SATE);
      expect(Math.abs(p.body.profile.area.lat - SATE.lat)).toBeLessThan(0.02);

      await api(ani).put('/v1/buddies/profile', profile({ paceSPerKm: 330, area: { lat: SATE.lat + 0.03, lng: SATE.lng }, slots: ['pagi', 'sore'] })).expect(200);
      await api(budi).put('/v1/buddies/profile', profile({ paceSPerKm: 480, area: { lat: SATE.lat + 0.3, lng: SATE.lng }, slots: ['malam'] })).expect(200);
      await api(off).put('/v1/buddies/profile', profile({ enabled: false })).expect(200);
      await api(blocked).put('/v1/buddies/profile', profile()).expect(200);
      await api(jkt).put('/v1/buddies/profile', profile({ city: 'Jakarta', area: null })).expect(200);
      await api(me).post(`/v1/feed/users/${blocked.id}/block`).expect(204);

      const free = await api(me).post('/v1/buddies/search', {}).expect(200);
      expect(free.body.filters).toBe(false);
      expect(free.body.items.map((i: { displayName: string }) => i.displayName).sort()).toEqual(['Ani', 'Budi']);
      const body = JSON.stringify(free.body);
      for (const n of ['Rahasia', 'Nonaktif', 'Diblokir', 'Jakarta']) expect(body).not.toContain(n);
      expect(body).not.toContain(hidden.id);
      // Yang diblokir juga tidak melihat saya.
      expect(JSON.stringify((await api(blocked).post('/v1/buddies/search', {}).expect(200)).body)).not.toContain('Saya');

      // Filter Premium ditolak untuk akun gratis (dialog upgrade 2.5 lewat limit.kind).
      for (const f of [{ paceMaxSPerKm: 400 }, { maxDistanceKm: 10 }, { slots: ['pagi'] }]) {
        expect((await api(me).post('/v1/buddies/search', f)).body).toMatchObject({ error: 'limit_reached', limit: { kind: 'buddy_filters' } });
      }

      await t.pool.query(`UPDATE users SET plan = 'premium' WHERE id = $1`, [me.id]);
      const near = await api(me).post('/v1/buddies/search', { maxDistanceKm: 10 }).expect(200);
      expect(near.body.items.map((i: { displayName: string }) => i.displayName)).toEqual(['Ani']);
      // Jarak hanya antar titik tengah sel grid, dibulatkan ke km (±2 km): bukan jarak persis.
      expect(near.body.items[0].distanceKm).toBeGreaterThanOrEqual(2);
      expect(near.body.items[0].distanceKm).toBeLessThanOrEqual(5);
      const pace = await api(me).post('/v1/buddies/search', { paceMinSPerKm: 420 }).expect(200);
      expect(pace.body.items.map((i: { displayName: string }) => i.displayName)).toEqual(['Budi']);
      const slot = await api(me).post('/v1/buddies/search', { slots: ['sore'] }).expect(200);
      expect(slot.body.items.map((i: { displayName: string }) => i.displayName)).toEqual(['Ani']);

      // Batas laju harian pencarian.
      await t.redis.set(`buddy:search:${me.id}:${new Date().toISOString().slice(0, 10)}`, '50');
      expect((await api(me).post('/v1/buddies/search', {})).status).toBe(429);
    });

    it('sapa harus diterima sebelum chat pribadi terbuka; tidak bisa menyapa non-opt-in; blokir memutus', async () => {
      const me = await user('Saya');
      const ani = await user('Ani');
      const hidden = await user('Rahasia');
      await api(me).put('/v1/buddies/profile', profile()).expect(200);
      await api(ani).put('/v1/buddies/profile', profile()).expect(200);

      await api(me).post('/v1/buddies/requests', { userId: hidden.id }).expect(404);
      // Sebelum sapa diterima: chat pribadi ditolak (#85).
      expect((await api(me).post('/v1/chat/direct', { userId: ani.id })).status).toBe(403);
      const sent = await api(me).post('/v1/buddies/requests', { userId: ani.id }).expect(200);
      expect(sent.body.connection).toBe('sent');
      expect(t.push.to(ani.id).map((j) => j.data.type)).toEqual(['buddy_request']);
      expect((await api(me).post('/v1/chat/direct', { userId: ani.id })).status).toBe(403);

      const inbox = await api(ani).get('/v1/buddies/requests').expect(200);
      expect(inbox.body.incoming).toHaveLength(1);
      const accepted = await api(ani).post(`/v1/buddies/requests/${inbox.body.incoming[0].id}/accept`).expect(200);
      expect(accepted.body.connection).toBe('connected');
      await api(me).post('/v1/chat/direct', { userId: ani.id }).expect(200);
      // Bisa dilaporkan (sasaran pengguna) karena pernah saling sapa.
      await api(me).post('/v1/reports', { targetType: 'user', targetId: ani.id, reason: 'spam' }).expect(201);

      // Blokir memutus hubungan: chat pribadi lewat jalur ini tertutup lagi.
      await api(ani).post(`/v1/feed/users/${me.id}/block`).expect(204);
      expect((await api(me).post('/v1/chat/direct', { userId: ani.id })).status).toBe(403);
      expect((await t.pool.query('SELECT count(*)::int AS n FROM buddy_requests')).rows[0].n).toBe(0);
    });
  });

  // ---------- Kas + jersey ----------

  describe('kas komunitas + pre-order jersey (Pro, pencatatan saja)', () => {
    it('kas: hanya admin Pro menulis, anggota membaca saldo, orang luar 404, Pro berakhir = baca saja', async () => {
      const owner = await user('Bendahara');
      const ani = await user('Ani');
      const outsider = await user('Luar');
      const cid = await community(owner, [ani], { plan: 'free' });
      const entry = { kind: 'in', amount: 250_000, category: 'iuran', occurredOn: '2026-11-01', description: 'Iuran November' };

      expect((await api(owner).post(`/v1/communities/${cid}/cash`, entry)).body).toMatchObject({ error: 'limit_reached', limit: { kind: 'community_cash' } });
      await setPlan(cid, 'pro');
      await api(owner).post(`/v1/communities/${cid}/cash`, entry).expect(201);
      const out = await api(owner).post(`/v1/communities/${cid}/cash`, { kind: 'out', amount: 75_000, category: 'konsumsi', occurredOn: '2026-11-02' }).expect(201);
      expect(out.body).toMatchObject({ balance: 175_000, totalIn: 250_000, totalOut: 75_000, canWrite: true });
      expect(out.body.notice).toContain('Pencatatan saja');
      expect((await api(owner).post(`/v1/communities/${cid}/cash`, { ...entry, amount: 10.5 })).status).toBe(400); // rupiah bulat

      const seen = await api(ani).get(`/v1/communities/${cid}/cash`).expect(200);
      expect(seen.body).toMatchObject({ balance: 175_000, canWrite: false });
      expect(seen.body.items[1]).toMatchObject({ description: 'Iuran November', recordedBy: 'Bendahara' });
      expect((await api(ani).post(`/v1/communities/${cid}/cash`, entry)).body.error).toBe('not_admin');
      await api(outsider).get(`/v1/communities/${cid}/cash`).expect(404);
      await api(outsider).post(`/v1/communities/${cid}/cash`, entry).expect(404);

      await setPlan(cid, 'free');
      expect((await api(owner).get(`/v1/communities/${cid}/cash`).expect(200)).body).toMatchObject({ balance: 175_000, canWrite: false, proActive: false });
      expect((await api(owner).del(`/v1/communities/${cid}/cash/${seen.body.items[0].id}`)).body.error).toBe('limit_reached');
    });

    it('jersey: admin membuat item, anggota memesan, anggota lain hanya melihat jumlah; lunas dikunci; batas waktu', async () => {
      const owner = await user('Admin Jersey');
      const ani = await user('Ani');
      const budi = await user('Budi');
      const outsider = await user('Luar');
      const cid = await community(owner, [ani, budi], { plan: 'pro' });
      const item = { name: 'Jersey 2027', price: 185_000, sizes: ['S', 'M', 'L'], orderDeadline: new Date(Date.now() + 7 * 86_400_000).toISOString() };
      expect((await api(ani).post(`/v1/communities/${cid}/jersey`, item)).body.error).toBe('not_admin');
      const created = await api(owner).post(`/v1/communities/${cid}/jersey`, item).expect(201);
      const itemId = created.body.items[0].id as string;

      expect((await api(ani).post(`/v1/jersey/items/${itemId}/orders`, { size: 'XL', quantity: 1 })).body.error).toBe('invalid_size');
      const mine = await api(ani).post(`/v1/jersey/items/${itemId}/orders`, { size: 'M', quantity: 2, note: 'Nama punggung ANI' }).expect(200);
      expect(mine.body.items[0].myOrders).toEqual([expect.objectContaining({ size: 'M', quantity: 2, paid: false })]);
      await api(outsider).post(`/v1/jersey/items/${itemId}/orders`, { size: 'M', quantity: 1 }).expect(404);

      const budiView = await api(budi).get(`/v1/communities/${cid}/jersey`).expect(200);
      expect(budiView.body.items[0].totals).toEqual([{ size: 'S', quantity: 0 }, { size: 'M', quantity: 2 }, { size: 'L', quantity: 0 }]);
      expect(JSON.stringify(budiView.body)).not.toContain('ANI');
      expect((await api(budi).get(`/v1/jersey/items/${itemId}/orders`)).body.error).toBe('not_admin');

      const orders = await api(owner).get(`/v1/jersey/items/${itemId}/orders`).expect(200);
      expect(orders.body.orders[0]).toMatchObject({ user: { id: ani.id, displayName: 'Ani' }, size: 'M', quantity: 2 });
      const paid = await api(owner).post(`/v1/jersey/orders/${orders.body.orders[0].id}/paid`, { paid: true }).expect(200);
      expect(paid.body).toMatchObject({ paidQuantity: 2, paidAmount: 370_000 });
      expect((await api(ani).post(`/v1/jersey/items/${itemId}/orders`, { size: 'M', quantity: 1 })).body.error).toBe('order_paid');
      expect((await api(ani).del(`/v1/jersey/orders/${orders.body.orders[0].id}`)).body.error).toBe('order_paid');
      expect((await api(budi).post(`/v1/jersey/orders/${orders.body.orders[0].id}/paid`, { paid: false })).status).toBe(404);

      await t.pool.query(`UPDATE jersey_items SET order_deadline = now() - interval '1 minute' WHERE id = $1`, [itemId]);
      expect((await api(budi).post(`/v1/jersey/items/${itemId}/orders`, { size: 'S', quantity: 1 })).body.error).toBe('orders_closed');
    });
  });

  // ---------- Spot ----------

  describe('peta spot lari', () => {
    const spot = (over: Record<string, unknown> = {}) => ({ name: 'Taman Lansia', city: 'Bandung', point: SATE, lighting: 2, toilet: true, parking: false, notes: 'Ramai pagi', ...over });
    const box = { bbox: { minLat: SATE.lat - 0.05, minLng: SATE.lng - 0.05, maxLat: SATE.lat + 0.05, maxLng: SATE.lng + 0.05 } };

    it('kiriman masuk antrean, tayang setelah disetujui; bbox; laporan menyembunyikan lalu menurunkan', async () => {
      const ani = await user('Ani');
      const sa = await admin();
      const created = await api(ani).post('/v1/spots', spot()).expect(201);
      expect((await api(ani).post('/v1/spots/query', box).expect(200)).body.items).toHaveLength(0);
      expect((await api(ani).get('/v1/spots/mine').expect(200)).body.items[0]).toMatchObject({ status: 'pending' });
      // Pengguna lain tidak melihat spot yang belum disetujui.
      const budi = await user('Budi');
      await api(budi).get(`/v1/spots/${created.body.id}`).expect(404);
      // Bukan super admin: antrean panel ditolak.
      expect([401, 403]).toContain((await api(ani).get('/v1/admin/spots')).status);

      const q = await api(sa).get('/v1/admin/spots').expect(200);
      expect(q.body.items).toEqual([expect.objectContaining({ id: created.body.id, submitter: 'Ani', nearbyApproved: 0 })]);
      await api(sa).post(`/v1/admin/spots/${created.body.id}/approve`, { name: 'Taman Lansia Cisangkuy' }).expect(200);
      expect(t.push.to(ani.id).map((j) => j.data.type)).toContain('spot_approved');
      const log = await t.pool.query<{ action: string }>('SELECT action FROM admin_audit_log WHERE target_id = $1', [created.body.id]);
      expect(log.rows.map((r) => r.action)).toEqual(['spot.approve']);

      const inBox = await api(budi).post('/v1/spots/query', box).expect(200);
      expect(inBox.body.items).toEqual([expect.objectContaining({ name: 'Taman Lansia Cisangkuy', lighting: 2, toilet: true, parking: false })]);
      expect(JSON.stringify(inBox.body)).not.toContain(ani.id); // pengirim tidak ditampilkan
      expect((await api(budi).post('/v1/spots/query', { bbox: { minLat: -6.3, minLng: 106.7, maxLat: -6.1, maxLng: 106.9 } }).expect(200)).body.items).toHaveLength(0);
      expect((await api(budi).post('/v1/spots/query', { bbox: { minLat: -8, minLng: 106, maxLat: -6, maxLng: 108 } })).body.error).toBe('bbox_too_large');
      expect((await api(budi).post('/v1/spots/query', { near: SATE, radiusKm: 2 }).expect(200)).body.items[0].distanceM).toBeLessThan(5);

      // Laporan: pengirim tidak bisa melapor kirimannya; 3 pelapor menyembunyikan.
      expect((await api(ani).post('/v1/reports', { targetType: 'spot', targetId: created.body.id, reason: 'spam' })).body.error).toBe('cannot_report_self');
      for (const n of ['R1', 'R2', 'R3']) {
        const r = await user(n);
        await api(r).post('/v1/reports', { targetType: 'spot', targetId: created.body.id, reason: 'other' }).expect(201);
      }
      expect((await api(budi).post('/v1/spots/query', box).expect(200)).body.items).toHaveLength(0);
      const detail = await api(sa).get(`/v1/admin/reports/spot/${created.body.id}`).expect(200);
      expect(detail.body.target).toMatchObject({ name: 'Taman Lansia Cisangkuy', hidden: true });
      await api(sa).post(`/v1/admin/reports/spot/${created.body.id}/resolve`, { action: 'remove' }).expect(204);
      expect((await t.pool.query('SELECT removed_at FROM run_spots WHERE id = $1', [created.body.id])).rows[0].removed_at).not.toBeNull();
      await api(budi).get(`/v1/spots/${created.body.id}`).expect(404);
    });

    it('penolakan dengan alasan; batas kiriman harian', async () => {
      const ani = await user('Ani');
      const sa = await admin();
      const s = await api(ani).post('/v1/spots', spot()).expect(201);
      await api(sa).post(`/v1/admin/spots/${s.body.id}/reject`, { reason: 'Lokasi rumah pribadi' }).expect(204);
      expect((await api(ani).get('/v1/spots/mine').expect(200)).body.items[0]).toMatchObject({ status: 'rejected', rejectReason: 'Lokasi rumah pribadi' });
      expect((await api(sa).post(`/v1/admin/spots/${s.body.id}/approve`, {})).body.error).toBe('spot_reviewed');
      for (let i = 0; i < 4; i++) {
        await t.pool.query(`INSERT INTO run_spots (submitted_by, name, city, location) VALUES ($1, 'Spot lain', 'Bandung', ST_SetSRID(ST_MakePoint(107.6, -6.9), 4326)::geography)`, [ani.id]);
      }
      expect((await api(ani).post('/v1/spots', spot())).body.error).toBe('spot_limit');
    });
  });

  // ---------- Hapus akun / hapus komunitas ----------

  it('hapus akun: RSVP, absensi, profil cari teman, sapaan, pesanan belum lunas, spot belum tayang dihapus; sisanya dianonimkan', async () => {
    const owner = await user('Pemilik');
    const ani = await user('Ani');
    const buddy = await user('Teman');
    const sa = await admin();
    const cid = await community(owner, [ani], { plan: 'pro' });

    // Ani: RSVP + absensi.
    const s = (await api(owner).post(`/v1/communities/${cid}/sessions`, sessionBody()).expect(201)).body.id as string;
    await api(ani).post(`/v1/sessions/${s}/rsvp`, { going: true }).expect(200);
    await api(ani).post(`/v1/sessions/${s}/check-in/gps`, { ...SATE, accuracyM: 5 }).expect(200);
    // Ani admin? Tidak; kas ditulis pemilik. Ani mengirim spot (satu disetujui, satu menunggu).
    const sp1 = (await api(ani).post('/v1/spots', { name: 'Spot Satu', city: 'Bandung', point: SATE }).expect(201)).body.id;
    await api(ani).post('/v1/spots', { name: 'Spot Dua', city: 'Bandung', point: SATE }).expect(201);
    await api(sa).post(`/v1/admin/spots/${sp1}/approve`, {}).expect(200);
    // Cari teman + sapaan.
    await api(ani).put('/v1/buddies/profile', { paceSPerKm: 360, city: 'Bandung', slots: [], consent: true }).expect(200);
    await api(buddy).put('/v1/buddies/profile', { paceSPerKm: 360, city: 'Bandung', slots: [], consent: true }).expect(200);
    await api(ani).post('/v1/buddies/requests', { userId: buddy.id }).expect(200);
    // Jersey: satu lunas, satu belum.
    const item = (
      await api(owner).post(`/v1/communities/${cid}/jersey`, { name: 'Jersey', price: 100_000, sizes: ['M', 'L'], orderDeadline: new Date(Date.now() + 86_400_000).toISOString() }).expect(201)
    ).body.items[0].id as string;
    await api(ani).post(`/v1/jersey/items/${item}/orders`, { size: 'M', quantity: 1, note: 'ANI' }).expect(200);
    await api(ani).post(`/v1/jersey/items/${item}/orders`, { size: 'L', quantity: 1 }).expect(200);
    const orders = (await api(owner).get(`/v1/jersey/items/${item}/orders`).expect(200)).body.orders as { id: string; size: string }[];
    await api(owner).post(`/v1/jersey/orders/${orders.find((o) => o.size === 'M')!.id}/paid`, { paid: true }).expect(200);
    // Kas yang ditulis pemilik (pemilik tidak bisa hapus akun selama punya anggota) → uji dengan admin Ani.
    await t.pool.query(`UPDATE community_members SET role = 'admin' WHERE community_id = $1 AND user_id = $2`, [cid, ani.id]);
    await api(ani).post(`/v1/communities/${cid}/cash`, { kind: 'in', amount: 50_000, category: 'donasi', occurredOn: '2026-11-03' }).expect(201);

    await api(ani).post('/v1/me/delete', { confirm: 'HAPUS' }).expect(204);

    const n = async (sql: string, p: unknown[] = [ani.id]) => (await t.pool.query(sql, p)).rows[0].n as number;
    expect(await n('SELECT count(*)::int AS n FROM session_rsvps WHERE user_id = $1')).toBe(0);
    expect(await n('SELECT count(*)::int AS n FROM session_attendance WHERE user_id = $1')).toBe(0);
    expect(await n('SELECT count(*)::int AS n FROM buddy_profiles WHERE user_id = $1')).toBe(0);
    expect(await n('SELECT count(*)::int AS n FROM buddy_requests WHERE from_user = $1 OR to_user = $1')).toBe(0);
    expect(await n('SELECT count(*)::int AS n FROM jersey_orders WHERE user_id = $1')).toBe(0);
    // Pesanan lunas tetap untuk catatan admin, tanpa identitas dan catatan.
    const left = (await t.pool.query('SELECT user_id, size, paid, note FROM jersey_orders WHERE item_id = $1', [item])).rows;
    expect(left).toEqual([{ user_id: null, size: 'M', paid: true, note: '' }]);
    // Kas tetap (milik komunitas), tanpa pencatat.
    const cash = (await api(owner).get(`/v1/communities/${cid}/cash`).expect(200)).body;
    expect(cash.balance).toBe(50_000);
    expect(cash.items[0].recordedBy).toBeNull();
    // Spot: yang menunggu dihapus, yang tayang tetap tanpa pengirim.
    const spots = (await t.pool.query<{ name: string; submitted_by: string | null }>('SELECT name, submitted_by FROM run_spots ORDER BY name')).rows;
    expect(spots).toEqual([{ name: 'Spot Satu', submitted_by: null }]);
  });

  it('hapus komunitas: jadwal, sesi, RSVP, absensi, kas, jersey, dan snapshot liga ikut terhapus', async () => {
    const owner = await user('Pemilik');
    const cid = await community(owner, [], { plan: 'pro' });
    await api(owner).post(`/v1/communities/${cid}/schedules`, { title: 'Rutin', weekday: 6, startTime: '05:30', locationName: 'Gasibu' }).expect(201);
    const s = (await api(owner).post(`/v1/communities/${cid}/sessions`, sessionBody()).expect(201)).body.id;
    await api(owner).post(`/v1/sessions/${s}/rsvp`, { going: true }).expect(200);
    await api(owner).post(`/v1/communities/${cid}/cash`, { kind: 'in', amount: 1000, category: 'iuran', occurredOn: '2026-11-01' }).expect(201);
    await api(owner).post(`/v1/communities/${cid}/jersey`, { name: 'Jersey', price: 1, sizes: ['M'], orderDeadline: new Date(Date.now() + 86_400_000).toISOString() }).expect(201);
    await t.app.get(LeagueService).runJob();
    await api(owner).del(`/v1/communities/${cid}`).expect(204);
    for (const tbl of ['community_schedules', 'community_sessions', 'session_rsvps', 'community_cash_entries', 'jersey_items', 'league_snapshots']) {
      expect((await t.pool.query(`SELECT count(*)::int AS n FROM ${tbl}`)).rows[0].n, tbl).toBe(0);
    }
  });
});
