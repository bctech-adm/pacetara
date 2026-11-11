import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password.js';
import { TokenService } from '../src/auth/token.service.js';
import { FieldCrypto } from '../src/crypto/field-crypto.js';
import { createTestApp, hasTestInfra, resetData, type TestApp } from './helpers.js';

const PASSWORD = 'rahasia-sekali-123';
const HERE = { lat: -6.917464, lng: 107.619125, accuracyM: 9 };

describe.skipIf(!hasTestInfra)('Modul 1.10 Mode aman (e2e)', () => {
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
    t.whatsapp.sos = [];
    t.whatsapp.up = true;
  });

  type U = { id: string; auth: { Authorization: string } };

  async function user(name = 'Ani'): Promise<U> {
    const id = randomUUID();
    const email = `${id}@example.com`;
    const phone = `+62816${phoneSeq++}`;
    await t.pool.query(
      `INSERT INTO users (id, email_enc, email_bidx, email_verified_at, phone_enc, phone_bidx, phone_verified_at,
                          password_hash, display_name, privacy_accepted_at, privacy_version)
       VALUES ($1, $2, $3, now(), $4, $5, now(), $6, $7, now(), 'test')`,
      [id, crypto.encrypt(email, `users.email:${id}`), crypto.blindIndex('email', email), crypto.encrypt(phone, `users.phone:${id}`), crypto.blindIndex('phone', phone), passwordHash, name],
    );
    const tokens = await t.app.get(TokenService).issue(id, 'user');
    return { id, auth: { Authorization: `Bearer ${tokens.accessToken}` } };
  }

  const add = (u: U, name: string, phone: string) => request(t.http).post('/v1/me/emergency-contacts').set(u.auth).send({ name, phone });

  it('kontak darurat: maks. 3, nomor dinormalisasi, terenkripsi, hanya milik sendiri', async () => {
    const ani = await user();
    const other = await user('Budi');
    const first = await add(ani, 'Ibu', '0812-3456-7890').expect(201);
    expect(first.body).toMatchObject({ name: 'Ibu', phone: '+6281234567890' });
    expect((await add(ani, 'Ibu lagi', '+6281234567890').expect(409)).body.error).toBe('contact_exists');
    await add(ani, 'Salah', '12345').expect(400);
    await add(ani, 'Ayah', '081111111111').expect(201);
    await add(ani, 'Kakak', '082222222222').expect(201);
    expect((await add(ani, 'Teman', '083333333333').expect(409)).body.error).toBe('contacts_full');

    const { rows } = await t.pool.query<{ name_enc: Buffer; phone_enc: Buffer }>('SELECT name_enc, phone_enc FROM emergency_contacts');
    for (const r of rows) {
      expect(r.name_enc.toString('latin1')).not.toMatch(/Ibu|Ayah|Kakak/);
      expect(r.phone_enc.toString('latin1')).not.toContain('62812');
    }

    expect((await request(t.http).get('/v1/me/emergency-contacts').set(other.auth).expect(200)).body).toEqual([]);
    // Orang lain tidak bisa menghapus kontak Ani.
    await request(t.http).delete(`/v1/me/emergency-contacts/${first.body.id}`).set(other.auth).expect(204);
    expect((await request(t.http).get('/v1/me/emergency-contacts').set(ani.auth).expect(200)).body).toHaveLength(3);
    await request(t.http).delete(`/v1/me/emergency-contacts/${first.body.id}`).set(ani.auth).expect(204);
    expect((await request(t.http).get('/v1/me/emergency-contacts').set(ani.auth).expect(200)).body).toHaveLength(2);
  });

  it('SOS: terkirim lewat WhatsApp ke semua kontak, lokasi tidak disimpan, dibatasi lajunya', async () => {
    const ani = await user('Ani');
    await request(t.http).post('/v1/sos').set(ani.auth).send({ lat: 200, lng: 0 }).expect(400);
    await request(t.http).post('/v1/sos').set(ani.auth).send(HERE).expect(409);
    await add(ani, 'Ibu', '081234567890').expect(201);
    await add(ani, 'Ayah', '081111111111').expect(201);

    const res = await request(t.http).post('/v1/sos').set(ani.auth).send(HERE).expect(200);
    expect(res.body.delivered).toBe(2);
    expect(res.body.results.map((r: { phone: string }) => r.phone).sort()).toEqual(['+6281111111111', '+6281234567890']);
    expect(t.whatsapp.sos).toHaveLength(2);
    expect(t.whatsapp.sos[0]).toMatchObject({ sos: { name: 'Ani', lat: HERE.lat, lng: HERE.lng, accuracyM: 9 } });

    // Lokasi tidak tersimpan di mana pun di database.
    const { rows } = await t.pool.query('SELECT * FROM sos_alerts');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ contacts: 2, delivered: 2 });
    expect(JSON.stringify(rows)).not.toContain('107.61');

    // WhatsApp mati: tetap 200 dengan delivered 0 (aplikasi menawarkan SMS).
    t.whatsapp.up = false;
    const down = await request(t.http).post('/v1/sos').set(ani.auth).send(HERE).expect(200);
    expect(down.body.delivered).toBe(0);
    await request(t.http).post('/v1/sos').set(ani.auth).send(HERE).expect(200);
    // Batas 3 per 10 menit: tetap mengembalikan kontak agar SMS bisa dikirim.
    const limited = await request(t.http).post('/v1/sos').set(ani.auth).send(HERE).expect(429);
    expect(limited.body.error).toBe('sos_rate_limited');
    expect(limited.body.contacts).toHaveLength(2);

  });

  it('hapus akun menghapus kontak darurat dan catatan SOS', async () => {
    const ani = await user('Ani');
    await add(ani, 'Ibu', '081234567890').expect(201);
    await request(t.http).post('/v1/sos').set(ani.auth).send(HERE).expect(200);
    await request(t.http).post('/v1/me/delete').set(ani.auth).send({ password: PASSWORD, confirm: 'HAPUS' }).expect(204);
    expect((await t.pool.query('SELECT 1 FROM emergency_contacts')).rowCount).toBe(0);
    expect((await t.pool.query('SELECT 1 FROM sos_alerts')).rowCount).toBe(0);
  });
});
