import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TokenService } from '../src/auth/token.service.js';
import { FieldCrypto } from '../src/crypto/field-crypto.js';
import { createTestApp, freshIp, hasTestInfra, resetData, type TestApp } from './helpers.js';

describe.skipIf(!hasTestInfra)('Modul 1.3 Komunitas (e2e)', () => {
  let t: TestApp;
  let crypto: FieldCrypto;
  let phoneSeq = 10_000_000;

  beforeAll(async () => {
    t = await createTestApp();
    crypto = new FieldCrypto(t.env.DATA_ENCRYPTION_KEY, t.env.BLIND_INDEX_KEY);
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await resetData(t);
  });

  /** Membuat pengguna langsung di database (lebih cepat dari alur daftar) dan memberi token. */
  async function user(opts: { level?: 0 | 1; plan?: 'free' | 'premium'; name?: string } = {}) {
    const id = randomUUID();
    const email = `${id}@example.com`;
    const phone = `+62812${phoneSeq++}`;
    const level1 = (opts.level ?? 1) === 1;
    await t.pool.query(
      `INSERT INTO users (id, email_enc, email_bidx, email_verified_at, phone_enc, phone_bidx, phone_verified_at,
                          password_hash, display_name, plan, privacy_accepted_at, privacy_version)
       VALUES ($1, $2, $3, now(), $4, $5, CASE WHEN $6 THEN now() END, 'x', $7, $8, now(), 'test')`,
      [
        id,
        crypto.encrypt(email, `users.email:${id}`),
        crypto.blindIndex('email', email),
        level1 ? crypto.encrypt(phone, `users.phone:${id}`) : null,
        level1 ? crypto.blindIndex('phone', phone) : null,
        level1,
        opts.name ?? 'Pelari',
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

  async function community(owner: { auth: Record<string, string> }, extra: Record<string, unknown> = {}) {
    const res = await api(owner.auth).post('/v1/communities', {
      name: 'Bandung Runners',
      city: 'Bandung',
      description: 'Lari pagi tiap Minggu',
      visibility: 'open',
      ...extra,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  }

  const setPlan = (communityId: string, plan: 'free' | 'pro' | 'pro_unlimited') =>
    t.pool.query('UPDATE communities SET plan = $2 WHERE id = $1', [communityId, plan]);

  // ---------- Dasar ----------

  it('wajib Level 1 untuk fitur komunitas', async () => {
    const u = await user({ level: 0 });
    const res = await api(u.auth).get('/v1/communities');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('verification_required');
  });

  it('buat komunitas: pembuat menjadi pemilik dan anggota pertama', async () => {
    const owner = await user();
    const c = await community(owner);
    const detail = await api(owner.auth).get(`/v1/communities/${c.id}`).expect(200);
    expect(detail.body).toMatchObject({
      name: 'Bandung Runners',
      city: 'Bandung',
      memberCount: 1,
      myStatus: 'active',
      myRole: 'owner',
      memberLimit: { limit: 3, used: 1, reached: false },
      multiAdmin: false,
    });
  });

  it('komunitas terbuka: langsung bergabung; keluar mengurangi jumlah anggota', async () => {
    const owner = await user();
    const c = await community(owner);
    const runner = await user();
    expect((await api(runner.auth).post(`/v1/communities/${c.id}/join`)).body.status).toBe('active');
    expect((await api(owner.auth).get(`/v1/communities/${c.id}`)).body.memberCount).toBe(2);
    await api(runner.auth).post(`/v1/communities/${c.id}/leave`).expect(204);
    expect((await api(owner.auth).get(`/v1/communities/${c.id}`)).body.memberCount).toBe(1);
  });

  it('pemilik tidak bisa keluar sebelum menyerahkan kepemilikan', async () => {
    const owner = await user();
    const c = await community(owner);
    const res = await api(owner.auth).post(`/v1/communities/${c.id}/leave`);
    expect(res.status).toBe(409);
  });

  it('komunitas privat: permintaan menunggu persetujuan admin', async () => {
    const owner = await user();
    const c = await community(owner, { visibility: 'private' });
    const runner = await user({ name: 'Ani' });
    expect((await api(runner.auth).post(`/v1/communities/${c.id}/join`)).body.status).toBe('pending');
    // Pengguna yang belum jadi anggota tidak bisa melihat daftar anggota.
    expect((await api(runner.auth).get(`/v1/communities/${c.id}/members`)).status).toBe(403);

    const pending = await api(owner.auth).get(`/v1/communities/${c.id}/members?status=pending`).expect(200);
    expect(pending.body.map((m: { displayName: string }) => m.displayName)).toEqual(['Ani']);
    expect((await api(owner.auth).get(`/v1/communities/${c.id}`)).body.pendingCount).toBe(1);

    await api(owner.auth).post(`/v1/communities/${c.id}/members/${runner.id}/approve`).expect(204);
    const detail = await api(runner.auth).get(`/v1/communities/${c.id}`).expect(200);
    expect(detail.body).toMatchObject({ myStatus: 'active', memberCount: 2 });
  });

  it('kode undangan: langsung bergabung ke komunitas privat; kode dicabut tidak berlaku', async () => {
    const owner = await user();
    const c = await community(owner, { visibility: 'private' });
    const inv = await api(owner.auth).post(`/v1/communities/${c.id}/invites`, { expiresInDays: 7 }).expect(201);
    expect(inv.body.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(inv.body.url).toBe(`${t.env.PUBLIC_WEB_URL}/j/${inv.body.code}`);

    const runner = await user();
    const preview = await api(runner.auth).post('/v1/communities/invites/preview', { code: inv.body.code.toLowerCase() }).expect(200);
    expect(preview.body).toMatchObject({ id: c.id, myStatus: 'none' });
    const joined = await api(runner.auth).post('/v1/communities/join-by-code', { code: inv.body.code }).expect(200);
    expect(joined.body.myStatus).toBe('active');

    await api(owner.auth).del(`/v1/communities/${c.id}/invites/${inv.body.id}`).expect(204);
    const other = await user();
    expect((await api(other.auth).post('/v1/communities/join-by-code', { code: inv.body.code })).status).toBe(404);
  });

  it('kode undangan dengan batas pemakaian', async () => {
    const owner = await user({ plan: 'premium' });
    const c = await community(owner);
    await setPlan(c.id, 'pro');
    const inv = await api(owner.auth).post(`/v1/communities/${c.id}/invites`, { maxUses: 1 });
    await api((await user()).auth).post('/v1/communities/join-by-code', { code: inv.body.code }).expect(200);
    expect((await api((await user()).auth).post('/v1/communities/join-by-code', { code: inv.body.code })).status).toBe(404);
  });

  it('hanya admin yang bisa membuat undangan, mengubah, dan menyetujui', async () => {
    const owner = await user();
    const c = await community(owner);
    const runner = await user();
    await api(runner.auth).post(`/v1/communities/${c.id}/join`);
    expect((await api(runner.auth).post(`/v1/communities/${c.id}/invites`, {})).status).toBe(403);
    expect((await api(runner.auth).patch(`/v1/communities/${c.id}`, { name: 'Diambil alih' })).status).toBe(403);
    expect((await api(runner.auth).del(`/v1/communities/${c.id}`)).status).toBe(403);
  });

  it('dikeluarkan + diblokir: tidak bisa bergabung lagi dan komunitas tidak terlihat', async () => {
    const owner = await user();
    const c = await community(owner);
    const runner = await user();
    await api(runner.auth).post(`/v1/communities/${c.id}/join`);
    await api(owner.auth).post(`/v1/communities/${c.id}/members/${runner.id}/remove`, { ban: true }).expect(204);
    expect((await api(runner.auth).post(`/v1/communities/${c.id}/join`)).status).toBe(404);
    expect((await api(runner.auth).get(`/v1/communities/${c.id}`)).status).toBe(404);
    const dir = await api(runner.auth).get('/v1/communities').expect(200);
    expect(dir.body.items).toHaveLength(0);
    expect((await api(owner.auth).get(`/v1/communities/${c.id}`)).body.memberCount).toBe(1);
  });

  it('direktori: filter kota dan pencarian nama', async () => {
    const a = await user({ plan: 'premium' });
    await community(a, { name: 'Bandung Runners', city: 'Bandung' });
    const b = await user({ plan: 'premium' });
    await community(b, { name: 'Jakarta Night Run', city: 'Jakarta' });
    const viewer = await user();
    const byCity = await api(viewer.auth).get('/v1/communities?city=bandung').expect(200);
    expect(byCity.body.items.map((i: { name: string }) => i.name)).toEqual(['Bandung Runners']);
    const bySearch = await api(viewer.auth).get('/v1/communities?q=night').expect(200);
    expect(bySearch.body.items.map((i: { name: string }) => i.name)).toEqual(['Jakarta Night Run']);
    const cities = await api(viewer.auth).get('/v1/communities/cities').expect(200);
    expect(cities.body.map((c: { city: string }) => c.city).sort()).toEqual(['Bandung', 'Jakarta']);
  });

  // ---------- Selesai jika: batas paket gratis ditegakkan di server ----------

  it('BATAS: akun gratis hanya bisa membuat 1 komunitas gratis', async () => {
    const owner = await user();
    await community(owner);
    const second = await api(owner.auth).post('/v1/communities', { name: 'Kedua', city: 'Bandung', visibility: 'open' });
    expect(second.status).toBe(403);
    expect(second.body).toMatchObject({ error: 'limit_reached', limit: { kind: 'owned_communities', max: 1 } });
  });

  it('BATAS: komunitas Pro tidak dihitung dalam batas 1 komunitas gratis', async () => {
    const owner = await user({ plan: 'premium' });
    const c = await community(owner);
    await setPlan(c.id, 'pro');
    await community(owner, { name: 'Komunitas Kedua' });
  });

  it('BATAS: pelari gratis maksimal bergabung ke 3 komunitas (termasuk miliknya); Premium tanpa batas', async () => {
    const owners = await Promise.all([0, 1, 2, 3].map(() => user()));
    const ids = [];
    for (const o of owners) ids.push((await community(o)).id);

    const runner = await user();
    for (const id of ids.slice(0, 3)) await api(runner.auth).post(`/v1/communities/${id}/join`).expect(200);
    const fourth = await api(runner.auth).post(`/v1/communities/${ids[3]}/join`);
    expect(fourth.status).toBe(403);
    expect(fourth.body).toMatchObject({ error: 'limit_reached', limit: { kind: 'user_join', max: 3 } });

    const mine = await api(runner.auth).get('/v1/communities/mine').expect(200);
    expect(mine.body.limits.joined).toEqual({ limit: 3, used: 3, reached: true });

    await t.pool.query(`UPDATE users SET plan = 'premium' WHERE id = $1`, [runner.id]);
    await api(runner.auth).post(`/v1/communities/${ids[3]}/join`).expect(200);
  });

  it('BATAS: komunitas gratis maksimal 3 anggota, berlaku juga untuk kode undangan dan persetujuan', async () => {
    const owner = await user();
    const c = await community(owner);
    await api((await user()).auth).post(`/v1/communities/${c.id}/join`).expect(200);
    await api((await user()).auth).post(`/v1/communities/${c.id}/join`).expect(200);

    const fourth = await user();
    const res = await api(fourth.auth).post(`/v1/communities/${c.id}/join`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'limit_reached', limit: { kind: 'community_members', max: 3 } });

    const inv = await api(owner.auth).post(`/v1/communities/${c.id}/invites`, {});
    expect((await api(fourth.auth).post('/v1/communities/join-by-code', { code: inv.body.code })).status).toBe(403);

    await api(owner.auth).patch(`/v1/communities/${c.id}`, { visibility: 'private' }).expect(200);
    const requester = await user();
    expect((await api(requester.auth).post(`/v1/communities/${c.id}/join`)).body.status).toBe('pending');
    const approve = await api(owner.auth).post(`/v1/communities/${c.id}/members/${requester.id}/approve`);
    expect(approve.status).toBe(403);
    expect(approve.body.error).toBe('limit_reached');
  });

  it('BATAS: Pro maksimal 30 anggota; Pro Unlimited tanpa batas', async () => {
    const owner = await user();
    const c = await community(owner);
    await setPlan(c.id, 'pro');
    await t.pool.query('UPDATE communities SET member_count = 30 WHERE id = $1', [c.id]);
    const res = await api((await user()).auth).post(`/v1/communities/${c.id}/join`);
    expect(res.status).toBe(403);
    expect(res.body.limit).toEqual({ kind: 'community_members', max: 30 });

    await setPlan(c.id, 'pro_unlimited');
    await api((await user()).auth).post(`/v1/communities/${c.id}/join`).expect(200);
  });

  it('BATAS: paket berakhir → komunitas di atas batas tidak menerima anggota baru, data tidak dihapus', async () => {
    const owner = await user();
    const c = await community(owner);
    await setPlan(c.id, 'pro');
    for (let i = 0; i < 4; i++) await api((await user()).auth).post(`/v1/communities/${c.id}/join`).expect(200);
    await setPlan(c.id, 'free'); // langganan berakhir
    expect((await api((await user()).auth).post(`/v1/communities/${c.id}/join`)).status).toBe(403);
    const members = await api(owner.auth).get(`/v1/communities/${c.id}/members`).expect(200);
    expect(members.body).toHaveLength(5);
  });

  it('BATAS: multi-admin hanya untuk Komunitas Pro', async () => {
    const owner = await user();
    const c = await community(owner);
    const runner = await user();
    await api(runner.auth).post(`/v1/communities/${c.id}/join`);
    const res = await api(owner.auth).post(`/v1/communities/${c.id}/members/${runner.id}/role`, { role: 'admin' });
    expect(res.status).toBe(403);
    expect(res.body.limit.kind).toBe('multi_admin');

    await setPlan(c.id, 'pro');
    await api(owner.auth).post(`/v1/communities/${c.id}/members/${runner.id}/role`, { role: 'admin' }).expect(204);
    // Admin bisa membuat undangan; tetapi tidak bisa mengangkat admin lain (hanya pemilik).
    await api(runner.auth).post(`/v1/communities/${c.id}/invites`, {}).expect(201);
    const third = await user();
    await api(third.auth).post(`/v1/communities/${c.id}/join`);
    expect((await api(runner.auth).post(`/v1/communities/${c.id}/members/${third.id}/role`, { role: 'admin' })).status).toBe(403);
  });

  it('BATAS: permintaan bergabung bersamaan tidak bisa melewati batas anggota', async () => {
    const owner = await user();
    const c = await community(owner);
    const runners = await Promise.all(Array.from({ length: 8 }, () => user()));
    const results = await Promise.all(runners.map((r) => api(r.auth).post(`/v1/communities/${c.id}/join`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 403)).toHaveLength(6);
    const { rows } = await t.pool.query<{ member_count: number; actual: string }>(
      `SELECT member_count, (SELECT count(*) FROM community_members WHERE community_id = $1 AND status = 'active') AS actual
         FROM communities WHERE id = $1`,
      [c.id],
    );
    expect(rows[0]).toEqual({ member_count: 3, actual: '3' });
  });

  // ---------- Kepemilikan & hapus akun ----------

  it('serah terima kepemilikan; pemilik lama menjadi anggota di komunitas gratis', async () => {
    const owner = await user();
    const c = await community(owner);
    const runner = await user();
    await api(runner.auth).post(`/v1/communities/${c.id}/join`);
    await api(owner.auth).post(`/v1/communities/${c.id}/transfer`, { userId: runner.id }).expect(204);
    expect((await api(runner.auth).get(`/v1/communities/${c.id}`)).body.myRole).toBe('owner');
    expect((await api(owner.auth).get(`/v1/communities/${c.id}`)).body.myRole).toBe('member');
    await api(owner.auth).post(`/v1/communities/${c.id}/leave`).expect(204);
  });

  it('hapus akun: ditolak jika masih memiliki komunitas beranggota; komunitas kosong ikut terhapus', async () => {
    const owner = await user();
    const c = await community(owner);
    const runner = await user();
    await api(runner.auth).post(`/v1/communities/${c.id}/join`);

    const blocked = await api(owner.auth).post('/v1/me/delete', { confirm: 'HAPUS', password: 'x' });
    // Akun uji berkata sandi 'x' (bukan hash), jadi pakai akun tanpa kata sandi untuk alur ini.
    expect([401, 409]).toContain(blocked.status);
    await t.pool.query('UPDATE users SET password_hash = NULL, google_sub = $2 WHERE id = $1', [owner.id, `g-${owner.id}`]);
    const res = await api(owner.auth).post('/v1/me/delete', { confirm: 'HAPUS' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('owns_communities');

    // Anggota yang menghapus akun keluar dari komunitas dan jumlah anggota turun.
    await t.pool.query('UPDATE users SET password_hash = NULL, google_sub = $2 WHERE id = $1', [runner.id, `g-${runner.id}`]);
    await api(runner.auth).post('/v1/me/delete', { confirm: 'HAPUS' }).expect(204);
    expect((await api(owner.auth).get(`/v1/communities/${c.id}`)).body.memberCount).toBe(1);

    // Sekarang komunitas hanya berisi pemilik → hapus akun berhasil dan komunitas ikut terhapus.
    await api(owner.auth).post('/v1/me/delete', { confirm: 'HAPUS' }).expect(204);
    expect((await t.pool.query('SELECT 1 FROM communities WHERE id = $1', [c.id])).rowCount).toBe(0);
  });

  it('profil pengguna lain hanya terlihat oleh sesama anggota komunitas', async () => {
    const owner = await user({ name: 'Pemilik' });
    const c = await community(owner);
    const stranger = await user();
    expect((await api(stranger.auth).get(`/v1/users/${owner.id}`)).status).toBe(404);
    await api(stranger.auth).post(`/v1/communities/${c.id}/join`);
    const res = await api(stranger.auth).get(`/v1/users/${owner.id}`).expect(200);
    expect(res.body.displayName).toBe('Pemilik');
    expect(res.body).not.toHaveProperty('email');
  });
});
