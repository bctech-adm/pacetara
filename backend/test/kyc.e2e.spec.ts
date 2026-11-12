import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TokenService } from '../src/auth/token.service.js';
import { FieldCrypto } from '../src/crypto/field-crypto.js';
import { ApiError } from '../src/common/http.js';
import { expireKycReviews } from '../src/kyc/kyc-expiry.js';
import { createTestApp, FakeKycEngine, freshIp, hasTestInfra, resetData, type TestApp } from './helpers.js';

const NIK = '3174011205900001';
const NIK2 = '3273015507950002';
let phoneSeq = 10_000_000;

describe.skipIf(!hasTestInfra)('Modul 3.1 Verifikasi Level 2 (e2e)', () => {
  let t: TestApp;
  let crypto: FieldCrypto;
  let photo: Buffer;

  beforeAll(async () => {
    t = await createTestApp({ COMMUNITY_OWNER_MIN_LEVEL: '2' });
    crypto = new FieldCrypto(t.env.DATA_ENCRYPTION_KEY, t.env.BLIND_INDEX_KEY);
    photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#a0b0c0' } }).jpeg().toBuffer();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await resetData(t);
    t.kyc.enabled = true;
    t.kyc.calls = 0;
    t.kyc.next = FakeKycEngine.good(NIK, 'BUDI SANTOSO');
  });

  type U = { id: string; auth: { Authorization: string } };

  async function user(name = 'Budi', level: 0 | 1 = 1): Promise<U> {
    const id = randomUUID();
    const email = `${id}@example.com`;
    const phone = `+62817${phoneSeq++}`;
    await t.pool.query(
      `INSERT INTO users (id, email_enc, email_bidx, email_verified_at, phone_enc, phone_bidx, phone_verified_at, password_hash, display_name,
                          privacy_accepted_at, privacy_version)
       VALUES ($1, $2, $3, now(), $4, $5, CASE WHEN $7::int = 1 THEN now() END, 'x', $6, now(), 'test')`,
      [id, crypto.encrypt(email, `users.email:${id}`), crypto.blindIndex('email', email), crypto.encrypt(phone, `users.phone:${id}`), crypto.blindIndex('phone', phone), name, level],
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

  const get = (u: U, p: string) => request(t.http).get(p).set('X-Forwarded-For', freshIp()).set(u.auth);
  const post = (u: U, p: string, body: object = {}) => request(t.http).post(p).set('X-Forwarded-For', freshIp()).set(u.auth).send(body);

  function submit(u: U, data: Record<string, unknown> = {}, files: { ktp?: Buffer; selfie?: Buffer } = { ktp: photo, selfie: photo }) {
    let r = request(t.http)
      .post('/v1/kyc')
      .set('X-Forwarded-For', freshIp())
      .set(u.auth)
      .field('data', JSON.stringify({ nik: NIK, name: 'Budi Santoso', consent: true, consentVersion: t.env.KYC_CONSENT_VERSION, ...data }));
    if (files.ktp) r = r.attach('ktp', files.ktp, 'ktp.jpg');
    if (files.selfie) r = r.attach('selfie', files.selfie, 'selfie.jpg');
    return r;
  }

  const userRow = async (id: string) =>
    (await t.pool.query<{ verification_level: number; nik_hmac: Buffer | null; kyc_verified_at: Date | null }>('SELECT verification_level, nik_hmac, kyc_verified_at FROM users WHERE id = $1', [id]))
      .rows[0]!;
  const attempts = async (id: string) =>
    (await t.pool.query<{ id: string; status: string; reasons: string[]; nik_hmac: Buffer | null; review_data_enc: Buffer | null }>(
      'SELECT id, status, reasons, nik_hmac, review_data_enc FROM kyc_attempts WHERE user_id = $1 ORDER BY created_at',
      [id],
    )).rows;

  it('lolos otomatis: Level 2, lencana Terverifikasi, NIK hanya sebagai HMAC', async () => {
    const u = await user();
    const s0 = await get(u, '/v1/kyc').expect(200);
    expect(s0.body).toMatchObject({ enabled: true, level: 1, verified: false, attemptsLeft: 5, last: null, consentVersion: t.env.KYC_CONSENT_VERSION });

    const res = await submit(u).expect(200);
    expect(res.body).toEqual({ status: 'approved', reasons: [], messages: [] });
    expect(t.kyc.calls).toBe(1);
    expect(t.kyc.sizes).toContain(photo.length);

    const row = await userRow(u.id);
    expect(row.verification_level).toBe(2);
    expect(row.kyc_verified_at).not.toBeNull();
    expect(row.nik_hmac!.equals(crypto.blindIndex('nik', NIK))).toBe(true);
    const a = await attempts(u.id);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ status: 'approved', nik_hmac: null, review_data_enc: null });

    const me = await get(u, '/v1/me').expect(200);
    expect(me.body.badges).toContain('verified');
    expect((await get(u, '/v1/kyc').expect(200)).body).toMatchObject({ verified: true, level: 2, last: { status: 'approved', auto: true } });

    const again = await submit(u).expect(409);
    expect(again.body.error).toBe('already_verified');
    expect(t.kyc.calls).toBe(1);
  });

  it('prasyarat dicek sebelum mesin dijalankan', async () => {
    const lvl0 = await user('Nol', 0);
    expect((await submit(lvl0).expect(403)).body.error).toBe('verification_required');

    // Pengguna baru per permintaan: batas laju unggah 3/menit per pengguna.
    const u = await user();
    expect((await submit(await user(), { consent: false }).expect(400)).body.error).toBe('invalid_input');
    expect((await submit(await user(), { consentVersion: '2020-01-01' }).expect(428)).body.error).toBe('consent_outdated');
    expect((await submit(await user(), { nik: '3174011213900001' }).expect(400)).body.error).toBe('invalid_nik');
    expect((await submit(await user(), { nik: '3174011211150001' }).expect(403)).body.error).toBe('underage');
    expect((await submit(await user(), {}, { ktp: photo }).expect(400)).body.error).toBe('file_required');
    expect((await submit(await user(), {}, { ktp: Buffer.from('bukan gambar sama sekali'), selfie: photo }).expect(415)).body.error).toBe('unsupported_image');
    const tiny = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#000' } }).png().toBuffer();
    expect((await submit(u, {}, { ktp: tiny, selfie: photo }).expect(422)).body.error).toBe('image_too_small');
    expect(t.kyc.calls).toBe(0);
    expect(await attempts(u.id)).toHaveLength(0);

    t.kyc.enabled = false;
    // Mesin mati: tetap 503 (FakeKycEngine.enabled dibaca service lewat engine.enabled).
    expect((await submit(u).expect(503)).body.error).toBe('not_configured');
  });

  it('kualitas foto buruk = ulangi, tidak masuk antrean; batas 5 percobaan per hari', async () => {
    const u = await user();
    t.kyc.next = { ...FakeKycEngine.good(NIK, 'BUDI SANTOSO'), selfieFaces: 0, faceSimilarity: null };
    const res = await submit(u).expect(200);
    expect(res.body.status).toBe('retry');
    expect(res.body.reasons).toEqual(['selfie_no_face']);
    expect(res.body.messages[0]).toMatch(/Wajah tidak terlihat/);
    expect((await userRow(u.id)).verification_level).toBe(1);
    expect((await attempts(u.id))[0]).toMatchObject({ status: 'retry', nik_hmac: null, review_data_enc: null });

    t.kyc.next = FakeKycEngine.good('3174011205909999', 'BUDI SANTOSO');
    expect((await submit(u).expect(200)).body.reasons).toEqual(['nik_mismatch']);
    // Tiga percobaan lain hari ini (langsung di database: batas laju HTTP 3/menit per pengguna).
    for (let i = 0; i < 3; i++) await t.pool.query(`INSERT INTO kyc_attempts (user_id, status, reasons, consent_version) VALUES ($1, 'retry', '{ktp_unreadable}', 'x')`, [u.id]);
    await new Promise((r) => setTimeout(r, 0));
    expect((await get(u, '/v1/kyc')).body.attemptsLeft).toBe(0);
    const limited = await submit(u).expect(429);
    expect(limited.body.error).toBe('kyc_limit');
  });

  it('analisis gagal di mesin tetap dihitung ke kuota; antrean penuh tidak', async () => {
    const u = await user();
    t.kyc.fail = new ApiError(503, 'kyc_busy', 'Sedang banyak verifikasi');
    expect((await submit(u).expect(503)).body.error).toBe('kyc_busy');
    expect(await attempts(u.id)).toHaveLength(0);
    t.kyc.fail = new ApiError(503, 'kyc_engine_error', 'Verifikasi gagal diproses');
    expect((await submit(u).expect(503)).body.error).toBe('kyc_engine_error');
    expect((await attempts(u.id)).map((a: { status: string; reasons: string[] }) => [a.status, a.reasons])).toEqual([['retry', ['engine_error']]]);
    expect((await get(u, '/v1/kyc')).body.attemptsLeft).toBe(4);
  });

  it('ragu = antrean tinjauan; admin melihat nama (tercatat) lalu menyetujui', async () => {
    const u = await user();
    const adm = await admin();
    t.kyc.next = { ...FakeKycEngine.good(NIK, 'BUDI SANTOSO'), faceSimilarity: 0.52 };
    const res = await submit(u, { name: 'Budi Santosa Wijaya' }).expect(200);
    expect(res.body.status).toBe('review');
    expect(res.body.reasons).toEqual(expect.arrayContaining(['name_mismatch', 'face_uncertain']));
    expect((await submit(u).expect(409)).body.error).toBe('kyc_in_review');

    const [a] = await attempts(u.id);
    expect(a!.status).toBe('review');
    expect(a!.nik_hmac!.equals(crypto.blindIndex('nik', NIK))).toBe(true);
    // Nama tersimpan terenkripsi, bukan teks biasa.
    expect(a!.review_data_enc!.toString('utf8')).not.toContain('BUDI');

    // Token aplikasi (bukan login panel) tidak bisa membuka antrean.
    await get(u, '/v1/admin/kyc').expect(403);
    const list = await get(adm, '/v1/admin/kyc').expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('BUDI');
    expect(list.body.items[0]).toMatchObject({ userId: u.id, user: 'Budi', status: 'review', scores: { face: 0.52 } });

    const detail = await get(adm, `/v1/admin/kyc/${a!.id}`).expect(200);
    expect(detail.body.names).toEqual({ ocrName: 'BUDI SANTOSO', enteredName: 'Budi Santosa Wijaya' });
    const logged = await t.pool.query(`SELECT 1 FROM admin_audit_log WHERE action = 'kyc.view' AND target_id = $1`, [a!.id]);
    expect(logged.rowCount).toBe(1);

    await post(adm, `/v1/admin/kyc/${a!.id}/approve`, { note: 'Nama tengah tidak dicantumkan di KTP' }).expect(200);
    const row = await userRow(u.id);
    expect(row.verification_level).toBe(2);
    expect(row.nik_hmac!.equals(crypto.blindIndex('nik', NIK))).toBe(true);
    expect((await attempts(u.id))[0]).toMatchObject({ status: 'approved', nik_hmac: null, review_data_enc: null });
    expect((await post(adm, `/v1/admin/kyc/${a!.id}/approve`).expect(409)).body.error).toBe('kyc_reviewed');
    const audit = await t.pool.query(`SELECT metadata FROM admin_audit_log WHERE action = 'kyc.approve' AND target_id = $1`, [u.id]);
    expect(audit.rows[0].metadata).toMatchObject({ attemptId: a!.id });
    const inbox = await t.pool.query(`SELECT type FROM notifications WHERE user_id = $1`, [u.id]);
    expect(inbox.rows.map((r) => r.type)).toContain('kyc_approved');
    expect(t.push.to(u.id).some((j) => j.data?.type === 'kyc_approved')).toBe(true);
  });

  it('ditolak admin: data tinjauan dihapus, pengguna bisa mencoba lagi dan melihat alasannya', async () => {
    const u = await user();
    const adm = await admin();
    t.kyc.next = { ...FakeKycEngine.good(NIK, 'BUDI SANTOSO'), faceSimilarity: 0.2 };
    expect((await submit(u).expect(200)).body.reasons).toContain('face_mismatch');
    const [a] = await attempts(u.id);
    await post(adm, `/v1/admin/kyc/${a!.id}/reject`, { reason: 'Foto KTP buram, ulangi di tempat terang' }).expect(204);
    expect((await attempts(u.id))[0]).toMatchObject({ status: 'rejected', nik_hmac: null, review_data_enc: null });
    const s = await get(u, '/v1/kyc').expect(200);
    expect(s.body.last).toMatchObject({ status: 'rejected', auto: false, note: 'Foto KTP buram, ulangi di tempat terang' });
    t.kyc.next = FakeKycEngine.good(NIK, 'BUDI SANTOSO');
    expect((await submit(u).expect(200)).body.status).toBe('approved');
  });

  it('satu NIK satu akun; NIK bisa dipakai lagi setelah akun dihapus', async () => {
    const a = await user('A');
    const b = await user('B');
    await submit(a).expect(200);
    const res = await submit(b).expect(409);
    expect(res.body.error).toBe('nik_in_use');
    expect((await attempts(b.id))[0]).toMatchObject({ status: 'retry', reasons: ['nik_in_use'] });
    expect((await userRow(b.id)).verification_level).toBe(1);

    await t.pool.query('UPDATE users SET password_hash = NULL, google_sub = $2 WHERE id = $1', [a.id, `g-${a.id}`]);
    await post(a, '/v1/me/delete', { confirm: 'HAPUS' }).expect(204);
    const gone = await t.pool.query('SELECT nik_hmac, kyc_verified_at, verification_level FROM users WHERE id = $1', [a.id]);
    expect(gone.rows[0]).toEqual({ nik_hmac: null, kyc_verified_at: null, verification_level: 0 });
    expect(await attempts(a.id)).toHaveLength(0);

    expect((await submit(b).expect(200)).body.status).toBe('approved');
  });

  it('admin mencabut Level 2', async () => {
    const u = await user();
    const adm = await admin();
    await submit(u).expect(200);
    await post(adm, `/v1/admin/kyc/users/${u.id}/revoke`, { reason: 'Terbukti memakai KTP orang lain' }).expect(204);
    const row = await userRow(u.id);
    expect(row).toMatchObject({ verification_level: 1, nik_hmac: null, kyc_verified_at: null });
    expect((await get(u, '/v1/me')).body.badges).not.toContain('verified');
    expect((await attempts(u.id))[0]!.status).toBe('revoked');
    expect((await post(adm, `/v1/admin/kyc/users/${u.id}/revoke`, { reason: 'lagi' }).expect(409)).body.error).toBe('not_verified');
  });

  it('membuat komunitas baru wajib Level 2; komunitas lama tetap bisa dikelola', async () => {
    const u = await user();
    const body = { name: 'Lari Pagi', city: 'Bandung', description: '', visibility: 'open' };
    const denied = await post(u, '/v1/communities', body).expect(403);
    expect(denied.body).toMatchObject({ error: 'verification_required', requiredLevel: 2 });
    // Komunitas yang sudah ada (dibuat sebelum aturan ini) tetap bisa diubah pemilik Level 1.
    const { rows } = await t.pool.query<{ id: string }>(
      `INSERT INTO communities (name, city, description, visibility, owner_id, member_count) VALUES ('Lama', 'Bandung', '', 'open', $1, 1) RETURNING id`,
      [u.id],
    );
    await t.pool.query(`INSERT INTO community_members (community_id, user_id, role, status, joined_at) VALUES ($1, $2, 'owner', 'active', now())`, [rows[0]!.id, u.id]);
    await request(t.http).patch(`/v1/communities/${rows[0]!.id}`).set(u.auth).send({ description: 'Masih bisa diubah' }).expect(200);

    await submit(u).expect(200);
    await t.pool.query('DELETE FROM communities WHERE id = $1', [rows[0]!.id]);
    await post(u, '/v1/communities', body).expect(201);
  });

  it('tinjauan > 30 hari kedaluwarsa dan datanya dihapus', async () => {
    const u = await user();
    t.kyc.next = { ...FakeKycEngine.good(NIK2, 'BUDI SANTOSO'), faceSimilarity: 0.5 };
    await submit(u, { nik: NIK2 }).expect(200);
    await t.pool.query(`UPDATE kyc_attempts SET created_at = now() - interval '31 days' WHERE user_id = $1`, [u.id]);
    expect(await expireKycReviews(t.pool)).toBe(1);
    expect((await attempts(u.id))[0]).toMatchObject({ status: 'expired', nik_hmac: null, review_data_enc: null });
  });

  it('constraint: data tinjauan hanya boleh ada saat status review', async () => {
    const u = await user();
    await expect(
      t.pool.query(`INSERT INTO kyc_attempts (user_id, status, consent_version, nik_hmac) VALUES ($1, 'approved', 'x', '\\x00')`, [u.id]),
    ).rejects.toThrow(/kyc_review_data_only_pending/);
  });
});
