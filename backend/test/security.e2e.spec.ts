import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password.js';
import { TokenService } from '../src/auth/token.service.js';
import { FieldCrypto } from '../src/crypto/field-crypto.js';
import { createTestApp, freshIp, hasTestInfra, resetData, type TestApp } from './helpers.js';

const PASSWORD = 'rahasia-sekali-123';

/** Regresi temuan uji penetrasi mandiri Fase 1 (docs/PENTEST-FASE1.md). */
describe.skipIf(!hasTestInfra)('Uji penetrasi Fase 1: regresi (e2e)', () => {
  let t: TestApp;
  let crypto: FieldCrypto;
  let phoneSeq = 95_000_000;
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
    const phone = `+62817${phoneSeq++}`;
    await t.pool.query(
      `INSERT INTO users (id, email_enc, email_bidx, email_verified_at, phone_enc, phone_bidx, phone_verified_at,
                          password_hash, display_name, privacy_accepted_at, privacy_version)
       VALUES ($1, $2, $3, now(), $4, $5, now(), $6, $7, now(), 'test')`,
      [id, crypto.encrypt(email, `users.email:${id}`), crypto.blindIndex('email', email), crypto.encrypt(phone, `users.phone:${id}`), crypto.blindIndex('phone', phone), passwordHash, name],
    );
    const tokens = await t.app.get(TokenService).issue(id, 'user');
    return { id, email, auth: { Authorization: `Bearer ${tokens.accessToken}` } };
  }

  async function community(owner: U, members: U[] = []) {
    const res = await request(t.http).post('/v1/communities').set(owner.auth).send({ name: 'Lari Pagi', city: 'Bandung', description: '', visibility: 'open' }).expect(201);
    const id = res.body.id as string;
    await t.pool.query(`UPDATE communities SET plan = 'pro_unlimited' WHERE id = $1`, [id]);
    for (const m of members) {
      await t.pool.query(`INSERT INTO community_members (community_id, user_id, status, joined_at) VALUES ($1, $2, 'active', now())`, [id, m.id]);
    }
    return id;
  }

  it('gambar chat yang disembunyikan karena laporan tidak bisa diunduh selain oleh pengirim', async () => {
    const sender = await user('Pengirim');
    const viewer = await user('Anggota');
    const c = await community(sender, [viewer]);
    const conv = (await request(t.http).get(`/v1/chat/communities/${c}`).set(sender.auth).expect(200)).body.id as string;
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#f00' } }).png().toBuffer();
    const msg = (
      await request(t.http).post(`/v1/chat/conversations/${conv}/images`).set(sender.auth).field('clientMsgId', randomUUID()).attach('file', png, 'a.png').expect(201)
    ).body.id as string;
    await request(t.http).get(`/v1/chat/messages/${msg}/image`).set(viewer.auth).expect(200);

    await t.pool.query('UPDATE chat_messages SET hidden_at = now() WHERE id = $1', [msg]);
    await request(t.http).get(`/v1/chat/messages/${msg}/image`).set(viewer.auth).expect(404);
    await request(t.http).get(`/v1/chat/messages/${msg}/image`).set(sender.auth).expect(200);
  });

  it('komunitas yang diturunkan tidak memberi akses apa pun ke anggotanya', async () => {
    const owner = await user('Pemilik');
    const member = await user('Anggota');
    const c = await community(owner, [member]);
    await request(t.http).get(`/v1/users/${member.id}`).set(owner.auth).expect(200);
    await t.pool.query('UPDATE communities SET removed_at = now() WHERE id = $1', [c]);

    // Satu-satunya komunitas bersama sudah diturunkan: profil, chat pribadi baru, dan daftar anggota tertutup.
    await request(t.http).get(`/v1/users/${member.id}`).set(owner.auth).expect(404);
    await request(t.http).post('/v1/chat/direct').set(owner.auth).send({ userId: member.id }).expect(403);
    await request(t.http).get(`/v1/communities/${c}/members`).set(member.auth).expect(404);
    await request(t.http).get(`/v1/communities/${c}/live`).set(member.auth).expect(403);
    // Aksi admin juga tidak berlaku lagi.
    await request(t.http).patch(`/v1/communities/${c}`).set(owner.auth).send({ name: 'Nama Baru' }).expect(404);
    await request(t.http).post(`/v1/communities/${c}/invites`).set(owner.auth).send({}).expect(404);
    expect((await t.pool.query('SELECT name FROM communities WHERE id = $1', [c])).rows[0].name).toBe('Lari Pagi');
    // Pemilik tetap bisa menghapusnya (KEPUTUSAN #99).
    await request(t.http).delete(`/v1/communities/${c}`).set(owner.auth).expect(204);
  });

  it('unggahan menolak multipart dengan banyak field', async () => {
    const u = await user();
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#0f0' } }).png().toBuffer();
    let req = request(t.http).post('/v1/me/avatar').set(u.auth);
    for (let i = 0; i < 10; i++) req = req.field(`f${i}`, 'x'.repeat(100));
    const res = await req.attach('file', png, 'a.png');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    // Field terlalu besar juga ditolak.
    const big = await request(t.http).post('/v1/me/avatar').set(u.auth).field('x', 'y'.repeat(5000)).attach('file', png, 'a.png');
    expect(big.status).toBeGreaterThanOrEqual(400);
    expect(big.status).toBeLessThan(500);
    await request(t.http).post('/v1/me/avatar').set(u.auth).attach('file', png, 'a.png').expect(200);
  });

  it('login aplikasi: dikunci per email setelah 10 kali gagal, termasuk email yang tidak terdaftar', async () => {
    const u = await user();
    const login = (email: string, password: string) =>
      request(t.http).post('/v1/auth/login').set('X-Forwarded-For', freshIp()).send({ email, password });
    for (let i = 0; i < 10; i++) await login(u.email, 'salah-salah-salah').expect(401);
    // Kata sandi benar pun ditolak sementara, dari IP mana pun.
    expect((await login(u.email, PASSWORD).expect(429)).body.error).toBe('too_many_attempts');

    // Email tidak terdaftar diperlakukan sama (tidak membocorkan keberadaan akun).
    const ghost = `${randomUUID()}@example.com`;
    for (let i = 0; i < 10; i++) await login(ghost, 'salah-salah-salah').expect(401);
    await login(ghost, 'salah-salah-salah').expect(429);

    // Login berhasil sebelum batas mengosongkan penghitung.
    const v = await user();
    for (let i = 0; i < 9; i++) await login(v.email, 'salah-salah-salah').expect(401);
    await login(v.email, PASSWORD).expect(200);
    for (let i = 0; i < 9; i++) await login(v.email, 'salah-salah-salah').expect(401);
    await login(v.email, PASSWORD).expect(200);
  });

  it('kontak darurat: maks. 5 penambahan per hari (mencegah berganti nomor untuk spam SOS)', async () => {
    const u = await user();
    for (let i = 0; i < 5; i++) {
      const added = await request(t.http).post('/v1/me/emergency-contacts').set(u.auth).send({ name: `K${i}`, phone: `08123400000${i}` }).expect(201);
      await request(t.http).delete(`/v1/me/emergency-contacts/${added.body.id}`).set(u.auth).expect(204);
    }
    const limited = await request(t.http).post('/v1/me/emergency-contacts').set(u.auth).send({ name: 'K6', phone: '081234000009' }).expect(429);
    expect(limited.body.error).toBe('contact_adds_limited');
  });
});
