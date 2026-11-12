import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password.js';
import { TokenService } from '../src/auth/token.service.js';
import { FieldCrypto } from '../src/crypto/field-crypto.js';
import { EventScraper } from '../src/event-engine/event-scraper.js';
import { ScrapeTrigger } from '../src/event-engine/scrape-trigger.js';
import { type RawResponse, ScrapeHttp } from '../src/event-engine/scrape-http.js';
import { archivePastEvents, expireStaleSubmissions, todayWib } from '../src/events/event-archive.js';
import { createTestApp, hasTestInfra, resetData, type TestApp } from './helpers.js';

const PASSWORD = 'rahasia-sekali-123';
const DAY = 86_400_000;
const day = (n: number) => todayWib(Date.now() + n * DAY);

const SOURCES = [
  { id: 'kalender-uji', name: 'Kalender Uji', urls: ['https://kalender.uji.id/lari', 'https://kalender.uji.id/terlarang', 'https://kalender.uji.id/belok'] },
];

describe.skipIf(!hasTestInfra)('Modul 2.4 Engine event (e2e)', () => {
  let t: TestApp;
  let crypto: FieldCrypto;
  let phoneSeq = 71_000_000;
  let passwordHash: string;
  let scraper: EventScraper;
  let http: ScrapeHttp;
  /** Halaman palsu yang dilayani transport (tanpa internet). */
  let pages: Record<string, RawResponse>;
  let fetched: string[];

  beforeAll(async () => {
    t = await createTestApp({ EVENT_SCRAPE_SOURCES: JSON.stringify(SOURCES), PUBLIC_WEB_URL: 'https://pace.uji.id' });
    crypto = new FieldCrypto(t.env.DATA_ENCRYPTION_KEY, t.env.BLIND_INDEX_KEY);
    passwordHash = await hashPassword(PASSWORD);
    scraper = t.app.get(EventScraper);
    http = t.app.get(ScrapeHttp);
    http.sleep = async () => undefined;
    http.transport = async (url) => {
      fetched.push(url.toString());
      return pages[url.toString()] ?? { status: 404, headers: {}, body: Buffer.from('') };
    };
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await resetData(t);
    await t.pool.query('TRUNCATE event_scrape_runs');
    fetched = [];
    pages = {};
  });

  type U = { id: string; auth: { Authorization: string } };

  async function user(name = 'Pelari', level = 1): Promise<U> {
    const id = randomUUID();
    const email = `${id}@example.com`;
    const phone = `+62815${phoneSeq++}`;
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

  const submission = (over: Record<string, unknown> = {}) => ({
    name: `Bogor Trail Run ${randomUUID().slice(0, 6)}`,
    date: day(40),
    startTime: '06:00',
    city: 'Bogor',
    venue: 'Kebun Raya',
    description: 'Trail 10K dan 21K',
    categories: ['10k', 'hm'],
    registrationUrl: 'https://daftar.bogortrail.id/2026',
    organizer: 'Bogor Trail Community',
    contact: 'panitia@bogortrail.id',
    ...over,
  });

  const page = (body: string, type = 'text/html'): RawResponse => ({ status: 200, headers: { 'content-type': type }, body: Buffer.from(body) });
  const jsonLd = (events: unknown[]) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': events })}</script></head></html>`;
  const ldEvent = (name: string, date: string, slug: string, city = 'Jakarta') => ({
    '@type': 'SportsEvent',
    name,
    startDate: `${date}T05:00:00+07:00`,
    url: `https://kalender.uji.id/event/${slug}`,
    location: { '@type': 'Place', name: 'GBK', address: { '@type': 'PostalAddress', addressLocality: city } },
    offers: { '@type': 'Offer', url: `https://tiket.uji.id/${slug}` },
  });

  async function inbox(userId: string) {
    return (await t.pool.query<{ type: string; data: Record<string, string> }>('SELECT type, data FROM notifications WHERE user_id = $1 ORDER BY created_at', [userId])).rows;
  }

  it('kiriman pengguna masuk antrean dan TIDAK terlihat sebelum disetujui; kontak terenkripsi', async () => {
    const u = await user('Penyelenggara');
    const a = await admin();
    const body = submission();
    const res = await request(t.http).post('/v1/event-submissions').set(u.auth).send(body).expect(201);
    expect(res.body.status).toBe('pending');
    const id = res.body.id as string;

    const list = await request(t.http).get('/v1/events').set(u.auth).expect(200);
    expect(list.body.items).toHaveLength(0);
    expect((await t.pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n).toBe(0);

    const mine = await request(t.http).get('/v1/event-submissions').set(u.auth).expect(200);
    expect(mine.body.items).toEqual([expect.objectContaining({ id, status: 'pending', name: body.name, eventId: null })]);
    expect(JSON.stringify(mine.body)).not.toContain('panitia@');

    // Kontak tersimpan terenkripsi, tidak muncul di daftar panel, dibuka lewat endpoint ber-audit.
    const raw = await t.pool.query<{ organizer_contact_enc: Buffer }>('SELECT organizer_contact_enc FROM event_submissions WHERE id = $1', [id]);
    expect(raw.rows[0]!.organizer_contact_enc.toString('latin1')).not.toContain('panitia');
    const q = await request(t.http).get('/v1/admin/event-submissions').set(a.auth).expect(200);
    expect(q.body).toEqual([expect.objectContaining({ id, origin: 'user', hasContact: true, sourceName: 'Bogor Trail Community', submittedBy: { id: u.id, displayName: 'Penyelenggara' } })]);
    expect(JSON.stringify(q.body)).not.toContain('panitia@');
    const c = await request(t.http).get(`/v1/admin/event-submissions/${id}/contact`).set(a.auth).expect(200);
    expect(c.body.contact).toBe('panitia@bogortrail.id');
    const log = await t.pool.query<{ action: string }>(`SELECT action FROM admin_audit_log WHERE target_id = $1`, [id]);
    expect(log.rows.map((r) => r.action)).toEqual(['event_submission.view_contact']);

    // Bukan admin panel: ditolak.
    await request(t.http).get('/v1/admin/event-submissions').set(u.auth).expect(403);
    await request(t.http).post(`/v1/admin/event-submissions/${id}/approve`).set(u.auth).send({}).expect(403);
  });

  it('validasi kiriman dan Level 1 wajib', async () => {
    const u = await user();
    const lv0 = await user('Baru', 0);
    await request(t.http).post('/v1/event-submissions').set(lv0.auth).send(submission()).expect(403);
    await request(t.http).post('/v1/event-submissions').set(u.auth).send(submission({ registrationUrl: 'http://tidak-aman.id' })).expect(400);
    await request(t.http).post('/v1/event-submissions').set(u.auth).send(submission({ date: day(-1) })).expect(400);
    await request(t.http).post('/v1/event-submissions').set(u.auth).send(submission({ contact: 'bukan kontak' })).expect(400);
    await request(t.http).post('/v1/event-submissions').set(u.auth).send(submission({ hidden: 'x' })).expect(400);
  });

  it('batas 5 kiriman per hari per pengguna', async () => {
    const u = await user();
    for (let i = 0; i < 5; i++) {
      await t.pool.query(
        `INSERT INTO event_submissions (origin, submitted_by, name, event_date, city, categories, registration_url, source_name, source_url)
         VALUES ('user', $1, $2, $3, 'Bogor', '{5k}', 'https://a.id/x', 'Org', 'https://a.id/x')`,
        [u.id, `Lari ${i}`, day(10)],
      );
    }
    const res = await request(t.http).post('/v1/event-submissions').set(u.auth).send(submission()).expect(429);
    expect(res.body.error).toBe('submission_limit');
    // Kiriman lebih dari 24 jam lalu tidak dihitung.
    await t.pool.query(`UPDATE event_submissions SET created_at = now() - interval '25 hours' WHERE submitted_by = $1`, [u.id]);
    await request(t.http).post('/v1/event-submissions').set(u.auth).send(submission()).expect(201);
  });

  it('setujui (dengan koreksi admin): tayang dengan sumber + tautan resmi, notifikasi, audit, tidak bisa ditinjau dua kali', async () => {
    const u = await user('Penyelenggara');
    const a = await admin();
    const body = submission({ officialUrl: 'https://bogortrail.id/event' });
    const id = (await request(t.http).post('/v1/event-submissions').set(u.auth).send(body).expect(201)).body.id as string;

    await request(t.http).post(`/v1/admin/event-submissions/${id}/approve`).set(a.auth).send({ city: '' }).expect(400);
    const ok = await request(t.http).post(`/v1/admin/event-submissions/${id}/approve`).set(a.auth).send({ venue: 'Kebun Raya Bogor' }).expect(200);
    const eventId = ok.body.eventId as string;

    const list = await request(t.http).get('/v1/events').set(u.auth).expect(200);
    expect(list.body.items.map((e: { id: string }) => e.id)).toEqual([eventId]);
    const detail = await request(t.http).get(`/v1/events/${eventId}`).set(u.auth).expect(200);
    expect(detail.body).toMatchObject({
      name: body.name,
      venue: 'Kebun Raya Bogor',
      registrationUrl: body.registrationUrl,
      source: { origin: 'user', name: 'Bogor Trail Community', url: 'https://bogortrail.id/event' },
    });

    await request(t.http).post(`/v1/admin/event-submissions/${id}/approve`).set(a.auth).send({}).expect(409);
    await request(t.http).post(`/v1/admin/event-submissions/${id}/reject`).set(a.auth).send({ reason: 'Terlambat' }).expect(409);

    const mine = await request(t.http).get('/v1/event-submissions').set(u.auth).expect(200);
    expect(mine.body.items[0]).toMatchObject({ status: 'approved', eventId });
    expect(await inbox(u.id)).toEqual([{ type: 'event_submission_approved', data: { submissionId: id, eventId } }]);
    expect(t.push.to(u.id).at(-1)).toMatchObject({ data: { category: 'event', type: 'event_submission_approved', eventId } });
    const log = await t.pool.query<{ action: string; metadata: Record<string, unknown> }>(`SELECT action, metadata FROM admin_audit_log WHERE target_id = $1`, [id]);
    expect(log.rows).toEqual([expect.objectContaining({ action: 'event_submission.approve', metadata: expect.objectContaining({ eventId, origin: 'user' }) })]);

    // Event manual tetap punya sumber: "Tim PaceTara" + tautan pendaftaran.
    const manual = await request(t.http)
      .post('/v1/admin/events')
      .set(a.auth)
      .send({ name: 'Lari Manual', date: day(20), city: 'Bandung', categories: ['5k'], registrationUrl: 'https://manual.id/daftar' })
      .expect(201);
    const md = await request(t.http).get(`/v1/events/${manual.body.id}`).set(u.auth).expect(200);
    expect(md.body.source).toEqual({ origin: 'admin', name: 'Tim PaceTara', url: 'https://manual.id/daftar' });
  });

  it('tolak dengan alasan: pengirim melihat alasan + notifikasi', async () => {
    const u = await user();
    const a = await admin();
    const id = (await request(t.http).post('/v1/event-submissions').set(u.auth).send(submission()).expect(201)).body.id as string;
    await request(t.http).post(`/v1/admin/event-submissions/${id}/reject`).set(a.auth).send({ reason: 'x' }).expect(400);
    await request(t.http).post(`/v1/admin/event-submissions/${id}/reject`).set(a.auth).send({ reason: 'Tautan pendaftaran tidak resmi' }).expect(204);
    const mine = await request(t.http).get('/v1/event-submissions').set(u.auth).expect(200);
    expect(mine.body.items[0]).toMatchObject({ status: 'rejected', rejectReason: 'Tautan pendaftaran tidak resmi', eventId: null });
    expect((await inbox(u.id)).map((n) => n.type)).toEqual(['event_submission_rejected']);
    const rejected = await request(t.http).get('/v1/admin/event-submissions?status=rejected').set(a.auth).expect(200);
    expect(rejected.body[0]).toMatchObject({ id, rejectReason: 'Tautan pendaftaran tidak resmi', reviewedBy: 'Admin' });
    const log = await t.pool.query<{ action: string }>(`SELECT action FROM admin_audit_log WHERE target_id = $1`, [id]);
    expect(log.rows.map((r) => r.action)).toEqual(['event_submission.reject']);
    expect((await request(t.http).get('/v1/events').set(u.auth).expect(200)).body.items).toHaveLength(0);
  });

  it('duplikat: kandidat ditampilkan dan digabung ke event yang ada', async () => {
    const u = await user();
    const a = await admin();
    const existing = await request(t.http)
      .post('/v1/admin/events')
      .set(a.auth)
      .send({ name: 'Jakarta Marathon 2026', date: day(30), city: 'Jakarta', categories: ['fm'], registrationUrl: 'https://jakmar.id/daftar' })
      .expect(201);
    const eventId = existing.body.id as string;
    const id = (
      await request(t.http)
        .post('/v1/event-submissions')
        .set(u.auth)
        .send(submission({ name: 'JAKARTA MARATHON', date: day(31), city: 'Kota Jakarta', registrationUrl: 'https://lain.id/jm', organizer: 'Panitia JM' }))
        .expect(201)
    ).body.id as string;

    const q = await request(t.http).get('/v1/admin/event-submissions').set(a.auth).expect(200);
    expect(q.body[0].duplicates).toEqual([expect.objectContaining({ kind: 'event', id: eventId, reason: 'similar_name' })]);

    // Menyetujui sebagai event baru dengan nama+tanggal yang sama ditolak (409), sarannya gabung.
    await request(t.http).post(`/v1/admin/event-submissions/${id}/approve`).set(a.auth).send({ name: 'Jakarta Marathon 2026', date: day(30) }).expect(409);
    await request(t.http).post(`/v1/admin/event-submissions/${id}/merge`).set(a.auth).send({ eventId: randomUUID() }).expect(404);
    await request(t.http).post(`/v1/admin/event-submissions/${id}/merge`).set(a.auth).send({ eventId }).expect(204);

    const sub = await t.pool.query<{ status: string; event_id: string }>('SELECT status, event_id FROM event_submissions WHERE id = $1', [id]);
    expect(sub.rows[0]).toEqual({ status: 'merged', event_id: eventId });
    // Event tujuan mendapat sumber dari kiriman karena sebelumnya tidak punya.
    const detail = await request(t.http).get(`/v1/events/${eventId}`).set(u.auth).expect(200);
    expect(detail.body.source).toMatchObject({ name: 'Panitia JM', url: 'https://lain.id/jm' });
    expect((await request(t.http).get('/v1/events').set(u.auth).expect(200)).body.items).toHaveLength(1);
    expect((await inbox(u.id)).map((n) => n.data)).toEqual([{ submissionId: id, eventId }]);
    const log = await t.pool.query<{ action: string }>(`SELECT action FROM admin_audit_log WHERE target_id = $1`, [id]);
    expect(log.rows.map((r) => r.action)).toEqual(['event_submission.merge']);
  });

  it('scraping: robots.txt dihormati, redirect host lain ditolak, idempoten, memperbarui kiriman menunggu saja', async () => {
    const a = await admin();
    pages['https://kalender.uji.id/robots.txt'] = page('User-agent: *\nDisallow: /terlarang\n\nUser-agent: PaceTaraBot\nDisallow: /terlarang', 'text/plain');
    pages['https://kalender.uji.id/lari'] = page(jsonLd([ldEvent('Jakarta Night Run 10K', day(20), 'jnr'), ldEvent('Surabaya Half Marathon', day(25), 'shm', 'Surabaya')]));
    pages['https://kalender.uji.id/terlarang'] = page(jsonLd([ldEvent('Rahasia Run', day(22), 'rahasia')]));
    pages['https://kalender.uji.id/belok'] = { status: 302, headers: { location: 'https://127.0.0.1/admin' }, body: Buffer.from('') };

    const [s1] = await scraper.runAll();
    expect(s1).toMatchObject({ sourceId: 'kalender-uji', pages: 1, found: 2, created: 2, updated: 0 });
    expect(s1!.errors).toEqual([expect.stringMatching(/^robots_disallowed/), expect.stringMatching(/^redirect_other_host/)]);
    // Halaman terlarang tidak pernah diminta; robots.txt dibaca sekali.
    expect(fetched).not.toContain('https://kalender.uji.id/terlarang');
    expect(fetched.filter((u) => u.endsWith('/robots.txt'))).toHaveLength(1);
    expect(fetched).not.toContain('https://127.0.0.1/admin');

    const rows = await t.pool.query<{ id: string; name: string; status: string; source_name: string; source_url: string; registration_url: string; categories: string[] }>(
      `SELECT id, name, status, source_name, source_url, registration_url, categories FROM event_submissions ORDER BY event_date`,
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({ name: 'Jakarta Night Run 10K', status: 'pending', source_name: 'Kalender Uji', source_url: 'https://kalender.uji.id/event/jnr', registration_url: 'https://tiket.uji.id/jnr', categories: ['10k'] }),
      expect.objectContaining({ name: 'Surabaya Half Marathon', categories: ['hm'] }),
    ]);
    // Belum tayang.
    const u = await user();
    expect((await request(t.http).get('/v1/events').set(u.auth).expect(200)).body.items).toHaveLength(0);

    // Ulang tanpa perubahan: tidak ada baris baru.
    const [s2] = await scraper.runAll();
    expect(s2).toMatchObject({ created: 0, updated: 0, found: 2 });
    expect((await t.pool.query('SELECT count(*)::int AS n FROM event_submissions')).rows[0].n).toBe(2);

    // Setujui satu, lalu sumber mengubah keduanya: yang menunggu diperbarui, yang sudah disetujui tidak disentuh.
    const jnr = rows.rows[0]!.id;
    const eventId = (await request(t.http).post(`/v1/admin/event-submissions/${jnr}/approve`).set(a.auth).send({}).expect(200)).body.eventId as string;
    pages['https://kalender.uji.id/lari'] = page(
      jsonLd([ldEvent('Jakarta Night Run 10K (Baru)', day(20), 'jnr'), ldEvent('Surabaya Half Marathon 21K', day(26), 'shm', 'Surabaya')]),
    );
    const [s3] = await scraper.runAll();
    expect(s3).toMatchObject({ created: 0, updated: 1 });
    const after = await t.pool.query<{ name: string; status: string }>('SELECT name, status FROM event_submissions ORDER BY event_date');
    expect(after.rows).toEqual([
      { name: 'Jakarta Night Run 10K', status: 'approved' },
      { name: 'Surabaya Half Marathon 21K', status: 'pending' },
    ]);
    const ev = await request(t.http).get(`/v1/events/${eventId}`).set(u.auth).expect(200);
    expect(ev.body).toMatchObject({ name: 'Jakarta Night Run 10K', source: { origin: 'scrape', name: 'Kalender Uji', url: 'https://kalender.uji.id/event/jnr' } });

    // Panel: sumber + putaran terakhir.
    const src = await request(t.http).get('/v1/admin/event-sources').set(a.auth).expect(200);
    expect(src.body.userAgent).toBe('PaceTaraBot/1.0 (+https://pace.uji.id/bot)');
    expect(src.body.sources).toEqual([expect.objectContaining({ id: 'kalender-uji', name: 'Kalender Uji', lastRun: expect.objectContaining({ pages: 1, updated: 1 }) })]);

    // Panel: "Jalankan sekarang" menaruh satu putaran di antrean, maks. sekali per 15 menit, tercatat di log.
    const trigger = t.app.get(ScrapeTrigger);
    let queued = 0;
    trigger.enqueue = async () => {
      queued++;
    };
    await t.redis.del('event-scrape:manual');
    await request(t.http).post('/v1/admin/event-sources/run').set(u.auth).expect(403);
    expect((await request(t.http).post('/v1/admin/event-sources/run').set(a.auth).expect(202)).body).toMatchObject({ queued: true });
    const again = await request(t.http).post('/v1/admin/event-sources/run').set(a.auth).expect(429);
    expect(again.body.error).toBe('scrape_cooldown');
    expect(queued).toBe(1);
    const log = await t.pool.query(`SELECT action FROM admin_audit_log WHERE actor_id = $1 AND action = 'event_scrape.run'`, [a.id]);
    expect(log.rowCount).toBe(1);
  });

  it('arsip: event hasil engine diarsipkan seperti event manual; kiriman menunggu yang lewat ditutup', async () => {
    const u = await user();
    const a = await admin();
    const id = (await request(t.http).post('/v1/event-submissions').set(u.auth).send(submission()).expect(201)).body.id as string;
    const eventId = (await request(t.http).post(`/v1/admin/event-submissions/${id}/approve`).set(a.auth).send({}).expect(200)).body.eventId as string;
    const stale = (await request(t.http).post('/v1/event-submissions').set(u.auth).send(submission()).expect(201)).body.id as string;
    await t.pool.query('UPDATE events SET event_date = $2 WHERE id = $1', [eventId, day(-1)]);
    await t.pool.query('UPDATE event_submissions SET event_date = $2 WHERE id = $1', [stale, day(-1)]);
    expect(await archivePastEvents(t.pool)).toBeGreaterThanOrEqual(1);
    expect(await expireStaleSubmissions(t.pool)).toBe(1);
    const ev = await request(t.http).get(`/v1/events/${eventId}`).set(u.auth).expect(200);
    expect(ev.body.archived).toBe(true);
    const s = await t.pool.query<{ status: string; reject_reason: string }>('SELECT status, reject_reason FROM event_submissions WHERE id = $1', [stale]);
    expect(s.rows[0]).toEqual({ status: 'rejected', reject_reason: 'Tanggal event sudah lewat sebelum ditinjau' });
  });

  it('hapus akun: kiriman menunggu dihapus, yang ditinjau dianonimkan, event yang tayang tetap', async () => {
    const u = await user();
    const a = await admin();
    const pending = (await request(t.http).post('/v1/event-submissions').set(u.auth).send(submission()).expect(201)).body.id as string;
    const done = (await request(t.http).post('/v1/event-submissions').set(u.auth).send(submission()).expect(201)).body.id as string;
    const eventId = (await request(t.http).post(`/v1/admin/event-submissions/${done}/approve`).set(a.auth).send({}).expect(200)).body.eventId as string;
    await request(t.http).post('/v1/me/delete').set(u.auth).send({ password: PASSWORD, confirm: 'HAPUS' }).expect(204);
    const rows = await t.pool.query<{ id: string; submitted_by: string | null; organizer_contact_enc: Buffer | null }>(
      'SELECT id, submitted_by, organizer_contact_enc FROM event_submissions',
    );
    expect(rows.rows).toEqual([{ id: done, submitted_by: null, organizer_contact_enc: null }]);
    expect(rows.rows.some((r) => r.id === pending)).toBe(false);
    const other = await user();
    await request(t.http).get(`/v1/events/${eventId}`).set(other.auth).expect(200);
  });
});
