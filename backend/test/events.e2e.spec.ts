import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password.js';
import { TokenService } from '../src/auth/token.service.js';
import { FieldCrypto } from '../src/crypto/field-crypto.js';
import { archivePastEvents, todayWib } from '../src/events/event-archive.js';
import { createTestApp, hasTestInfra, resetData, type TestApp } from './helpers.js';

const PASSWORD = 'rahasia-sekali-123';
const DAY = 86_400_000;
/** Tanggal WIB n hari dari hari ini (YYYY-MM-DD). */
const day = (n: number) => todayWib(Date.now() + n * DAY);

describe.skipIf(!hasTestInfra)('Modul 1.7 Kalender event (e2e)', () => {
  let t: TestApp;
  let crypto: FieldCrypto;
  let phoneSeq = 70_000_000;
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
    const phone = `+62814${phoneSeq++}`;
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

  /** Token panel (setara login kata sandi + TOTP; alurnya diuji di moderation.e2e). */
  async function admin(): Promise<U> {
    const u = await user('Admin');
    await t.pool.query(`UPDATE users SET role = 'super_admin' WHERE id = $1`, [u.id]);
    const tokens = await t.app.get(TokenService).issue(u.id, 'super_admin', undefined, { admin: true });
    return { id: u.id, auth: { Authorization: `Bearer ${tokens.accessToken}` } };
  }

  async function community(owner: U, members: U[] = [], name = 'Lari Pagi') {
    const res = await request(t.http).post('/v1/communities').set(owner.auth).send({ name, city: 'Bandung', description: '', visibility: 'open' }).expect(201);
    const id = res.body.id as string;
    await t.pool.query(`UPDATE communities SET plan = 'pro_unlimited' WHERE id = $1`, [id]);
    for (const m of members) {
      await t.pool.query(`INSERT INTO community_members (community_id, user_id, status, joined_at) VALUES ($1, $2, 'active', now())`, [id, m.id]);
    }
    return id;
  }

  const base = (over: Record<string, unknown> = {}) => ({
    name: `Bandung Marathon ${randomUUID().slice(0, 6)}`,
    date: day(30),
    startTime: '05:00',
    city: 'Bandung',
    venue: 'Gedung Sate',
    description: 'Lomba lari tahunan',
    categories: ['10k', 'hm', 'fm'],
    registrationUrl: 'https://contoh-lari.id/daftar',
    ...over,
  });

  async function event(a: U, over: Record<string, unknown> = {}) {
    return (await request(t.http).post('/v1/admin/events').set(a.auth).send(base(over)).expect(201)).body.id as string;
  }

  it('super admin memasukkan event: validasi, duplikat, hanya token panel, tercatat di log', async () => {
    const a = await admin();
    const plain = await user();

    await request(t.http).post('/v1/admin/events').set(plain.auth).send(base()).expect(403);
    // Token aplikasi milik super admin (bukan login panel) juga ditolak.
    const appToken = await t.app.get(TokenService).issue(a.id, 'super_admin');
    await request(t.http).post('/v1/admin/events').set({ Authorization: `Bearer ${appToken.accessToken}` }).send(base()).expect(403);

    const bad = await request(t.http)
      .post('/v1/admin/events')
      .set(a.auth)
      .send(base({ registrationUrl: 'http://contoh-lari.id', date: day(-1), categories: [] }))
      .expect(400);
    expect(bad.body.fields.map((f: { field: string }) => f.field)).toEqual(expect.arrayContaining(['registrationUrl', 'categories']));
    await request(t.http).post('/v1/admin/events').set(a.auth).send(base({ date: day(-1) })).expect(400);
    await request(t.http).post('/v1/admin/events').set(a.auth).send(base({ registrationUrl: 'javascript:alert(1)' })).expect(400);
    await request(t.http).post('/v1/admin/events').set(a.auth).send(base({ categories: ['marathon'] })).expect(400);

    const id = await event(a, { name: 'Jakarta Run', date: day(10) });
    const dup = await request(t.http).post('/v1/admin/events').set(a.auth).send(base({ name: 'jakarta run', date: day(10) })).expect(409);
    expect(dup.body.error).toBe('event_exists');

    await request(t.http)
      .put(`/v1/admin/events/${id}`)
      .set(a.auth)
      .send(base({ name: 'Jakarta Run 2026', date: day(11), startTime: null }))
      .expect(204);
    const list = await request(t.http).get('/v1/admin/events').set(a.auth).expect(200);
    expect(list.body[0]).toMatchObject({ id, name: 'Jakarta Run 2026', date: day(11), startTime: null, createdBy: 'Admin' });

    await request(t.http).delete(`/v1/admin/events/${id}`).set(a.auth).expect(204);
    await request(t.http).delete(`/v1/admin/events/${id}`).set(a.auth).expect(404);
    const log = await t.pool.query<{ action: string }>(`SELECT action FROM admin_audit_log WHERE target_type = 'event' ORDER BY id`);
    expect(log.rows.map((r) => r.action)).toEqual(['event.create', 'event.update', 'event.delete']);
  });

  it('daftar event: filter kota dan bulan, urut tanggal, paging, arsip otomatis sehari setelahnya', async () => {
    const a = await admin();
    const u = await user();
    const near = await event(a, { name: 'Bandung 5K', date: day(1), city: 'Bandung', categories: ['5k'] });
    const later = await event(a, { name: 'Surabaya Half', date: day(40), city: 'Surabaya', categories: ['hm'] });
    const today = await event(a, { name: 'Lari Hari Ini', date: day(0), city: 'bandung', categories: ['fun'] });
    // Event kemarin (dimasukkan langsung: API menolak tanggal lampau).
    const { rows } = await t.pool.query<{ id: string }>(
      `INSERT INTO events (name, event_date, city, categories, registration_url) VALUES ('Kemarin Run', $1, 'Bandung', '{5k}', 'https://x.id') RETURNING id`,
      [day(-1)],
    );
    const past = rows[0]!.id;

    const all = await request(t.http).get('/v1/events').set(u.auth).expect(200);
    expect(all.body.items.map((e: { id: string }) => e.id)).toEqual([today, near, later]);
    expect(all.body.items[0]).toMatchObject({ name: 'Lari Hari Ini', date: day(0), city: 'bandung', categories: ['fun'], goingCount: 0, iAmGoing: false, archived: false });

    const bdg = await request(t.http).get('/v1/events').query({ city: 'BANDUNG' }).set(u.auth).expect(200);
    expect(bdg.body.items.map((e: { id: string }) => e.id)).toEqual([today, near]);
    const month = day(40).slice(0, 7);
    const byMonth = await request(t.http).get('/v1/events').query({ month }).set(u.auth).expect(200);
    expect(byMonth.body.items.map((e: { id: string }) => e.id)).toContain(later);
    expect(byMonth.body.items.every((e: { date: string }) => e.date.startsWith(month))).toBe(true);
    await request(t.http).get('/v1/events').query({ month: '2026-13' }).set(u.auth).expect(400);

    const p1 = await request(t.http).get('/v1/events').query({ limit: 2 }).set(u.auth).expect(200);
    expect(p1.body.items).toHaveLength(2);
    const p2 = await request(t.http).get('/v1/events').query({ limit: 2, cursor: p1.body.nextCursor }).set(u.auth).expect(200);
    expect(p2.body.items.map((e: { id: string }) => e.id)).toEqual([later]);
    expect(p2.body.nextCursor).toBeNull();

    const cities = await request(t.http).get('/v1/events/cities').set(u.auth).expect(200);
    expect(cities.body[0]).toMatchObject({ events: 2 });
    expect(cities.body.map((c: { city: string }) => c.city.toLowerCase())).toEqual(['bandung', 'surabaya']);

    // Arsip: hanya event yang tanggalnya sudah lewat. Detailnya tetap bisa dibuka (archived: true), tetapi tidak bisa ditandai ikut.
    expect(await archivePastEvents(t.pool)).toBe(1);
    expect(await archivePastEvents(t.pool)).toBe(0);
    const { rows: arch } = await t.pool.query<{ id: string }>('SELECT id FROM events WHERE archived_at IS NOT NULL');
    expect(arch.map((r) => r.id)).toEqual([past]);
    expect((await request(t.http).get(`/v1/events/${past}`).set(u.auth).expect(200)).body.archived).toBe(true);
    expect((await request(t.http).post(`/v1/events/${past}/going`).set(u.auth).expect(409)).body.error).toBe('event_archived');

    // Mengubah tanggal ke masa depan membatalkan arsip.
    await request(t.http).put(`/v1/admin/events/${past}`).set(a.auth).send(base({ name: 'Kemarin Run', date: day(5) })).expect(204);
    expect((await request(t.http).get('/v1/events').set(u.auth).expect(200)).body.items.map((e: { id: string }) => e.id)).toContain(past);

    // Level 0 (belum verifikasi) tidak bisa membuka kalender.
    const unverified = await user('Baru', 0);
    await request(t.http).get('/v1/events').set(unverified.auth).expect(403);
  });

  it('Siapa ikut: jumlah total untuk semua, nama hanya sesama anggota komunitas', async () => {
    const a = await admin();
    const me = await user('Saya');
    const friend = await user('Teman');
    const other = await user('Teman Lain');
    const stranger = await user('Orang Asing');
    const c = await community(me, [friend, other]);
    const ev = await event(a);

    await request(t.http).post(`/v1/events/${ev}/going`).set(friend.auth).expect(200);
    await request(t.http).post(`/v1/events/${ev}/going`).set(friend.auth).expect(200); // idempoten
    await request(t.http).post(`/v1/events/${ev}/going`).set(stranger.auth).expect(200);
    const mine = await request(t.http).post(`/v1/events/${ev}/going`).set(me.auth).expect(200);
    expect(mine.body).toMatchObject({ goingCount: 3, iAmGoing: true, friendsGoing: 1 });
    expect(mine.body.friendsPreview).toEqual([{ id: friend.id, displayName: 'Teman', avatarUrl: null, communities: ['Lari Pagi'] }]);
    expect(mine.body.registrationUrl).toBe('https://contoh-lari.id/daftar');

    const who = await request(t.http).get(`/v1/events/${ev}/participants`).set(me.auth).expect(200);
    expect(who.body.items.map((p: { id: string }) => p.id)).toEqual([friend.id]);
    // Orang asing tidak melihat nama siapa pun (tidak satu komunitas), hanya jumlah.
    const theirs = await request(t.http).get(`/v1/events/${ev}`).set(stranger.auth).expect(200);
    expect(theirs.body).toMatchObject({ goingCount: 3, friendsGoing: 0, friendsPreview: [] });

    // Daftar "event saya".
    const going = await request(t.http).get('/v1/events').query({ going: 'true' }).set(other.auth).expect(200);
    expect(going.body.items).toEqual([]);
    expect((await request(t.http).get('/v1/events').query({ going: 'true' }).set(me.auth).expect(200)).body.items.map((e: { id: string }) => e.id)).toEqual([ev]);

    // Teman keluar dari komunitas: namanya langsung hilang.
    await request(t.http).post(`/v1/communities/${c}/leave`).set(friend.auth).expect(204);
    expect((await request(t.http).get(`/v1/events/${ev}/participants`).set(me.auth).expect(200)).body.items).toEqual([]);

    // Batal ikut.
    const cancel = await request(t.http).delete(`/v1/events/${ev}/going`).set(me.auth).expect(200);
    expect(cancel.body).toMatchObject({ goingCount: 2, iAmGoing: false });

    // Hapus akun: tanda ikut dihapus.
    await request(t.http).post('/v1/me/delete').set(stranger.auth).send({ password: PASSWORD, confirm: 'HAPUS' }).expect(204);
    expect((await t.pool.query('SELECT 1 FROM event_participants WHERE user_id = $1', [stranger.id])).rowCount).toBe(0);

    await request(t.http).get(`/v1/events/${randomUUID()}`).set(me.auth).expect(404);
  });

  it('bagikan event di chat: kartu memuat data terkini, jadi "tidak tersedia" setelah event dihapus', async () => {
    const a = await admin();
    const me = await user('Saya');
    const friend = await user('Teman');
    const c = await community(me, [friend]);
    const conv = (await request(t.http).get(`/v1/chat/communities/${c}`).set(me.auth).expect(200)).body.id as string;
    const ev = await event(a, { name: 'Bandung Marathon' });

    const send = (eventId: string) =>
      request(t.http).post(`/v1/chat/conversations/${conv}/messages`).set(me.auth).send({ clientMsgId: randomUUID(), kind: 'event', eventId });
    await send(randomUUID()).expect(404);
    const msg = (await send(ev).expect(201)).body;
    expect(msg).toMatchObject({ kind: 'event', event: { id: ev, name: 'Bandung Marathon', city: 'Bandung', available: true, archived: false } });

    const inbox = await request(t.http).get('/v1/chat/conversations').set(friend.auth).expect(200);
    expect(inbox.body[0].lastMessage).toMatchObject({ kind: 'event', preview: 'Bandung Marathon' });

    await request(t.http).put(`/v1/admin/events/${ev}`).set(a.auth).send(base({ name: 'Bandung Marathon 2026' })).expect(204);
    expect((await request(t.http).get(`/v1/chat/messages/${msg.id}`).set(friend.auth).expect(200)).body.event.name).toBe('Bandung Marathon 2026');

    await request(t.http).delete(`/v1/admin/events/${ev}`).set(a.auth).expect(204);
    expect((await request(t.http).get(`/v1/chat/messages/${msg.id}`).set(friend.auth).expect(200)).body.event).toEqual({
      id: ev,
      name: 'Bandung Marathon',
      available: false,
    });
  });

  it('lapor event: disembunyikan dari daftar setelah 3 pelapor, diturunkan super admin', async () => {
    const a = await admin();
    const ev = await event(a);
    const [r1, r2, r3] = [await user(), await user(), await user()];
    const report = (u: U) => request(t.http).post('/v1/reports').set(u.auth).send({ targetType: 'event', targetId: ev, reason: 'scam' });

    await request(t.http).post('/v1/reports').set(r1.auth).send({ targetType: 'event', targetId: randomUUID(), reason: 'scam' }).expect(404);
    for (const u of [r1, r2, r3]) await report(u).expect(201);
    expect((await request(t.http).get('/v1/events').set(r1.auth).expect(200)).body.items).toEqual([]);
    // Detail tetap bisa dibuka (mis. dari kartu chat) sambil ditinjau.
    await request(t.http).get(`/v1/events/${ev}`).set(r1.auth).expect(200);

    const queue = await request(t.http).get('/v1/admin/reports').set(a.auth).expect(200);
    expect(queue.body[0]).toMatchObject({ targetType: 'event', targetId: ev, reporters: 3 });
    expect(queue.body[0].label).toMatch(/^Bandung Marathon/);
    const detail = await request(t.http).get(`/v1/admin/reports/event/${ev}`).set(a.auth).expect(200);
    expect(detail.body.target).toMatchObject({ id: ev, city: 'Bandung', hidden: true, removed: false });

    await request(t.http).post(`/v1/admin/reports/event/${ev}/resolve`).set(a.auth).send({ action: 'remove' }).expect(204);
    await request(t.http).get(`/v1/events/${ev}`).set(r1.auth).expect(404);
    await report(r1).expect(404);
  });
});
