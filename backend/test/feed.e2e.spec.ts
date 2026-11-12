import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password.js';
import { TokenService } from '../src/auth/token.service.js';
import { FieldCrypto } from '../src/crypto/field-crypto.js';
import { POSTS_PER_DAY } from '../src/feed/feed.service.js';
import type { Point } from '../src/runs/geo.js';
import { createTestApp, freshIp, hasTestInfra, resetData, type TestApp } from './helpers.js';

const PASSWORD = 'rahasia-sekali-123';

/** Rute 5 km bolak-balik dari "rumah" (titik tiap 10 m). */
function homeLoop5k(home: [number, number] = [-6.9, 107.6]): Point[] {
  const degPerM = 1 / 111_195;
  const pts: Point[] = [];
  for (let d = 0; d <= 5000; d += 10) {
    const along = d <= 2500 ? d : 5000 - d;
    pts.push([home[0] + along * degPerM, home[1] + (d > 2500 ? 15 * degPerM : 0), (d / 1000) * 360, 700]);
  }
  return pts;
}

describe.skipIf(!hasTestInfra)('Modul 2.1 Feed sosial (e2e)', () => {
  let t: TestApp;
  let crypto: FieldCrypto;
  let phoneSeq = 90_000_000;
  let passwordHash: string;

  beforeAll(async () => {
    t = await createTestApp();
    crypto = new FieldCrypto(t.env.DATA_ENCRYPTION_KEY, t.env.BLIND_INDEX_KEY);
    passwordHash = await hashPassword(PASSWORD);
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await resetData(t);
  });

  type U = { id: string; auth: { Authorization: string } };

  async function user(name = 'Pelari', level = 1): Promise<U> {
    const id = randomUUID();
    const email = `${id}@example.com`;
    const phone = `+62816${phoneSeq++}`;
    await t.pool.query(
      `INSERT INTO users (id, email_enc, email_bidx, email_verified_at, phone_enc, phone_bidx, phone_verified_at,
                          password_hash, display_name, privacy_accepted_at, privacy_version)
       VALUES ($1, $2, $3, now(), $4, $5, CASE WHEN $8::int = 0 THEN NULL ELSE now() END, $6, $7, now(), 'test')`,
      [
        id,
        crypto.encrypt(email, `users.email:${id}`),
        crypto.blindIndex('email', email),
        crypto.encrypt(phone, `users.phone:${id}`),
        crypto.blindIndex('phone', phone),
        passwordHash,
        name,
        level,
      ],
    );
    const tokens = await t.app.get(TokenService).issue(id, 'user');
    return { id, auth: { Authorization: `Bearer ${tokens.accessToken}` } };
  }

  async function admin(): Promise<U> {
    const u = await user('Admin');
    await t.pool.query(`UPDATE users SET role = 'super_admin' WHERE id = $1`, [u.id]);
    const tokens = await t.app.get(TokenService).issue(u.id, 'super_admin', undefined, { admin: true });
    return { id: u.id, auth: { Authorization: `Bearer ${tokens.accessToken}` } };
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
      del: (p: string) => w(request(t.http).delete(p)),
      raw: (p: string) => w(request(t.http).post(p)),
    };
  };

  async function post(u: U, body: Record<string, unknown>) {
    return (await api(u).post('/v1/feed/posts', body).expect(201)).body as { id: string; [k: string]: unknown };
  }

  async function run(u: U, visibility: 'public' | 'community' | 'private' = 'public') {
    const started = new Date(Date.now() - 2 * 3600 * 1000);
    const res = await api(u)
      .post('/v1/runs', {
        clientRunId: randomUUID(),
        title: 'Lari pagi',
        visibility,
        startedAt: started.toISOString(),
        endedAt: new Date(started.getTime() + 1800 * 1000).toISOString(),
        segments: [homeLoop5k()],
      })
      .expect(201);
    return res.body.id as string;
  }

  const ids = (res: request.Response) => (res.body.items as { id: string }[]).map((i) => i.id);

  it('visibilitas: publik di Jelajah, komunitas hanya sesama anggota, pengikut hanya pengikut; orang luar dapat 404', async () => {
    const ani = await user('Ani');
    const budi = await user('Budi'); // satu komunitas dengan Ani
    const citra = await user('Citra'); // orang luar
    await community(ani, [budi]);

    const pub = await post(ani, { text: 'Halo semua', visibility: 'public' });
    const com = await post(ani, { text: 'Latihan Sabtu jam 5', visibility: 'community' });
    const fol = await post(ani, { text: 'Untuk pengikut saja', visibility: 'followers' });

    // Isi teks tersimpan terenkripsi, bukan teks biasa.
    const { rows } = await t.pool.query<{ body_enc: Buffer }>('SELECT body_enc FROM feed_posts WHERE id = $1', [com.id]);
    expect(rows[0]!.body_enc.toString('latin1')).not.toContain('Latihan');

    // Jelajah: hanya publik.
    expect(ids(await api(citra).get('/v1/feed?tab=explore').expect(200))).toEqual([pub.id]);
    // Tab Komunitas Budi: publik + komunitas dari sesama anggota.
    expect(ids(await api(budi).get('/v1/feed?tab=community').expect(200))).toEqual([com.id, pub.id]);
    expect(ids(await api(citra).get('/v1/feed?tab=community').expect(200))).toEqual([]);

    // Orang luar tidak bisa mengambil postingan komunitas/pengikut lewat id: 404 seolah tidak ada.
    for (const id of [com.id, fol.id]) {
      await api(citra).get(`/v1/feed/posts/${id}`).expect(404);
      await api(citra).get(`/v1/feed/posts/${id}/comments`).expect(404);
      await api(citra).post(`/v1/feed/posts/${id}/like`).expect(404);
      await api(citra).post(`/v1/feed/posts/${id}/comments`, { text: 'hai' }).expect(404);
      await api(citra).post('/v1/reports', { targetType: 'post', targetId: id, reason: 'spam' }).expect(404);
    }
    await api(budi).get(`/v1/feed/posts/${fol.id}`).expect(404);

    // Citra mengikuti Ani (profil terlihat karena Ani punya postingan publik) → postingan pengikut terbuka.
    await api(citra).post(`/v1/feed/users/${ani.id}/follow`).expect(200);
    expect(ids(await api(citra).get('/v1/feed?tab=following').expect(200))).toEqual([fol.id, pub.id]);
    await api(citra).get(`/v1/feed/posts/${fol.id}`).expect(200);
    // Ani menghapus Citra dari pengikut → tertutup lagi.
    await api(ani).del(`/v1/feed/me/followers/${citra.id}`).expect(204);
    await api(citra).get(`/v1/feed/posts/${fol.id}`).expect(404);

    // Daftar pengikut hanya untuk pemiliknya; profil orang lain hanya menampilkan jumlah.
    const prof = await api(budi).get(`/v1/feed/users/${ani.id}`).expect(200);
    expect(prof.body).toMatchObject({ displayName: 'Ani', followers: 0, iFollow: false });
    expect(prof.body).not.toHaveProperty('city');

    // Pengguna tanpa jejak publik dan tanpa komunitas bersama: profil dan foto profil tidak terlihat.
    const dina = await user('Dina');
    await api(citra).get(`/v1/feed/users/${dina.id}`).expect(404);
    await api(citra).post(`/v1/feed/users/${dina.id}/follow`).expect(404);
    await api(citra).get(`/v1/users/${dina.id}/avatar`).expect(404);

    // Level 0 (HP belum terverifikasi) tidak bisa membuka feed.
    const fresh = await user('Baru', 0);
    await api(fresh).get('/v1/feed?tab=explore').expect(403);
  });

  it('hasil lari: tidak bisa memposting lari privat atau Strava, tidak lebih luas dari visibilitas lari, rute publik saja', async () => {
    const ani = await user('Ani');
    const budi = await user('Budi');
    const citra = await user('Citra');
    await community(ani, [budi]);

    const priv = await run(ani, 'private');
    expect((await api(ani).post('/v1/feed/posts', { runId: priv, visibility: 'public' }).expect(409)).body.error).toBe('run_not_shareable');
    const strava = await run(ani, 'public');
    // Lari Strava selalu privat (constraint runs_strava_private, modul 2.3); pesan galatnya khusus Strava.
    await t.pool.query(`UPDATE runs SET source = 'strava', visibility = 'private' WHERE id = $1`, [strava]);
    expect((await api(ani).post('/v1/feed/posts', { runId: strava, visibility: 'public' }).expect(409)).body.message).toMatch(/Strava/);
    // Lari orang lain tidak bisa diposting.
    const budiRun = await run(budi, 'public');
    await api(ani).post('/v1/feed/posts', { runId: budiRun, visibility: 'public' }).expect(404);

    const comRun = await run(ani, 'community');
    expect((await api(ani).post('/v1/feed/posts', { runId: comRun, visibility: 'public' }).expect(400)).body.error).toBe('visibility_too_wide');
    const comPost = await post(ani, { runId: comRun, visibility: 'community', text: '5K pagi ini' });
    expect(comPost.kind).toBe('run');
    // Satu lari hanya sekali.
    expect((await api(ani).post('/v1/feed/posts', { runId: comRun, visibility: 'community' }).expect(409)).body.error).toBe('run_already_posted');

    const pubRun = await run(ani, 'public');
    const pubPost = await post(ani, { runId: pubRun, visibility: 'public' });
    const seen = (await api(citra).get(`/v1/feed/posts/${pubPost.id}`).expect(200)).body;
    expect(seen.run.distanceM).toBeGreaterThan(4990);
    // Rute di feed = rute publik (titik rumah di dalam zona privasi 250 m tidak ada), diringkas.
    const pts = (seen.run.route as Point[][]).flat();
    expect(pts.length).toBeGreaterThan(0);
    expect(pts.length).toBeLessThanOrEqual(150);
    const degPerM = 1 / 111_195;
    expect(Math.min(...pts.map((p) => (p[0] - -6.9) / degPerM))).toBeGreaterThan(240);
    expect(JSON.stringify(seen)).not.toContain('route_full');

    // Lari dijadikan privat setelah diposting: kartu lari "tidak tersedia" bagi orang lain, rute tidak bocor.
    await request(t.http).patch(`/v1/runs/${pubRun}`).set(ani.auth).send({ visibility: 'private' }).expect(200);
    const after = (await api(citra).get(`/v1/feed/posts/${pubPost.id}`).expect(200)).body;
    expect(after.run).toBeNull();
    expect(after.runUnavailable).toBe(true);
    // Lari dihapus: postingan tetap, kartu tidak tersedia.
    await api(ani).del(`/v1/runs/${comRun}`).expect(204);
    const gone = (await api(budi).get(`/v1/feed/posts/${comPost.id}`).expect(200)).body;
    expect(gone.runUnavailable).toBe(true);
  });

  it('foto: maks. 4, diproses (EXIF dibuang), diambil lewat endpoint ber-token yang memeriksa hak akses', async () => {
    const ani = await user('Ani');
    const budi = await user('Budi');
    const citra = await user('Citra');
    await community(ani, [budi]);
    const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#f05a0e' } })
      .jpeg()
      .withExif({ IFD0: { Make: 'TestPhone', ImageDescription: 'rumah-saya' } })
      .toBuffer();

    const res = await api(ani)
      .raw('/v1/feed/posts')
      .field('data', JSON.stringify({ text: 'Medali pertama!', visibility: 'community' }))
      .attach('photos', jpeg, 'a.jpg')
      .attach('photos', jpeg, 'b.jpg')
      .expect(201);
    expect(res.body.kind).toBe('photo');
    expect(res.body.photos).toHaveLength(2);
    const stored = [...t.storage.objects.entries()].filter(([k]) => k.startsWith('feed/'));
    expect(stored).toHaveLength(2);
    const meta = await sharp(stored[0]![1].body).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.exif).toBeUndefined();

    const url = res.body.photos[0].url as string;
    await api(budi).get(url).expect(200);
    await api(citra).get(url).expect(404);

    // Lebih dari 4 foto ditolak; berkas bukan gambar ditolak.
    let five = api(ani).raw('/v1/feed/posts').field('data', JSON.stringify({ visibility: 'public' }));
    for (let i = 0; i < 5; i++) five = five.attach('photos', jpeg, `${i}.jpg`);
    expect((await five).status).toBe(400);
    await api(ani)
      .raw('/v1/feed/posts')
      .field('data', JSON.stringify({ visibility: 'public' }))
      .attach('photos', Buffer.from('bukan gambar sama sekali'), 'x.jpg')
      .expect(415);
    // Postingan kosong ditolak.
    await api(ani).post('/v1/feed/posts', { visibility: 'public', text: '   ' }).expect(400);

    // Hapus postingan: foto ikut terhapus dari penyimpanan.
    await api(budi).del(`/v1/feed/posts/${res.body.id}`).expect(404);
    await api(ani).del(`/v1/feed/posts/${res.body.id}`).expect(204);
    expect([...t.storage.objects.keys()].filter((k) => k.startsWith('feed/'))).toHaveLength(0);
  });

  it('suka, komentar, notifikasi tanpa isi komentar, hapus komentar oleh penulis/pemilik postingan', async () => {
    const ani = await user('Ani');
    const budi = await user('Budi');
    await community(ani, [budi]);
    const p = await post(ani, { text: 'Lari sore', visibility: 'community' });

    const liked = await api(budi).post(`/v1/feed/posts/${p.id}/like`).expect(200);
    expect(liked.body).toMatchObject({ likeCount: 1, likedByMe: true });
    await api(budi).post(`/v1/feed/posts/${p.id}/like`).expect(200); // idempoten
    await api(budi).del(`/v1/feed/posts/${p.id}/like`).expect(200);
    await api(budi).post(`/v1/feed/posts/${p.id}/like`).expect(200);
    // Suka-batal-suka: satu notifikasi saja.
    expect(t.push.to(ani.id).filter((j) => j.data.type === 'post_like')).toHaveLength(1);

    const c = (await api(budi).post(`/v1/feed/posts/${p.id}/comments`, { text: 'Rahasia: kunci di bawah pot' }).expect(201)).body;
    const pushes = t.push.to(ani.id).filter((j) => j.data.type === 'post_comment');
    expect(pushes).toHaveLength(1);
    expect(JSON.stringify(pushes[0])).not.toContain('Rahasia');
    const inbox = await api(ani).get('/v1/notifications').expect(200);
    expect(inbox.body.items.map((i: { type: string }) => i.type)).toEqual(expect.arrayContaining(['post_like', 'post_comment']));

    const list = await api(ani).get(`/v1/feed/posts/${p.id}/comments`).expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ text: 'Rahasia: kunci di bawah pot', canDelete: true, isMine: false });
    expect((await api(ani).get(`/v1/feed/posts/${p.id}`).expect(200)).body.commentCount).toBe(1);

    // Pengaturan "social" mematikan push, kotak notifikasi tetap.
    await request(t.http).put('/v1/me/notification-settings').set(ani.auth).send({ social: false }).expect(200);
    const before = t.push.to(ani.id).length;
    await api(budi).post(`/v1/feed/posts/${p.id}/comments`, { text: 'lagi' }).expect(201);
    expect(t.push.to(ani.id).length).toBe(before);

    // Pemilik postingan boleh menghapus komentar orang lain.
    await api(ani).del(`/v1/feed/comments/${c.id}`).expect(204);
    const outsider = await user('Luar');
    const c2 = (await api(budi).post(`/v1/feed/posts/${p.id}/comments`, { text: 'ketiga' }).expect(201)).body;
    await api(outsider).del(`/v1/feed/comments/${c2.id}`).expect(404);
  });

  it('laporan: postingan dan komentar ditahan, disembunyikan setelah 3 pelapor, admin menurunkan/mengabaikan dengan log', async () => {
    const ani = await user('Ani');
    const reporters = [await user('R1'), await user('R2'), await user('R3')];
    const viewer = await user('Penonton');
    const a = await admin();
    const p = await post(ani, { text: 'Jual akun murah', visibility: 'public' });
    const c = (await api(reporters[0]!).post(`/v1/feed/posts/${p.id}/comments`, { text: 'komentar kasar' }).expect(201)).body;

    // Tidak bisa melaporkan konten sendiri.
    await api(ani).post('/v1/reports', { targetType: 'post', targetId: p.id, reason: 'spam' }).expect(400);

    await api(reporters[0]!).post('/v1/reports', { targetType: 'post', targetId: p.id, reason: 'scam' }).expect(201);
    // Ditahan: penulis tidak bisa menghapus bukti.
    expect((await api(ani).del(`/v1/feed/posts/${p.id}`).expect(409)).body.error).toBe('content_held');
    await api(reporters[1]!).post('/v1/reports', { targetType: 'post', targetId: p.id, reason: 'scam' }).expect(201);
    await api(viewer).get(`/v1/feed/posts/${p.id}`).expect(200);
    await api(reporters[2]!).post('/v1/reports', { targetType: 'post', targetId: p.id, reason: 'spam' }).expect(201);
    // 3 pelapor: hilang dari Jelajah dan 404 bagi orang lain; penulis masih melihat dengan tanda.
    expect(ids(await api(viewer).get('/v1/feed?tab=explore').expect(200))).not.toContain(p.id);
    await api(viewer).get(`/v1/feed/posts/${p.id}`).expect(404);
    expect((await api(ani).get(`/v1/feed/posts/${p.id}`).expect(200)).body).toMatchObject({ hidden: true, underReview: true });

    // Laporan komentar.
    await api(ani).post('/v1/reports', { targetType: 'comment', targetId: c.id, reason: 'harassment' }).expect(201);
    expect((await api(reporters[0]!).del(`/v1/feed/comments/${c.id}`).expect(409)).body.error).toBe('content_held');

    const queue = await request(t.http).get('/v1/admin/reports').set(a.auth).expect(200);
    const labels = queue.body.map((q: { targetType: string; label: string }) => `${q.targetType}:${q.label}`);
    expect(labels).toEqual(expect.arrayContaining(['post:Postingan dari Ani', 'comment:Komentar dari R1']));

    const detail = await request(t.http).get(`/v1/admin/reports/post/${p.id}`).set(a.auth).expect(200);
    expect(detail.body.target).toMatchObject({ text: 'Jual akun murah', hidden: true });
    await request(t.http).post(`/v1/admin/reports/post/${p.id}/resolve`).set(a.auth).send({ action: 'remove', note: 'penipuan' }).expect(204);
    // Diturunkan: tidak ada bagi siapa pun, isi terhapus.
    await api(ani).get(`/v1/feed/posts/${p.id}`).expect(404);
    const { rows } = await t.pool.query<{ body_enc: Buffer | null; removed_at: Date | null }>('SELECT body_enc, removed_at FROM feed_posts WHERE id = $1', [p.id]);
    expect(rows[0]).toMatchObject({ body_enc: null });
    expect(rows[0]!.removed_at).not.toBeNull();

    await request(t.http).get(`/v1/admin/reports/comment/${c.id}`).set(a.auth).expect(200);
    await request(t.http).post(`/v1/admin/reports/comment/${c.id}/resolve`).set(a.auth).send({ action: 'dismiss' }).expect(204);
    const { rows: held } = await t.pool.query<{ held_at: Date | null }>('SELECT held_at FROM feed_comments WHERE id = $1', [c.id]);
    expect(held[0]!.held_at).toBeNull();

    const log = await t.pool.query<{ action: string }>('SELECT action FROM admin_audit_log ORDER BY id');
    expect(log.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['report.view_post', 'report.remove', 'report.view_comment', 'report.dismiss']));
  });

  it('blokir dan akun ditangguhkan: konten tidak tampil', async () => {
    const ani = await user('Ani');
    const budi = await user('Budi');
    const a = await admin();
    const p = await post(ani, { text: 'publik', visibility: 'public' });
    await api(budi).post(`/v1/feed/users/${ani.id}/follow`).expect(200);

    await api(ani).post(`/v1/feed/users/${budi.id}/block`).expect(204);
    // Blokir memutus follow dan menyembunyikan konten ke dua arah.
    await api(budi).get(`/v1/feed/posts/${p.id}`).expect(404);
    expect(ids(await api(budi).get('/v1/feed?tab=explore').expect(200))).toEqual([]);
    await api(budi).post(`/v1/feed/users/${ani.id}/follow`).expect(404);
    await api(budi).get(`/v1/feed/users/${ani.id}`).expect(404);
    expect((await api(ani).get('/v1/feed/me/blocks').expect(200)).body.items).toEqual([{ id: budi.id, displayName: 'Budi' }]);
    await api(ani).del(`/v1/feed/users/${budi.id}/block`).expect(204);
    await api(budi).get(`/v1/feed/posts/${p.id}`).expect(200);

    await request(t.http).post(`/v1/admin/users/${ani.id}/suspend`).set(a.auth).send({ days: 7, reason: 'spam berulang' }).expect(204);
    await api(budi).get(`/v1/feed/posts/${p.id}`).expect(404);
    expect(ids(await api(budi).get('/v1/feed?tab=explore').expect(200))).toEqual([]);
  });

  it('hapus akun: postingan, foto, komentar, suka, dan follow pengguna terhapus', async () => {
    const ani = await user('Ani');
    const budi = await user('Budi');
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000' } }).png().toBuffer();
    const own = await api(ani)
      .raw('/v1/feed/posts')
      .field('data', JSON.stringify({ text: 'punya Ani', visibility: 'public' }))
      .attach('photos', png, 'a.png')
      .expect(201);
    const bp = await post(budi, { text: 'punya Budi', visibility: 'public' });
    await api(ani).post(`/v1/feed/posts/${bp.id}/like`).expect(200);
    await api(ani).post(`/v1/feed/posts/${bp.id}/comments`, { text: 'mantap' }).expect(201);
    await api(ani).post(`/v1/feed/users/${budi.id}/follow`).expect(200);
    await api(budi).post(`/v1/feed/users/${ani.id}/follow`).expect(200);
    await api(budi).post(`/v1/feed/posts/${own.body.id}/comments`, { text: 'keren' }).expect(201);

    await request(t.http).post('/v1/me/delete').set(ani.auth).send({ password: PASSWORD, confirm: 'HAPUS' }).expect(204);

    const count = async (sql: string) => Number((await t.pool.query<{ n: string }>(sql, [ani.id])).rows[0]!.n);
    expect(await count('SELECT count(*) AS n FROM feed_posts WHERE user_id = $1')).toBe(0);
    expect(await count('SELECT count(*) AS n FROM feed_comments WHERE user_id = $1')).toBe(0);
    expect(await count('SELECT count(*) AS n FROM feed_likes WHERE user_id = $1')).toBe(0);
    expect(await count('SELECT count(*) AS n FROM feed_follows WHERE follower_id = $1 OR followee_id = $1')).toBe(0);
    expect([...t.storage.objects.keys()].filter((k) => k.startsWith(`feed/${ani.id}/`))).toHaveLength(0);
    const seen = (await api(budi).get(`/v1/feed/posts/${bp.id}`).expect(200)).body;
    expect(seen).toMatchObject({ likeCount: 0, commentCount: 0 });
  });

  it('batas: postingan per hari dan paging kursor', async () => {
    const ani = await user('Ani');
    const budi = await user('Budi');
    // Isi langsung (melewati batas laju per menit) untuk menguji paging.
    for (let i = 0; i < 25; i++) {
      await t.pool.query(`INSERT INTO feed_posts (user_id, kind, visibility, created_at) VALUES ($1, 'text', 'public', now() - make_interval(secs => $2))`, [ani.id, i]);
    }
    const first = await api(budi).get('/v1/feed?tab=explore').expect(200);
    expect(first.body.items).toHaveLength(20);
    const second = await api(budi).get(`/v1/feed?tab=explore&cursor=${first.body.nextCursor}`).expect(200);
    expect(second.body.items).toHaveLength(5);
    expect(second.body.nextCursor).toBeNull();
    expect(new Set([...ids(first), ...ids(second)]).size).toBe(25);
    await api(budi).get('/v1/feed?tab=explore&cursor=bukan-kursor').expect(400);

    await t.redis.set(`feed:posts:${ani.id}`, String(POSTS_PER_DAY));
    expect((await api(ani).post('/v1/feed/posts', { text: 'lagi', visibility: 'public' }).expect(429)).body.error).toBe('post_rate_limited');
  });
});
