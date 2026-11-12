import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { TokenService } from '../src/auth/token.service.js';
import { expireChatImages } from '../src/chat/chat-expiry.js';
import { ChatService } from '../src/chat/chat.service.js';
import { FieldCrypto } from '../src/crypto/field-crypto.js';
import { createTestApp, hasTestInfra, resetData, type TestApp } from './helpers.js';

describe.skipIf(!hasTestInfra)('Modul 1.6 Chat (e2e)', () => {
  let t: TestApp;
  let crypto: FieldCrypto;
  let port: number;
  let phoneSeq = 40_000_000;

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
    t.storage.objects.clear();
  });

  type U = { id: string; auth: { Authorization: string } };

  async function user(name = 'Pelari'): Promise<U> {
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
    return { id, auth: { Authorization: `Bearer ${tokens.accessToken}` } };
  }

  /** Komunitas lewat API (agar alur bergabung sungguhan dipakai). Pro Unlimited supaya batas anggota tidak mengganggu. */
  async function community(owner: U, opts: { visibility?: 'open' | 'private'; members?: U[] } = {}) {
    const res = await request(t.http)
      .post('/v1/communities')
      .set(owner.auth)
      .send({ name: 'Lari Pagi', city: 'Bandung', description: '', visibility: opts.visibility ?? 'open' })
      .expect(201);
    const id = res.body.id as string;
    await t.pool.query(`UPDATE communities SET plan = 'pro_unlimited' WHERE id = $1`, [id]);
    for (const m of opts.members ?? []) {
      await t.pool.query(`INSERT INTO community_members (community_id, user_id, status, joined_at) VALUES ($1, $2, 'active', now())`, [id, m.id]);
    }
    return id;
  }

  async function communityConv(u: U, communityId: string) {
    return (await request(t.http).get(`/v1/chat/communities/${communityId}`).set(u.auth).expect(200)).body.id as string;
  }

  function sendText(u: U, conv: string, text: string, clientMsgId = randomUUID()) {
    return request(t.http).post(`/v1/chat/conversations/${conv}/messages`).set(u.auth).send({ clientMsgId, kind: 'text', text });
  }

  const png = () => sharp({ create: { width: 64, height: 64, channels: 3, background: '#3366ff' } }).png().toBuffer();

  it('chat komunitas: anggota mengirim dan membaca, isi terenkripsi, orang luar tidak bisa mengambil apa pun', async () => {
    const owner = await user('Ani');
    const member = await user('Budi');
    const outsider = await user('Citra');
    const c = await community(owner, { members: [member] });
    const conv = await communityConv(owner, c);

    const sent = await sendText(owner, conv, 'Lari jam 6 di Dago ya').expect(201);
    expect(sent.body).toMatchObject({ kind: 'text', text: 'Lari jam 6 di Dago ya', isMine: true, sender: { displayName: 'Ani' } });

    const list = await request(t.http).get(`/v1/chat/conversations/${conv}/messages`).set(member.auth).expect(200);
    expect(list.body.items.map((m: { text: string }) => m.text)).toEqual(['Lari jam 6 di Dago ya']);

    // Isi pesan terenkripsi di database.
    const { rows } = await t.pool.query<{ body_enc: Buffer }>('SELECT body_enc FROM chat_messages');
    expect(rows[0]!.body_enc.toString('latin1')).not.toContain('Dago');

    // Orang luar: semua jalur 404.
    const msgId = sent.body.id as string;
    await request(t.http).get(`/v1/chat/conversations/${conv}`).set(outsider.auth).expect(404);
    await request(t.http).get(`/v1/chat/conversations/${conv}/messages`).set(outsider.auth).expect(404);
    await request(t.http).get(`/v1/chat/messages/${msgId}`).set(outsider.auth).expect(404);
    await sendText(outsider, conv, 'halo').expect(404);
    await request(t.http).get(`/v1/chat/communities/${c}`).set(outsider.auth).expect(404);
    const inbox = await request(t.http).get('/v1/chat/conversations').set(outsider.auth).expect(200);
    expect(inbox.body).toEqual([]);

    // Anggota yang dikeluarkan kehilangan akses.
    await request(t.http).post(`/v1/communities/${c}/members/${member.id}/remove`).set(owner.auth).send({}).expect(204);
    await request(t.http).get(`/v1/chat/conversations/${conv}/messages`).set(member.auth).expect(404);
  });

  it('riwayat untuk anggota baru: komunitas terbuka ikut pengaturan, admin memilih saat menyetujui', async () => {
    const owner = await user('Ani');
    const open = await community(owner);
    const conv = await communityConv(owner, open);
    await sendText(owner, conv, 'pesan lama').expect(201);

    // Bawaan: anggota baru di komunitas terbuka tidak melihat riwayat lama.
    const late = await user('Budi');
    await request(t.http).post(`/v1/communities/${open}/join`).set(late.auth).expect(200);
    let seen = await request(t.http).get(`/v1/chat/conversations/${conv}/messages`).set(late.auth).expect(200);
    expect(seen.body.items).toEqual([]);
    const oldId = (await request(t.http).get(`/v1/chat/conversations/${conv}/messages`).set(owner.auth).expect(200)).body.items[0].id;
    await request(t.http).get(`/v1/chat/messages/${oldId}`).set(late.auth).expect(404);
    await sendText(owner, conv, 'pesan baru').expect(201);
    seen = await request(t.http).get(`/v1/chat/conversations/${conv}/messages`).set(late.auth).expect(200);
    expect(seen.body.items.map((m: { text: string }) => m.text)).toEqual(['pesan baru']);

    // Pengaturan "anggota baru melihat riwayat" dinyalakan.
    await request(t.http).patch(`/v1/communities/${open}`).set(owner.auth).send({ newMembersSeeHistory: true }).expect(200);
    const late2 = await user('Citra');
    await request(t.http).post(`/v1/communities/${open}/join`).set(late2.auth).expect(200);
    seen = await request(t.http).get(`/v1/chat/conversations/${conv}/messages`).set(late2.auth).expect(200);
    expect(seen.body.items).toHaveLength(2);

    // Komunitas privat: admin memilih per anggota saat menyetujui.
    const priv = await community(owner, { visibility: 'private' });
    const pconv = await communityConv(owner, priv);
    await sendText(owner, pconv, 'rahasia lama').expect(201);
    const withHistory = await user('Dodi');
    const withoutHistory = await user('Eka');
    for (const u of [withHistory, withoutHistory]) await request(t.http).post(`/v1/communities/${priv}/join`).set(u.auth).expect(200);
    await request(t.http).post(`/v1/communities/${priv}/members/${withHistory.id}/approve`).set(owner.auth).send({ seeHistory: true }).expect(204);
    await request(t.http).post(`/v1/communities/${priv}/members/${withoutHistory.id}/approve`).set(owner.auth).send({ seeHistory: false }).expect(204);
    expect((await request(t.http).get(`/v1/chat/conversations/${pconv}/messages`).set(withHistory.auth).expect(200)).body.items).toHaveLength(1);
    expect((await request(t.http).get(`/v1/chat/conversations/${pconv}/messages`).set(withoutHistory.auth).expect(200)).body.items).toHaveLength(0);
  });

  it('riwayat dimuat bertahap dan bisa disinkronkan setelah seq tertentu', async () => {
    const owner = await user();
    const c = await community(owner);
    const conv = await communityConv(owner, c);
    // Langsung lewat service: 45 pesan melewati batas laju 30/menit per pengguna (yang juga diuji di bawah).
    const chat = t.app.get(ChatService);
    for (let i = 1; i <= 45; i++) await chat.send(owner.id, conv, { clientMsgId: randomUUID(), kind: 'text', text: `pesan ${i}` });

    const first = await request(t.http).get(`/v1/chat/conversations/${conv}/messages`).set(owner.auth).expect(200);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.items).toHaveLength(30);
    expect(first.body.items[0].text).toBe('pesan 16');
    expect(first.body.items.at(-1).text).toBe('pesan 45');

    const older = await request(t.http).get(`/v1/chat/conversations/${conv}/messages?before=${first.body.items[0].seq}`).set(owner.auth).expect(200);
    expect(older.body.hasMore).toBe(false);
    expect(older.body.items.map((m: { text: string }) => m.text)).toEqual(Array.from({ length: 15 }, (_, i) => `pesan ${i + 1}`));

    const after = await request(t.http).get(`/v1/chat/conversations/${conv}/messages?after=${first.body.items[27].seq}`).set(owner.auth).expect(200);
    expect(after.body.items.map((m: { text: string }) => m.text)).toEqual(['pesan 44', 'pesan 45']);
  });

  it('batas laju kirim pesan dihitung per pengguna, bukan per IP (CGNAT)', async () => {
    const a = await user();
    const b = await user();
    const c = await community(a, { members: [b] });
    const conv = await communityConv(a, c);
    // Semua permintaan dari IP yang sama (seperti pengguna seluler di balik CGNAT).
    for (let i = 0; i < 30; i++) await sendText(a, conv, `a${i}`).expect(201);
    await sendText(a, conv, 'kebanyakan').expect(429);
    // Pengguna lain dari IP yang sama tidak ikut terkena.
    await sendText(b, conv, 'halo').expect(201);
  });

  it('chat pribadi: hanya sesama anggota komunitas, idempoten, orang ketiga 404', async () => {
    const a = await user('Ani');
    const b = await user('Budi');
    const stranger = await user('Citra');
    await community(a, { members: [b] });

    await request(t.http).post('/v1/chat/direct').set(a.auth).send({ userId: stranger.id }).expect(403);
    await request(t.http).post('/v1/chat/direct').set(a.auth).send({ userId: a.id }).expect(400);
    const dm = await request(t.http).post('/v1/chat/direct').set(a.auth).send({ userId: b.id }).expect(200);
    expect(dm.body).toMatchObject({ kind: 'direct', title: 'Budi', otherUser: { id: b.id } });
    const again = await request(t.http).post('/v1/chat/direct').set(b.auth).send({ userId: a.id }).expect(200);
    expect(again.body.id).toBe(dm.body.id);

    // Belum ada pesan: belum tampil di daftar.
    expect((await request(t.http).get('/v1/chat/conversations').set(b.auth).expect(200)).body.filter((c: { kind: string }) => c.kind === 'direct')).toEqual([]);

    const clientMsgId = randomUUID();
    const m1 = await sendText(a, dm.body.id, 'Halo Budi', clientMsgId).expect(201);
    const m2 = await sendText(a, dm.body.id, 'Halo Budi', clientMsgId).expect(201);
    expect(m2.body.id).toBe(m1.body.id);
    expect(Number((await t.pool.query('SELECT count(*) AS n FROM chat_messages')).rows[0].n)).toBe(1);

    const inbox = await request(t.http).get('/v1/chat/conversations').set(b.auth).expect(200);
    const entry = inbox.body.find((c: { kind: string }) => c.kind === 'direct');
    expect(entry).toMatchObject({ title: 'Ani', unread: 1, lastMessage: { preview: 'Halo Budi', isMine: false } });
    await request(t.http).post(`/v1/chat/conversations/${dm.body.id}/read`).set(b.auth).send({ seq: m1.body.seq }).expect(204);
    expect((await request(t.http).get('/v1/chat/conversations').set(b.auth).expect(200)).body.find((c: { kind: string }) => c.kind === 'direct').unread).toBe(0);

    await request(t.http).get(`/v1/chat/conversations/${dm.body.id}/messages`).set(stranger.auth).expect(404);
    await request(t.http).get(`/v1/chat/messages/${m1.body.id}`).set(stranger.auth).expect(404);
    await request(t.http).post(`/v1/chat/conversations/${dm.body.id}/read`).set(stranger.auth).send({ seq: '1' }).expect(404);
  });

  it('blokir: chat pribadi tertutup ke dua arah, pesan komunitas dari yang diblokir dilipat, tanpa push darinya', async () => {
    const a = await user('Ani');
    const b = await user('Budi');
    const c = await user('Citra');
    const cid = await community(a, { members: [b, c] });
    const dm = await request(t.http).post('/v1/chat/direct').set(a.auth).send({ userId: b.id }).expect(200);
    await sendText(b, dm.body.id, 'Halo Ani').expect(201);

    // Ani memblokir Budi: keduanya tidak bisa mengirim; riwayat tetap terbaca.
    await request(t.http).post(`/v1/feed/users/${b.id}/block`).set(a.auth).expect(204);
    expect((await sendText(b, dm.body.id, 'Masih bisa?').expect(403)).body.error).toBe('cannot_message');
    expect((await sendText(a, dm.body.id, 'Tidak').expect(403)).body.error).toBe('cannot_message');
    expect((await request(t.http).post('/v1/chat/direct').set(b.auth).send({ userId: a.id }).expect(403)).body.error).toBe('cannot_message');
    const hist = await request(t.http).get(`/v1/chat/conversations/${dm.body.id}/messages`).set(a.auth).expect(200);
    expect(hist.body.items[0].text).toBe('Halo Ani');
    const list = (await request(t.http).get('/v1/chat/conversations').set(a.auth).expect(200)).body;
    expect(list.find((x: { kind: string }) => x.kind === 'direct').otherUser).toMatchObject({ id: b.id, blockedByMe: true });

    // Chat komunitas: Ani tidak melihat isi pesan Budi dan tidak mendapat push/unread darinya; Citra tetap.
    const conv = await communityConv(a, cid);
    await communityConv(c, cid);
    const before = t.push.to(a.id).length;
    const m = await sendText(b, conv, 'Pesan di grup').expect(201);
    expect(t.push.to(a.id).length).toBe(before);
    expect(t.push.to(c.id).some((j) => j.data?.conversationId === conv)).toBe(true);
    const forAni = (await request(t.http).get(`/v1/chat/messages/${m.body.id}`).set(a.auth).expect(200)).body;
    expect(forAni).toMatchObject({ blocked: true });
    expect(forAni.text).toBeUndefined();
    expect((await request(t.http).get(`/v1/chat/messages/${m.body.id}`).set(c.auth).expect(200)).body.text).toBe('Pesan di grup');
    const aniConv = (await request(t.http).get('/v1/chat/conversations').set(a.auth).expect(200)).body.find((x: { id: string }) => x.id === conv);
    expect(aniConv.unread).toBe(0);
    expect(aniConv.lastMessage).toMatchObject({ preview: null, blocked: true });

    // Buka blokir: chat pribadi terbuka lagi.
    await request(t.http).delete(`/v1/feed/users/${b.id}/block`).set(a.auth).expect(204);
    await sendText(b, dm.body.id, 'Damai').expect(201);
  });

  it('hapus pesan sendiri; pesan yang sedang dilaporkan ditahan', async () => {
    const owner = await user();
    const member = await user();
    const c = await community(owner, { members: [member] });
    const conv = await communityConv(owner, c);
    const text = await sendText(owner, conv, 'salah kirim').expect(201);

    await request(t.http).delete(`/v1/chat/messages/${text.body.id}`).set(member.auth).expect(404);
    await request(t.http).delete(`/v1/chat/messages/${text.body.id}`).set(owner.auth).expect(204);
    const after = await request(t.http).get(`/v1/chat/messages/${text.body.id}`).set(member.auth).expect(200);
    expect(after.body).toMatchObject({ deleted: true });
    expect(after.body.text).toBeUndefined();
    expect((await t.pool.query('SELECT body_enc FROM chat_messages WHERE id = $1', [text.body.id])).rows[0].body_enc).toBeNull();

    const img = await request(t.http)
      .post(`/v1/chat/conversations/${conv}/images`)
      .set(owner.auth)
      .field('clientMsgId', randomUUID())
      .attach('file', await png(), 'foto.png')
      .expect(201);
    expect(t.storage.objects.size).toBe(1);
    await request(t.http).delete(`/v1/chat/messages/${img.body.id}`).set(owner.auth).expect(204);
    expect(t.storage.objects.size).toBe(0);

    const held = await sendText(owner, conv, 'dilaporkan').expect(201);
    await t.pool.query('UPDATE chat_messages SET held_at = now() WHERE id = $1', [held.body.id]);
    const res = await request(t.http).delete(`/v1/chat/messages/${held.body.id}`).set(owner.auth).expect(409);
    expect(res.body.error).toBe('message_held');
  });

  it('gambar: hanya peserta yang bisa mengambil, kedaluwarsa setelah 6 bulan, terhapus bersama komunitas', async () => {
    const owner = await user();
    const member = await user();
    const outsider = await user();
    const c = await community(owner, { members: [member] });
    const conv = await communityConv(owner, c);
    const img = await request(t.http)
      .post(`/v1/chat/conversations/${conv}/images`)
      .set(owner.auth)
      .field('clientMsgId', randomUUID())
      .attach('file', await png(), 'foto.png')
      .expect(201);
    expect(img.body.imageUrl).toBe(`/v1/chat/messages/${img.body.id}/image`);
    const got = await request(t.http).get(img.body.imageUrl).set(member.auth).expect(200);
    expect(got.headers['content-type']).toBe('image/webp');
    await request(t.http).get(img.body.imageUrl).set(outsider.auth).expect(404);

    // Bukan gambar → ditolak.
    await request(t.http)
      .post(`/v1/chat/conversations/${conv}/images`)
      .set(owner.auth)
      .field('clientMsgId', randomUUID())
      .attach('file', Buffer.from('bukan gambar'), 'x.png')
      .expect(415);

    await t.pool.query(`UPDATE chat_messages SET created_at = now() - interval '181 days' WHERE id = $1`, [img.body.id]);
    expect(await expireChatImages(t.pool, t.storage)).toBe(1);
    expect(t.storage.objects.size).toBe(0);
    const expired = await request(t.http).get(`/v1/chat/messages/${img.body.id}`).set(member.auth).expect(200);
    expect(expired.body).toMatchObject({ kind: 'image', imageExpired: true });
    expect(expired.body.imageUrl).toBeUndefined();

    // Komunitas dihapus: gambar chat-nya ikut terhapus dari penyimpanan.
    await request(t.http)
      .post(`/v1/chat/conversations/${conv}/images`)
      .set(owner.auth)
      .field('clientMsgId', randomUUID())
      .attach('file', await png(), 'foto.png')
      .expect(201);
    expect(t.storage.objects.size).toBe(1);
    await request(t.http).delete(`/v1/communities/${c}`).set(owner.auth).expect(204);
    expect(t.storage.objects.size).toBe(0);
  });

  it('ajakan lari bareng dengan tombol ikut', async () => {
    const owner = await user('Ani');
    const member = await user('Budi');
    const c = await community(owner, { members: [member] });
    const conv = await communityConv(owner, c);
    const startsAt = new Date(Date.now() + 86_400_000).toISOString();
    const inv = await request(t.http)
      .post(`/v1/chat/conversations/${conv}/messages`)
      .set(owner.auth)
      .send({ clientMsgId: randomUUID(), kind: 'run_invite', invite: { title: 'Long run Minggu', startsAt, place: 'GOR Saparua', note: '15 km santai' } })
      .expect(201);
    expect(inv.body.invite).toMatchObject({ title: 'Long run Minggu', place: 'GOR Saparua', startsAt, goingCount: 0, iAmGoing: false });

    const going = await request(t.http).post(`/v1/chat/messages/${inv.body.id}/rsvp`).set(member.auth).expect(200);
    expect(going.body.invite).toMatchObject({ goingCount: 1, iAmGoing: true, going: ['Budi'] });
    const ownerView = await request(t.http).get(`/v1/chat/messages/${inv.body.id}`).set(owner.auth).expect(200);
    expect(ownerView.body.invite).toMatchObject({ goingCount: 1, iAmGoing: false });
    const notGoing = await request(t.http).delete(`/v1/chat/messages/${inv.body.id}/rsvp`).set(member.auth).expect(200);
    expect(notGoing.body.invite.goingCount).toBe(0);

    // Waktu di masa lalu ditolak; RSVP pada pesan teks ditolak.
    await request(t.http)
      .post(`/v1/chat/conversations/${conv}/messages`)
      .set(owner.auth)
      .send({ clientMsgId: randomUUID(), kind: 'run_invite', invite: { title: 'x', startsAt: '2020-01-01T00:00:00Z', place: 'y' } })
      .expect(400);
    const text = await sendText(owner, conv, 'teks').expect(201);
    await request(t.http).post(`/v1/chat/messages/${text.body.id}/rsvp`).set(member.auth).expect(409);
  });

  it('hapus akun: pesan chat pribadi terhapus, di chat komunitas nama menjadi "Pengguna dihapus"', async () => {
    const leaving = await user('Ani');
    const friend = await user('Budi');
    const owner = await user('Citra');
    const c = await community(owner, { members: [leaving, friend] });
    const conv = await communityConv(leaving, c);
    await sendText(leaving, conv, 'pesan komunitas').expect(201);
    const dm = (await request(t.http).post('/v1/chat/direct').set(leaving.auth).send({ userId: friend.id }).expect(200)).body.id;
    await sendText(leaving, dm, 'pesan pribadi').expect(201);
    await sendText(friend, dm, 'balasan teman').expect(201);

    await request(t.http).post('/v1/me/delete').set(leaving.auth).send({ confirm: 'HAPUS' }).expect(204);

    const community_ = await request(t.http).get(`/v1/chat/conversations/${conv}/messages`).set(friend.auth).expect(200);
    expect(community_.body.items).toHaveLength(1);
    expect(community_.body.items[0]).toMatchObject({ text: 'pesan komunitas', sender: { displayName: 'Pengguna dihapus', avatarUrl: null } });
    const direct = await request(t.http).get(`/v1/chat/conversations/${dm}/messages`).set(friend.auth).expect(200);
    expect(direct.body.items.map((m: { text: string }) => m.text)).toEqual(['balasan teman']);
    // Tidak bisa mengirim ke akun yang sudah dihapus.
    await sendText(friend, dm, 'halo?').expect(404);
  });

  it('WebSocket: peserta menerima sinyal pesan baru, orang luar ditolak', async () => {
    const owner = await user();
    const member = await user();
    const outsider = await user();
    const c = await community(owner, { members: [member] });
    const conv = await communityConv(owner, c);

    const connect = (auth: Record<string, string>) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: auth });
      const msgs: Record<string, unknown>[] = [];
      ws.on('message', (raw) => msgs.push(JSON.parse(raw.toString()) as Record<string, unknown>));
      const next = async (pred: (m: Record<string, unknown>) => boolean) => {
        for (let i = 0; i < 300; i++) {
          const m = msgs.find(pred);
          if (m) return m;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error('Pesan WebSocket tidak datang');
      };
      return { ws, msgs, next };
    };

    const m = connect(member.auth);
    await m.next((x) => x.op === 'ready');
    m.ws.send(JSON.stringify({ op: 'sub', ch: `conv:${conv}` }));
    await m.next((x) => x.op === 'subscribed');

    const o = connect(outsider.auth);
    await o.next((x) => x.op === 'ready');
    o.ws.send(JSON.stringify({ op: 'sub', ch: `conv:${conv}` }));
    expect(await o.next((x) => x.op === 'error')).toMatchObject({ code: 'forbidden' });
    o.ws.send(JSON.stringify({ op: 'sub', ch: `user:${member.id}:chat` }));
    expect(await o.next((x) => x.op === 'error' && x.ch === `user:${member.id}:chat`)).toMatchObject({ code: 'forbidden' });

    const sent = await sendText(owner, conv, 'rahasia').expect(201);
    const ev = await m.next((x) => x.op === 'event');
    expect(ev).toEqual({ op: 'event', ch: `conv:${conv}`, ev: 'message.new', data: { seq: sent.body.seq } });
    // Sinyal tidak membawa isi pesan.
    expect(JSON.stringify(m.msgs)).not.toContain('rahasia');
    m.ws.close();
    o.ws.close();
  });
});
