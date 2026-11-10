import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { TokenService } from '../src/auth/token.service.js';
import { FieldCrypto } from '../src/crypto/field-crypto.js';
import { createTestApp, hasTestInfra, resetData, type TestApp } from './helpers.js';

const HOME = { lat: -6.9, lng: 107.6 };
const degPerM = 1 / 111_195;
const north = (m: number) => ({ lat: HOME.lat + m * degPerM, lng: HOME.lng });

describe.skipIf(!hasTestInfra)('Modul 1.5 Status lari (e2e)', () => {
  let t: TestApp;
  let crypto: FieldCrypto;
  let port: number;
  let phoneSeq = 30_000_000;

  beforeAll(async () => {
    t = await createTestApp();
    crypto = new FieldCrypto(t.env.DATA_ENCRYPTION_KEY, t.env.BLIND_INDEX_KEY);
    await new Promise<void>((resolve) => t.http.listen(0, '127.0.0.1', resolve));
    port = (t.http.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await resetData(t);
  });

  async function user(name = 'Pelari') {
    const id = randomUUID();
    const email = `${id}@example.com`;
    const phone = `+62813${phoneSeq++}`;
    await t.pool.query(
      `INSERT INTO users (id, email_enc, email_bidx, email_verified_at, phone_enc, phone_bidx, phone_verified_at,
                          google_sub, display_name, privacy_accepted_at, privacy_version)
       VALUES ($1, $2, $3, now(), $4, $5, now(), $6, $7, now(), 'test')`,
      [
        id,
        crypto.encrypt(email, `users.email:${id}`),
        crypto.blindIndex('email', email),
        crypto.encrypt(phone, `users.phone:${id}`),
        crypto.blindIndex('phone', phone),
        `g-${id}`,
        name,
      ],
    );
    const tokens = await t.app.get(TokenService).issue(id, 'user');
    return { id, token: tokens.accessToken, auth: { Authorization: `Bearer ${tokens.accessToken}` } };
  }

  async function community(ownerId: string, members: string[] = []) {
    const { rows } = await t.pool.query<{ id: string }>(
      `INSERT INTO communities (name, city, owner_id, plan, member_count) VALUES ('Lari Pagi', 'Bandung', $1, 'pro_unlimited', $2) RETURNING id`,
      [ownerId, members.length + 1],
    );
    const id = rows[0]!.id;
    await t.pool.query(`INSERT INTO community_members (community_id, user_id, role, status, joined_at) VALUES ($1, $2, 'owner', 'active', now())`, [
      id,
      ownerId,
    ]);
    for (const m of members) {
      await t.pool.query(`INSERT INTO community_members (community_id, user_id, status, joined_at) VALUES ($1, $2, 'active', now())`, [id, m]);
    }
    return id;
  }

  const runId = randomUUID();
  function status(communities: { id: string; showLocation: boolean }[], extra: Record<string, unknown> = {}) {
    return {
      clientRunId: runId,
      communities,
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      distanceM: 1520.4,
      movingTimeS: 590,
      paused: false,
      origin: HOME,
      position: north(1500),
      ...extra,
    };
  }

  it('status hanya tampil di komunitas yang dipilih, tidak untuk orang luar', async () => {
    const runner = await user('Ani');
    const friend = await user('Budi');
    const other = await user('Citra');
    const outsider = await user('Dodi');
    const chosen = await community(runner.id, [friend.id]);
    const notChosen = await community(runner.id, [other.id]);

    // Bawaan: tidak ada status sama sekali.
    expect((await request(t.http).get(`/v1/communities/${chosen}/live`).set(friend.auth).expect(200)).body.items).toEqual([]);

    const put = await request(t.http).put('/v1/live').set(runner.auth).send(status([{ id: chosen, showLocation: false }])).expect(200);
    expect(put.body).toMatchObject({ sharing: true, communities: [{ id: chosen, showLocation: false }] });

    const seen = await request(t.http).get(`/v1/communities/${chosen}/live`).set(friend.auth).expect(200);
    expect(seen.body.items).toHaveLength(1);
    expect(seen.body.items[0]).toMatchObject({ userId: runner.id, displayName: 'Ani', distanceM: 1520, movingTimeS: 590, paused: false, position: null });

    // Komunitas lain milik pelari yang tidak dipilih: kosong.
    expect((await request(t.http).get(`/v1/communities/${notChosen}/live`).set(other.auth).expect(200)).body.items).toEqual([]);
    // Bukan anggota: ditolak.
    await request(t.http).get(`/v1/communities/${chosen}/live`).set(outsider.auth).expect(403);

    // Data di Redis: posisi tidak disimpan jika tidak dibagikan ke komunitas mana pun.
    const raw = JSON.parse((await t.redis.get(`live:s:${runner.id}`))!);
    expect(raw.pos).toBeUndefined();
    expect(raw.origin).toBeUndefined();
    expect(await t.redis.ttl(`live:s:${runner.id}`)).toBeGreaterThan(100);
  });

  it('komunitas yang bukan tempat pengguna terdaftar diabaikan', async () => {
    const runner = await user();
    const owner = await user();
    const foreign = await community(owner.id);
    const res = await request(t.http).put('/v1/live').set(runner.auth).send(status([{ id: foreign, showLocation: true }])).expect(200);
    expect(res.body).toMatchObject({ sharing: false, communities: [] });
    expect((await request(t.http).get(`/v1/communities/${foreign}/live`).set(owner.auth).expect(200)).body.items).toEqual([]);
    expect(await t.redis.exists(`live:s:${runner.id}`)).toBe(0);
  });

  it('posisi opsional per komunitas, disembunyikan di zona privasi, dan terenkripsi di Redis', async () => {
    const runner = await user();
    const a = await user();
    const b = await user();
    const withMap = await community(runner.id, [a.id]);
    const noMap = await community(runner.id, [b.id]);
    const pick = [
      { id: withMap, showLocation: true },
      { id: noMap, showLocation: false },
    ];

    // Masih 100 m dari titik mulai (zona 250 m): posisi tidak dikirim ke siapa pun.
    const near = await request(t.http).put('/v1/live').set(runner.auth).send(status(pick, { position: north(100) })).expect(200);
    expect(near.body.positionHidden).toBe(true);
    let item = (await request(t.http).get(`/v1/communities/${withMap}/live`).set(a.auth).expect(200)).body.items[0];
    expect(item).toMatchObject({ position: null, positionHidden: true });
    expect(JSON.parse((await t.redis.get(`live:s:${runner.id}`))!).pos).toBeUndefined();

    // 1,5 km dari rumah: posisi tampil (dibulatkan 4 desimal) hanya di komunitas yang diizinkan.
    await request(t.http).put('/v1/live').set(runner.auth).send(status(pick, { position: north(1500) })).expect(200);
    item = (await request(t.http).get(`/v1/communities/${withMap}/live`).set(a.auth).expect(200)).body.items[0];
    expect(item.position).toEqual({ lat: Number(north(1500).lat.toFixed(4)), lng: 107.6 });
    const noMapItem = (await request(t.http).get(`/v1/communities/${noMap}/live`).set(b.auth).expect(200)).body.items[0];
    expect(noMapItem).toMatchObject({ position: null, positionHidden: false });

    const stored = await t.redis.get(`live:s:${runner.id}`);
    expect(stored).not.toContain('107.6');
    expect(stored).not.toContain('-6.8');

    // Kembali mendekati rumah di akhir lari: posisi kembali disembunyikan.
    await request(t.http).put('/v1/live').set(runner.auth).send(status(pick, { position: north(50) })).expect(200);
    item = (await request(t.http).get(`/v1/communities/${withMap}/live`).set(a.auth).expect(200)).body.items[0];
    expect(item).toMatchObject({ position: null, positionHidden: true });
  });

  it('selesai lari menghapus status dan titik lokasi, termasuk saat lari diunggah', async () => {
    const runner = await user();
    const friend = await user();
    const c = await community(runner.id, [friend.id]);
    await request(t.http).put('/v1/live').set(runner.auth).send(status([{ id: c, showLocation: true }])).expect(200);
    await request(t.http).delete('/v1/live').set(runner.auth).expect(204);
    expect(await t.redis.exists(`live:s:${runner.id}`)).toBe(0);
    expect(await t.redis.zcard(`live:c:${c}`)).toBe(0);
    expect((await request(t.http).get(`/v1/communities/${c}/live`).set(friend.auth).expect(200)).body.items).toEqual([]);

    // Unggah lari dengan clientRunId yang sama juga mengakhiri status.
    await request(t.http).put('/v1/live').set(runner.auth).send(status([{ id: c, showLocation: true }])).expect(200);
    expect((await request(t.http).get('/v1/live').set(runner.auth).expect(200)).body).toMatchObject({ sharing: true, clientRunId: runId });
    const now = Date.now();
    await request(t.http)
      .post('/v1/runs')
      .set(runner.auth)
      .send({
        clientRunId: runId,
        title: 'Lari pagi',
        visibility: 'community',
        startedAt: new Date(now - 60_000).toISOString(),
        endedAt: new Date(now).toISOString(),
        segments: [[[HOME.lat, HOME.lng, 0, null], [north(100).lat, HOME.lng, 30, null]]],
      })
      .expect(201);
    expect(await t.redis.exists(`live:s:${runner.id}`)).toBe(0);
  });

  it('pelari yang keluar dari komunitas langsung hilang dari daftar', async () => {
    const runner = await user();
    const friend = await user();
    const owner = await user();
    const c = await community(owner.id, [runner.id, friend.id]);
    await request(t.http).put('/v1/live').set(runner.auth).send(status([{ id: c, showLocation: false }])).expect(200);
    expect((await request(t.http).get(`/v1/communities/${c}/live`).set(friend.auth).expect(200)).body.items).toHaveLength(1);
    await t.pool.query('DELETE FROM community_members WHERE community_id = $1 AND user_id = $2', [c, runner.id]);
    expect((await request(t.http).get(`/v1/communities/${c}/live`).set(friend.auth).expect(200)).body.items).toEqual([]);
  });

  it('hapus akun menghapus status lari', async () => {
    const runner = await user();
    const friend = await user();
    const owner = await user();
    const c = await community(owner.id, [runner.id, friend.id]);
    await request(t.http).put('/v1/live').set(runner.auth).send(status([{ id: c, showLocation: true }])).expect(200);
    await request(t.http).post('/v1/me/delete').set(runner.auth).send({ confirm: 'HAPUS' }).expect(204);
    expect(await t.redis.exists(`live:s:${runner.id}`)).toBe(0);
  });

  // ---------- WebSocket ----------

  function connect(headers: Record<string, string> = {}, path = '/v1/ws') {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    const messages: Record<string, unknown>[] = [];
    const waiters: { pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }[] = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as Record<string, unknown>;
      messages.push(m);
      for (const w of [...waiters]) {
        if (w.pred(m)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    });
    const next = (pred: (m: Record<string, unknown>) => boolean, ms = 3000) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const found = messages.find(pred);
        if (found) return resolve(found);
        const timer = setTimeout(() => reject(new Error('Pesan WebSocket tidak datang')), ms);
        waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
      });
    return { ws, messages, next };
  }

  function handshakeStatus(headers: Record<string, string>, path = '/v1/ws') {
    return new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => {
        ws.close();
        resolve(101);
      });
      ws.on('error', () => undefined);
    });
  }

  it('WebSocket: anggota terpilih menerima perubahan dalam hitungan detik, orang luar ditolak', async () => {
    const runner = await user();
    const friend = await user();
    const outsider = await user();
    const c = await community(runner.id, [friend.id]);
    const ch = `community:${c}:live`;

    const f = connect(friend.auth);
    await f.next((m) => m.op === 'ready');
    f.ws.send(JSON.stringify({ op: 'sub', ch }));
    await f.next((m) => m.op === 'subscribed' && m.ch === ch);

    const o = connect(outsider.auth);
    await o.next((m) => m.op === 'ready');
    o.ws.send(JSON.stringify({ op: 'sub', ch }));
    expect(await o.next((m) => m.op === 'error')).toMatchObject({ ch, code: 'forbidden' });
    o.ws.send(JSON.stringify({ op: 'sub', ch: 'unknown:channel' }));
    expect(await o.next((m) => m.op === 'error' && m.ch === 'unknown:channel')).toMatchObject({ code: 'forbidden' });

    const started = Date.now();
    await request(t.http).put('/v1/live').set(runner.auth).send(status([{ id: c, showLocation: false }])).expect(200);
    const ev = await f.next((m) => m.op === 'event');
    expect(Date.now() - started).toBeLessThan(3000);
    // Sinyal saja, tanpa data pribadi: data diambil lewat REST yang diperiksa hak aksesnya.
    expect(ev).toEqual({ op: 'event', ch, ev: 'live.changed' });
    expect(o.messages.some((m) => m.op === 'event')).toBe(false);

    f.ws.close();
    o.ws.close();
  });

  it('WebSocket: handshake wajib token akses di header', async () => {
    const u = await user();
    expect(await handshakeStatus({})).toBe(401);
    expect(await handshakeStatus({ Authorization: 'Bearer salah' })).toBe(401);
    // Token di query string tidak diterima.
    expect(await handshakeStatus({}, `/v1/ws?token=${u.token}`)).toBe(401);
    expect(await handshakeStatus(u.auth, '/v1/lain')).toBe(404);
    expect(await handshakeStatus(u.auth)).toBe(101);

    // Akun belum Level 1 ditolak.
    await t.pool.query('UPDATE users SET phone_verified_at = NULL, phone_enc = NULL, phone_bidx = NULL WHERE id = $1', [u.id]);
    expect(await handshakeStatus(u.auth)).toBe(403);
  });
});
