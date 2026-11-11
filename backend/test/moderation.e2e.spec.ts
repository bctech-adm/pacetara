import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { totpAad } from '../src/admin/admin-auth.service.js';
import { generateTotpSecret, totpCode } from '../src/admin/totp.js';
import { hashPassword } from '../src/auth/password.js';
import { TokenService } from '../src/auth/token.service.js';
import { FieldCrypto } from '../src/crypto/field-crypto.js';
import { createTestApp, freshIp, hasTestInfra, resetData, type TestApp } from './helpers.js';

const PASSWORD = 'rahasia-sekali-123';

describe.skipIf(!hasTestInfra)('Modul 1.8 Laporan dan panel super admin (e2e)', () => {
  let t: TestApp;
  let crypto: FieldCrypto;
  let phoneSeq = 50_000_000;
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
    t.storage.objects.clear();
  });

  type U = { id: string; email: string; auth: { Authorization: string } };

  async function user(name = 'Pelari'): Promise<U> {
    const id = randomUUID();
    const email = `${id}@example.com`;
    const phone = `+62813${phoneSeq++}`;
    await t.pool.query(
      `INSERT INTO users (id, email_enc, email_bidx, email_verified_at, phone_enc, phone_bidx, phone_verified_at,
                          password_hash, display_name, privacy_accepted_at, privacy_version)
       VALUES ($1, $2, $3, now(), $4, $5, now(), $6, $7, now(), 'test')`,
      [
        id,
        crypto.encrypt(email, `users.email:${id}`),
        crypto.blindIndex('email', email),
        crypto.encrypt(phone, `users.phone:${id}`),
        crypto.blindIndex('phone', phone),
        passwordHash,
        name,
      ],
    );
    const tokens = await t.app.get(TokenService).issue(id, 'user');
    return { id, email, auth: { Authorization: `Bearer ${tokens.accessToken}` } };
  }

  async function superAdmin() {
    const u = await user('Admin');
    const secret = generateTotpSecret();
    await t.pool.query(`UPDATE users SET role = 'super_admin', totp_secret_enc = $2 WHERE id = $1`, [u.id, crypto.encrypt(secret, totpAad(u.id))]);
    const code = (offset = 0) => totpCode(secret, Math.floor(Date.now() / 30_000) + offset);
    const login = async () => {
      const res = await request(t.http)
        .post('/v1/admin/auth/login')
        .set('X-Forwarded-For', freshIp())
        .send({ email: u.email, password: PASSWORD, code: code() })
        .expect(200);
      return { Authorization: `Bearer ${res.body.accessToken as string}` };
    };
    return { ...u, secret, code, login };
  }

  async function community(owner: U, members: U[] = []) {
    const res = await request(t.http).post('/v1/communities').set(owner.auth).send({ name: 'Lari Pagi', city: 'Bandung', description: '', visibility: 'open' }).expect(201);
    const id = res.body.id as string;
    await t.pool.query(`UPDATE communities SET plan = 'pro_unlimited' WHERE id = $1`, [id]);
    for (const m of members) {
      await t.pool.query(`INSERT INTO community_members (community_id, user_id, status, joined_at) VALUES ($1, $2, 'active', now())`, [id, m.id]);
    }
    const conv = (await request(t.http).get(`/v1/chat/communities/${id}`).set(owner.auth).expect(200)).body.id as string;
    return { id, conv };
  }

  const say = (u: U, conv: string, text: string) =>
    request(t.http).post(`/v1/chat/conversations/${conv}/messages`).set(u.auth).send({ clientMsgId: randomUUID(), kind: 'text', text }).expect(201);
  const report = (u: U, targetType: string, targetId: string, reason = 'harassment', details?: string) =>
    request(t.http).post('/v1/reports').set(u.auth).send({ targetType, targetId, reason, ...(details ? { details } : {}) });

  it('lapor pesan: hanya peserta, pesan ditahan, disembunyikan setelah 3 pelapor', async () => {
    const sender = await user('Penyebar');
    const [r1, r2, r3] = [await user(), await user(), await user()];
    const outsider = await user();
    const { conv } = await community(sender, [r1, r2, r3]);
    const msg = (await say(sender, conv, 'kata-kata kasar')).body.id as string;

    await report(outsider, 'message', msg).expect(404);
    await report(sender, 'message', msg).expect(400);
    const first = await report(r1, 'message', msg, 'harassment', 'Menghina anggota').expect(201);
    const again = await report(r1, 'message', msg).expect(201);
    expect(again.body.id).toBe(first.body.id);
    expect((await t.pool.query('SELECT details_enc FROM reports WHERE id = $1', [first.body.id])).rows[0].details_enc.toString('latin1')).not.toContain('Menghina');

    // Ditahan: pengirim tidak bisa menghapus pesan yang sedang dilaporkan.
    await request(t.http).delete(`/v1/chat/messages/${msg}`).set(sender.auth).expect(409);
    // Belum disembunyikan (1 pelapor).
    expect((await request(t.http).get(`/v1/chat/messages/${msg}`).set(r3.auth).expect(200)).body.text).toBe('kata-kata kasar');

    await report(r2, 'message', msg).expect(201);
    await report(r3, 'message', msg, 'hate').expect(201);
    const hidden = await request(t.http).get(`/v1/chat/messages/${msg}`).set(r1.auth).expect(200);
    expect(hidden.body).toMatchObject({ hidden: true });
    expect(hidden.body.text).toBeUndefined();
    // Pengirim masih melihat pesannya sendiri.
    expect((await request(t.http).get(`/v1/chat/messages/${msg}`).set(sender.auth).expect(200)).body.text).toBe('kata-kata kasar');
    // Pratinjau di daftar percakapan juga disembunyikan.
    const inbox = await request(t.http).get('/v1/chat/conversations').set(r1.auth).expect(200);
    expect(inbox.body[0].lastMessage).toMatchObject({ hidden: true, preview: null });
  });

  it('lapor komunitas dan pengguna: hanya yang bisa dilihat; komunitas tersembunyi dari direktori setelah 3 pelapor', async () => {
    const owner = await user('Pemilik');
    const member = await user('Anggota');
    const stranger = await user('Orang asing');
    const { id: c } = await community(owner, [member]);

    await report(owner, 'community', c).expect(400);
    await report(stranger, 'user', member.id).expect(404);
    await report(member, 'user', owner.id, 'scam').expect(201);
    await report(member, 'user', member.id).expect(400);

    for (const u of [stranger, await user(), await user()]) await report(u, 'community', c, 'spam').expect(201);
    const dir = await request(t.http).get('/v1/communities').set(stranger.auth).expect(200);
    expect(dir.body.items.map((x: { id: string }) => x.id)).not.toContain(c);
    // Anggota tetap bisa membuka komunitasnya.
    await request(t.http).get(`/v1/communities/${c}`).set(member.auth).expect(200);
  });

  it('login panel: wajib kata sandi + TOTP, token aplikasi tidak bisa membuka panel, kode tidak bisa dipakai ulang', async () => {
    const admin = await superAdmin();
    // Token biasa (login aplikasi) milik super admin: ditolak di /v1/admin.
    await request(t.http).get('/v1/admin/reports').set(admin.auth).expect(403);
    // Pengguna biasa dengan kata sandi + kode apa pun: pesan galat sama.
    const plain = await user();
    await request(t.http).post('/v1/admin/auth/login').set('X-Forwarded-For', freshIp()).send({ email: plain.email, password: PASSWORD, code: '123456' }).expect(401);

    const wrong = await request(t.http)
      .post('/v1/admin/auth/login')
      .set('X-Forwarded-For', freshIp())
      .send({ email: admin.email, password: 'salah-salah', code: admin.code() })
      .expect(401);
    expect(wrong.body.error).toBe('invalid_credentials');

    const code = admin.code();
    const ok = await request(t.http).post('/v1/admin/auth/login').set('X-Forwarded-For', freshIp()).send({ email: admin.email, password: PASSWORD, code }).expect(200);
    await request(t.http).get('/v1/admin/reports').set({ Authorization: `Bearer ${ok.body.accessToken}` }).expect(200);
    // Kode yang sama tidak bisa dipakai lagi.
    await request(t.http).post('/v1/admin/auth/login').set('X-Forwarded-For', freshIp()).send({ email: admin.email, password: PASSWORD, code }).expect(401);

    // Rotasi token mempertahankan tanda admin, dan sesi panel maks. 12 jam.
    const refreshed = await request(t.http).post('/v1/auth/refresh').send({ refreshToken: ok.body.refreshToken }).expect(200);
    await request(t.http).get('/v1/admin/reports').set({ Authorization: `Bearer ${refreshed.body.accessToken}` }).expect(200);
    const { rows } = await t.pool.query<{ hours: number }>(
      `SELECT extract(epoch FROM expires_at - now()) / 3600 AS hours FROM refresh_tokens WHERE admin_session AND revoked_at IS NULL`,
    );
    expect(Number(rows[0]!.hours)).toBeLessThanOrEqual(12);

    const log = await t.pool.query<{ action: string }>('SELECT action FROM admin_audit_log ORDER BY id');
    expect(log.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['admin.login_failed', 'admin.login']));
  });

  it('login panel: dikunci setelah 5 kali gagal (pesan sama), akun biasa tidak pernah terkunci', async () => {
    const admin = await superAdmin();
    const login = (email: string, code: string) =>
      request(t.http).post('/v1/admin/auth/login').set('X-Forwarded-For', freshIp()).send({ email, password: PASSWORD, code });
    for (let i = 0; i < 5; i++) await login(admin.email, '000000').expect(401);
    // Kode benar pun ditolak selama terkunci, dengan pesan yang sama seperti gagal biasa.
    const locked = await login(admin.email, admin.code()).expect(401);
    expect(locked.body.error).toBe('invalid_credentials');
    expect((await t.pool.query(`SELECT 1 FROM admin_audit_log WHERE action = 'admin.login_locked'`)).rowCount).toBe(1);

    // Pengguna biasa: tidak ada penghitung, jadi responsnya tidak bisa dipakai menebak email terdaftar.
    const plain = await user();
    for (let i = 0; i < 7; i++) await login(plain.email, '123456').expect(401);
    expect(await t.redis.exists(`admin:fail:${plain.id}`)).toBe(0);
  });

  it('antrean, detail (membuka chat tercatat di log), turunkan pesan, abaikan laporan komunitas', async () => {
    const admin = await superAdmin();
    const panel = await admin.login();
    const sender = await user('Penyebar');
    const member = await user('Pelapor');
    const { id: c, conv } = await community(sender, [member]);
    await say(sender, conv, 'sebelum');
    const img = await request(t.http)
      .post(`/v1/chat/conversations/${conv}/images`)
      .set(sender.auth)
      .field('clientMsgId', randomUUID())
      .attach('file', await sharp({ create: { width: 32, height: 32, channels: 3, background: '#f00' } }).png().toBuffer(), 'x.png')
      .expect(201);
    const bad = (await say(sender, conv, 'pesan bermasalah')).body.id as string;
    await say(sender, conv, 'sesudah');
    const unreported = (await say(sender, conv, 'tidak dilaporkan')).body.id as string;
    await report(member, 'message', bad, 'harassment', 'Kasar').expect(201);
    await report(member, 'message', img.body.id, 'sexual').expect(201);
    await report(member, 'community', c, 'spam').expect(201);

    const queue = await request(t.http).get('/v1/admin/reports').set(panel).expect(200);
    expect(queue.body).toHaveLength(3);
    // Daftar antrean tidak memuat isi pesan.
    expect(JSON.stringify(queue.body)).not.toContain('bermasalah');

    // Pesan yang tidak dilaporkan tidak bisa dibuka.
    await request(t.http).get(`/v1/admin/reports/message/${unreported}`).set(panel).expect(404);
    const detail = await request(t.http).get(`/v1/admin/reports/message/${bad}`).set(panel).expect(200);
    expect(detail.body.reports[0]).toMatchObject({ reason: 'harassment', details: 'Kasar', reporter: { displayName: 'Pelapor' } });
    const ctx = detail.body.target.messages as { text: string; isReported: boolean }[];
    expect(ctx.find((m) => m.isReported)!.text).toBe('pesan bermasalah');
    expect(ctx.map((m) => m.text)).toEqual(expect.arrayContaining(['sebelum', 'sesudah']));
    expect((await t.pool.query(`SELECT 1 FROM admin_audit_log WHERE action = 'report.view_message' AND target_id = $1`, [bad])).rowCount).toBe(1);

    await request(t.http).post(`/v1/admin/reports/message/${bad}/resolve`).set(panel).send({ action: 'remove', note: 'Melanggar aturan' }).expect(204);
    const removed = await request(t.http).get(`/v1/chat/messages/${bad}`).set(member.auth).expect(200);
    expect(removed.body).toMatchObject({ deleted: true, removedByAdmin: true });
    await request(t.http).post(`/v1/admin/reports/message/${bad}/resolve`).set(panel).send({ action: 'remove' }).expect(404);

    expect(t.storage.objects.size).toBe(1);
    await request(t.http).post(`/v1/admin/reports/message/${img.body.id}/resolve`).set(panel).send({ action: 'remove' }).expect(204);
    expect(t.storage.objects.size).toBe(0);

    await request(t.http).post(`/v1/admin/reports/community/${c}/resolve`).set(panel).send({ action: 'dismiss' }).expect(204);
    await request(t.http).post(`/v1/admin/reports/user/${sender.id}/resolve`).set(panel).send({ action: 'remove' }).expect(400);
    expect((await request(t.http).get('/v1/admin/reports').set(panel).expect(200)).body).toEqual([]);
    expect((await request(t.http).get('/v1/admin/reports?status=closed').set(panel).expect(200)).body).toHaveLength(3);
  });

  it('turunkan komunitas: tidak bisa diakses lagi, termasuk chat-nya', async () => {
    const admin = await superAdmin();
    const panel = await admin.login();
    const owner = await user();
    const member = await user();
    const { id: c, conv } = await community(owner, [member]);
    await report(member, 'community', c, 'scam').expect(201);
    await request(t.http).post(`/v1/admin/reports/community/${c}/resolve`).set(panel).send({ action: 'remove' }).expect(204);
    await request(t.http).get(`/v1/communities/${c}`).set(member.auth).expect(404);
    await request(t.http).get(`/v1/chat/conversations/${conv}/messages`).set(member.auth).expect(404);
    await request(t.http).post(`/v1/communities/${c}/join`).set((await user()).auth).expect(404);
  });

  it('tangguhkan akun: sesi dicabut, login ditolak, banding, banding diterima memulihkan akun', async () => {
    const admin = await superAdmin();
    const panel = await admin.login();
    const bad = await user('Pelanggar');

    await request(t.http).post(`/v1/admin/users/${bad.id}/suspend`).set(panel).send({ days: 7, reason: 'Spam berulang' }).expect(204);
    await request(t.http).get('/v1/me').set(bad.auth).expect(401);
    const login = await request(t.http).post('/v1/auth/login').set('X-Forwarded-For', freshIp()).send({ email: bad.email, password: PASSWORD }).expect(403);
    expect(login.body).toMatchObject({ error: 'account_suspended', appealable: true });
    expect(login.body.until).toBeTruthy();

    await request(t.http).post('/v1/auth/appeal').set('X-Forwarded-For', freshIp()).send({ email: bad.email, password: 'salah', message: 'Saya tidak melakukan spam' }).expect(401);
    await request(t.http).post('/v1/auth/appeal').set('X-Forwarded-For', freshIp()).send({ email: bad.email, password: PASSWORD, message: 'Saya tidak melakukan spam' }).expect(202);
    await request(t.http).post('/v1/auth/appeal').set('X-Forwarded-For', freshIp()).send({ email: bad.email, password: PASSWORD, message: 'Tolong ditinjau lagi' }).expect(409);

    const appeals = await request(t.http).get('/v1/admin/appeals').set(panel).expect(200);
    expect(appeals.body[0]).toMatchObject({ message: 'Saya tidak melakukan spam', user: { id: bad.id, status: 'suspended' } });
    await request(t.http).post(`/v1/admin/appeals/${appeals.body[0].id}/decide`).set(panel).send({ accept: true, note: 'Salah tangkap' }).expect(204);
    await request(t.http).post('/v1/auth/login').set('X-Forwarded-For', freshIp()).send({ email: bad.email, password: PASSWORD }).expect(200);

    const log = await request(t.http).get('/v1/admin/audit').set(panel).expect(200);
    expect(log.body.map((l: { action: string }) => l.action)).toEqual(expect.arrayContaining(['user.suspend', 'appeal.accept', 'user.reinstate']));
    // Log tidak bisa diubah.
    await expect(t.pool.query('UPDATE admin_audit_log SET action = $1', ['x'])).rejects.toThrow(/hanya boleh ditambah/);
  });

  it('penangguhan yang sudah lewat dipulihkan saat login; blokir; super admin tidak bisa ditindak', async () => {
    const admin = await superAdmin();
    const panel = await admin.login();
    const u = await user();
    await t.pool.query(`UPDATE users SET status = 'suspended', suspended_until = now() - interval '1 minute' WHERE id = $1`, [u.id]);
    await request(t.http).post('/v1/auth/login').set('X-Forwarded-For', freshIp()).send({ email: u.email, password: PASSWORD }).expect(200);

    await request(t.http).post(`/v1/admin/users/${u.id}/ban`).set(panel).send({ reason: 'Penipuan' }).expect(204);
    const banned = await request(t.http).post('/v1/auth/login').set('X-Forwarded-For', freshIp()).send({ email: u.email, password: PASSWORD }).expect(403);
    expect(banned.body.error).toBe('account_banned');

    const other = await superAdmin();
    await request(t.http).post(`/v1/admin/users/${other.id}/suspend`).set(panel).send({ days: 1, reason: 'uji coba' }).expect(403);
    await request(t.http).post(`/v1/admin/users/${admin.id}/suspend`).set(panel).send({ days: 1, reason: 'uji coba' }).expect(400);

    // Cari akun lewat email (body, bukan URL); email tidak dicatat di log.
    const found = await request(t.http).post('/v1/admin/users/lookup').set(panel).send({ email: u.email }).expect(200);
    expect(found.body).toMatchObject({ id: u.id, status: 'banned' });
    const logRows = await t.pool.query<{ metadata: unknown }>(`SELECT metadata FROM admin_audit_log WHERE action = 'user.lookup'`);
    expect(JSON.stringify(logRows.rows)).not.toContain(u.email);
  });
});
