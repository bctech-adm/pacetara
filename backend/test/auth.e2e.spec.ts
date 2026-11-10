import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, freshIp, hasTestInfra, resetData, type TestApp } from './helpers.js';

const PASSWORD = 'rahasia-kuat-123';

describe.skipIf(!hasTestInfra)('Modul 1.2 Akun dan login (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await resetData(t);
    t.mailer.sent = [];
    t.whatsapp.sent = [];
    t.whatsapp.up = true;
    t.storage.objects.clear();
  });

  const api = () => {
    const ip = freshIp();
    const wrap = (r: request.Test) => r.set('X-Forwarded-For', ip);
    return {
      get: (p: string) => wrap(request(t.http).get(p)),
      post: (p: string) => wrap(request(t.http).post(p)),
      patch: (p: string) => wrap(request(t.http).patch(p)),
      del: (p: string) => wrap(request(t.http).delete(p)),
    };
  };

  async function register(email = 'budi@example.com', extra: Record<string, unknown> = {}) {
    const res = await api()
      .post('/v1/auth/register')
      .send({ email, password: PASSWORD, displayName: 'Budi', acceptPrivacy: true, privacyVersion: t.env.PRIVACY_POLICY_VERSION, ...extra });
    return res;
  }

  /** Daftar, verifikasi email, verifikasi HP lewat WhatsApp → Level 1. */
  async function level1User(email = 'budi@example.com', phone = '081234567890') {
    const reg = await register(email);
    const auth = { Authorization: `Bearer ${reg.body.accessToken}` };
    await api().post('/v1/auth/email/verify').set(auth).send({ code: t.mailer.lastCode(email, 'email_verify') }).expect(200);
    await api().post('/v1/auth/phone/send-code').set(auth).send({ phone }).expect(200);
    const res = await api().post('/v1/auth/phone/verify').set(auth).send({ code: t.whatsapp.sent.at(-1)!.code }).expect(200);
    return { reg, auth, profile: res.body };
  }

  // ---------- Selesai jika: pengguna baru bisa daftar sampai Level 1 ----------

  it('daftar → verifikasi email → verifikasi HP (WhatsApp) = Level 1', async () => {
    const reg = await register();
    expect(reg.status).toBe(201);
    expect(reg.body.user).toMatchObject({ email: 'budi@example.com', emailVerified: false, verificationLevel: 0 });
    expect(reg.body.accessToken).toBeTruthy();
    expect(reg.body.refreshToken).toBeTruthy();

    const { profile } = await level1User('ani@example.com', '0812-1111-2222');
    expect(profile).toMatchObject({ emailVerified: true, phoneVerified: true, phone: '+6281211112222', verificationLevel: 1 });
  });

  it('OTP nomor HP beralih otomatis ke email jika WhatsApp gagal', async () => {
    const reg = await register();
    const auth = { Authorization: `Bearer ${reg.body.accessToken}` };
    await api().post('/v1/auth/email/verify').set(auth).send({ code: t.mailer.lastCode('budi@example.com') });

    t.whatsapp.up = false;
    const send = await api().post('/v1/auth/phone/send-code').set(auth).send({ phone: '081234567890' }).expect(200);
    expect(send.body.channel).toBe('email');
    const code = t.mailer.lastCode('budi@example.com', 'phone_verify');
    const res = await api().post('/v1/auth/phone/verify').set(auth).send({ code }).expect(200);
    expect(res.body.verificationLevel).toBe(1);
  });

  it('cadangan email ditolak jika email belum terverifikasi (tidak mengirim kode ke email sembarang)', async () => {
    const reg = await register();
    t.whatsapp.up = false;
    const res = await api()
      .post('/v1/auth/phone/send-code')
      .set({ Authorization: `Bearer ${reg.body.accessToken}` })
      .send({ phone: '081234567890' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('otp_unavailable');
  });

  it('wajib menyetujui kebijakan privasi versi terbaru', async () => {
    expect((await register('a@example.com', { acceptPrivacy: false })).status).toBe(400);
    const outdated = await register('b@example.com', { privacyVersion: '2000-01-01' });
    expect(outdated.status).toBe(428);
    expect(outdated.body.error).toBe('privacy_outdated');
  });

  it('email ganda ditolak, tidak peka huruf besar', async () => {
    await register('budi@example.com');
    const dup = await register('BUDI@Example.com');
    expect(dup.status).toBe(409);
  });

  it('nomor HP yang sama tidak bisa dipakai dua akun', async () => {
    await level1User('a@example.com', '081234567890');
    const reg = await register('b@example.com');
    const res = await api()
      .post('/v1/auth/phone/send-code')
      .set({ Authorization: `Bearer ${reg.body.accessToken}` })
      .send({ phone: '+62 812 3456 7890' });
    expect(res.status).toBe(409);
  });

  // ---------- Kode verifikasi ----------

  it('kode salah dihitung; setelah 5 kali kode tidak berlaku', async () => {
    const reg = await register();
    const auth = { Authorization: `Bearer ${reg.body.accessToken}` };
    const real = t.mailer.lastCode('budi@example.com');
    const wrong = real === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const r = await api().post('/v1/auth/email/verify').set(auth).send({ code: wrong });
      expect(r.body.error).toBe('code_invalid');
    }
    const r = await api().post('/v1/auth/email/verify').set(auth).send({ code: real });
    expect(r.body.error).toBe('code_expired');
  });

  it('kirim ulang kode dibatasi jeda 60 detik', async () => {
    const reg = await register(); // register sudah mengirim satu kode
    const r = await api().post('/v1/auth/email/send-code').set({ Authorization: `Bearer ${reg.body.accessToken}` });
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('code_cooldown');
  });

  it('kode tidak disimpan mentah di database', async () => {
    await register();
    const code = t.mailer.lastCode('budi@example.com');
    const { rows } = await t.pool.query<{ code_hmac: Buffer; target_enc: Buffer }>('SELECT code_hmac, target_enc FROM verification_codes');
    expect(rows[0]!.code_hmac.includes(Buffer.from(code))).toBe(false);
    expect(rows[0]!.target_enc.includes(Buffer.from('budi@'))).toBe(false);
  });

  // ---------- Masuk, token, logout ----------

  it('login: pesan sama untuk email tak terdaftar dan kata sandi salah', async () => {
    await register();
    const a = await api().post('/v1/auth/login').send({ email: 'budi@example.com', password: 'salah-salah' });
    const b = await api().post('/v1/auth/login').send({ email: 'tidakada@example.com', password: 'salah-salah' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
    const ok = await api().post('/v1/auth/login').send({ email: 'Budi@example.com', password: PASSWORD });
    expect(ok.status).toBe(200);
  });

  it('kata sandi disimpan sebagai Argon2id; email & HP terenkripsi di database', async () => {
    await level1User();
    const { rows } = await t.pool.query<{ password_hash: string; email_enc: Buffer; phone_enc: Buffer }>(
      'SELECT password_hash, email_enc, phone_enc FROM users',
    );
    expect(rows[0]!.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(rows[0]!.email_enc.includes(Buffer.from('budi'))).toBe(false);
    expect(rows[0]!.phone_enc.includes(Buffer.from('81234567890'))).toBe(false);
  });

  it('token penyegar dirotasi; memakai token lama mencabut seluruh sesi', async () => {
    const reg = await register();
    const r1 = await api().post('/v1/auth/refresh').send({ refreshToken: reg.body.refreshToken }).expect(200);
    expect(r1.body.refreshToken).not.toBe(reg.body.refreshToken);

    // Token lama dipakai lagi (mis. dicuri) → ditolak dan family dicabut.
    const reuse = await api().post('/v1/auth/refresh').send({ refreshToken: reg.body.refreshToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error).toBe('token_reused');
    // Token terbaru milik pengguna sah juga ikut tidak berlaku.
    expect((await api().post('/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken })).status).toBe(401);
    // Token akses dari family itu langsung ditolak.
    expect((await api().get('/v1/me').set({ Authorization: `Bearer ${r1.body.accessToken}` })).status).toBe(401);
  });

  it('logout mencabut token akses dan token penyegar', async () => {
    const reg = await register();
    const auth = { Authorization: `Bearer ${reg.body.accessToken}` };
    await api().get('/v1/me').set(auth).expect(200);
    await api().post('/v1/auth/logout').set(auth).send({ refreshToken: reg.body.refreshToken }).expect(204);
    expect((await api().get('/v1/me').set(auth)).status).toBe(401);
    expect((await api().post('/v1/auth/refresh').send({ refreshToken: reg.body.refreshToken })).status).toBe(401);
  });

  it('logout semua perangkat', async () => {
    await register();
    const a = await api().post('/v1/auth/login').send({ email: 'budi@example.com', password: PASSWORD });
    const b = await api().post('/v1/auth/login').send({ email: 'budi@example.com', password: PASSWORD });
    await api().post('/v1/auth/logout-all').set({ Authorization: `Bearer ${a.body.accessToken}` }).expect(204);
    expect((await api().get('/v1/me').set({ Authorization: `Bearer ${b.body.accessToken}` })).status).toBe(401);
  });

  it('endpoint terlindungi menolak tanpa token atau token palsu', async () => {
    expect((await api().get('/v1/me')).status).toBe(401);
    expect((await api().get('/v1/me').set({ Authorization: 'Bearer abc.def.ghi' })).status).toBe(401);
  });

  it('lupa kata sandi: respons sama untuk email tak terdaftar; reset mencabut semua sesi', async () => {
    const reg = await register();
    await api().post('/v1/auth/password/forgot').send({ email: 'tidakada@example.com' }).expect(204);
    await api().post('/v1/auth/password/forgot').send({ email: 'budi@example.com' }).expect(204);
    const code = t.mailer.lastCode('budi@example.com', 'password_reset');
    await api().post('/v1/auth/password/reset').send({ email: 'budi@example.com', code, newPassword: 'kata-sandi-baru-1' }).expect(204);
    expect((await api().get('/v1/me').set({ Authorization: `Bearer ${reg.body.accessToken}` })).status).toBe(401);
    await api().post('/v1/auth/login').send({ email: 'budi@example.com', password: 'kata-sandi-baru-1' }).expect(200);
  });

  // ---------- Google ----------

  it('Google: akun baru wajib persetujuan privasi, lalu login berikutnya langsung masuk', async () => {
    t.google.identities.set('tok-1', { sub: 'g-1', email: 'citra@gmail.com', emailVerified: true, name: 'Citra' });
    const noConsent = await api().post('/v1/auth/google').send({ idToken: 'tok-1'.padEnd(30, 'x') });
    expect(noConsent.status).toBe(401); // token padded tidak dikenal fake → pastikan token persis
    const first = await api().post('/v1/auth/google').send({ idToken: 'tok-1' });
    expect(first.status).toBe(400); // idToken terlalu pendek (min 20)

    t.google.identities.set('google-id-token-panjang-1', { sub: 'g-1', email: 'citra@gmail.com', emailVerified: true, name: 'Citra' });
    const need = await api().post('/v1/auth/google').send({ idToken: 'google-id-token-panjang-1' });
    expect(need.status).toBe(428);
    expect(need.body.error).toBe('privacy_required');

    const created = await api()
      .post('/v1/auth/google')
      .send({ idToken: 'google-id-token-panjang-1', acceptPrivacy: true, privacyVersion: t.env.PRIVACY_POLICY_VERSION })
      .expect(200);
    expect(created.body.created).toBe(true);
    expect(created.body.user).toMatchObject({ email: 'citra@gmail.com', emailVerified: true, googleLinked: true, hasPassword: false });

    const again = await api().post('/v1/auth/google').send({ idToken: 'google-id-token-panjang-1' }).expect(200);
    expect(again.body.created).toBe(false);
  });

  it('Google tidak menautkan ke akun email yang ada jika email Google belum terverifikasi', async () => {
    await register('dedi@example.com');
    t.google.identities.set('google-id-token-palsu-xx', { sub: 'g-evil', email: 'dedi@example.com', emailVerified: false });
    const res = await api().post('/v1/auth/google').send({ idToken: 'google-id-token-palsu-xx' });
    expect(res.status).toBe(409);
  });

  // ---------- Profil ----------

  it('ubah profil: nama, kota, pace', async () => {
    const reg = await register();
    const res = await api()
      .patch('/v1/me')
      .set({ Authorization: `Bearer ${reg.body.accessToken}` })
      .send({ displayName: 'Budi Lari', city: 'Bandung', avgPaceSecPerKm: 360 })
      .expect(200);
    expect(res.body).toMatchObject({ displayName: 'Budi Lari', city: 'Bandung', avgPaceSecPerKm: 360 });
    const bad = await api().patch('/v1/me').set({ Authorization: `Bearer ${reg.body.accessToken}` }).send({ role: 'super_admin' });
    expect(bad.status).toBe(400);
  });

  it('foto profil: metadata lokasi dibuang dan berkas bukan gambar ditolak', async () => {
    const reg = await register();
    const auth = { Authorization: `Bearer ${reg.body.accessToken}` };
    const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#f05a0e' } })
      .jpeg()
      .withExif({ IFD0: { Make: 'TestPhone', ImageDescription: 'rumah-saya' } })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeTruthy();

    const up = await api().post('/v1/me/avatar').set(auth).attach('file', jpeg, 'foto.jpg').expect(200);
    expect(up.body.avatarUrl).toMatch(/^\/v1\/users\/.+\/avatar\?v=\d+$/);
    const stored = [...t.storage.objects.values()][0]!;
    const meta = await sharp(stored.body).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.exif).toBeUndefined();
    expect(meta.width).toBeLessThanOrEqual(512);

    const file = await api().get(up.body.avatarUrl).set(auth).expect(200);
    expect(file.headers['content-type']).toBe('image/webp');
    expect((await api().get(up.body.avatarUrl)).status).toBe(401); // tanpa login

    const fake = await api().post('/v1/me/avatar').set(auth).attach('file', Buffer.from('<?php echo 1; ?>'), 'x.jpg');
    expect(fake.status).toBe(415);
  });

  // ---------- Selesai jika: hapus akun benar-benar menghapus data pribadi ----------

  it('hapus akun menghapus semua data pribadi dan mencabut sesi', async () => {
    const { reg, auth } = await level1User();
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000' } }).png().toBuffer();
    await api().post('/v1/me/avatar').set(auth).attach('file', png, 'a.png').expect(200);
    expect(t.storage.objects.size).toBe(1);

    expect((await api().post('/v1/me/delete').set(auth).send({ confirm: 'HAPUS', password: 'salah-salah' })).status).toBe(401);
    await api().post('/v1/me/delete').set(auth).send({ confirm: 'HAPUS', password: PASSWORD }).expect(204);

    const { rows } = await t.pool.query('SELECT * FROM users WHERE id = $1', [reg.body.user.id]);
    const u = rows[0];
    expect(u.status).toBe('deleted');
    expect(u.display_name).toBe('Pengguna dihapus');
    for (const col of ['email_enc', 'email_bidx', 'phone_enc', 'phone_bidx', 'password_hash', 'google_sub', 'avatar_key', 'city', 'privacy_accepted_at']) {
      expect(u[col], col).toBeNull();
    }
    expect((await t.pool.query('SELECT 1 FROM refresh_tokens WHERE user_id = $1', [u.id])).rowCount).toBe(0);
    expect((await t.pool.query('SELECT 1 FROM verification_codes WHERE user_id = $1', [u.id])).rowCount).toBe(0);
    expect(t.storage.objects.size).toBe(0);

    expect((await api().get('/v1/me').set(auth)).status).toBe(401);
    expect((await api().post('/v1/auth/login').send({ email: 'budi@example.com', password: PASSWORD })).status).toBe(401);
    // Email dan nomor HP bisa dipakai lagi untuk akun baru.
    expect((await register('budi@example.com')).status).toBe(201);
  });

  // ---------- Batas laju ----------

  it('login dibatasi 10 percobaan per menit per IP', async () => {
    const ip = freshIp();
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await request(t.http).post('/v1/auth/login').set('X-Forwarded-For', ip).send({ email: 'x@example.com', password: 'salahsalah' })).status;
    }
    expect(last).toBe(429);
  });
});
