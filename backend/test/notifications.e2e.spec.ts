import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password.js';
import { TokenService } from '../src/auth/token.service.js';
import { FieldCrypto } from '../src/crypto/field-crypto.js';
import { fcmMessage, type PushSender, sendPushJob } from '../src/notifications/push.js';
import { createTestApp, hasTestInfra, resetData, type TestApp } from './helpers.js';

const PASSWORD = 'rahasia-sekali-123';
const TOKEN = (n: number) => `fcm-token-${n}:${'a'.repeat(140)}`;

describe.skipIf(!hasTestInfra)('Modul 1.9 Notifikasi (e2e)', () => {
  let t: TestApp;
  let crypto: FieldCrypto;
  let phoneSeq = 80_000_000;
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
    t.push.jobs = [];
  });

  type U = { id: string; auth: { Authorization: string }; refreshToken: string };

  async function user(name = 'Pelari'): Promise<U> {
    const id = randomUUID();
    const email = `${id}@example.com`;
    const phone = `+62815${phoneSeq++}`;
    await t.pool.query(
      `INSERT INTO users (id, email_enc, email_bidx, email_verified_at, phone_enc, phone_bidx, phone_verified_at,
                          password_hash, display_name, privacy_accepted_at, privacy_version)
       VALUES ($1, $2, $3, now(), $4, $5, now(), $6, $7, now(), 'test')`,
      [id, crypto.encrypt(email, `users.email:${id}`), crypto.blindIndex('email', email), crypto.encrypt(phone, `users.phone:${id}`), crypto.blindIndex('phone', phone), passwordHash, name],
    );
    const tokens = await t.app.get(TokenService).issue(id, 'user');
    return { id, auth: { Authorization: `Bearer ${tokens.accessToken}` }, refreshToken: tokens.refreshToken };
  }

  async function community(owner: U, members: U[] = [], opts: { name?: string; visibility?: 'open' | 'private'; plan?: string } = {}) {
    const res = await request(t.http)
      .post('/v1/communities')
      .set(owner.auth)
      .send({ name: opts.name ?? 'Lari Pagi', city: 'Bandung', description: '', visibility: opts.visibility ?? 'open' })
      .expect(201);
    const id = res.body.id as string;
    await t.pool.query(`UPDATE communities SET plan = $2 WHERE id = $1`, [id, opts.plan ?? 'pro_unlimited']);
    for (const m of members) {
      await t.pool.query(`INSERT INTO community_members (community_id, user_id, status, joined_at) VALUES ($1, $2, 'active', now())`, [id, m.id]);
    }
    return id;
  }

  it('token push: terenkripsi, pindah akun, dihapus saat logout', async () => {
    const a = await user('Ani');
    const b = await user('Budi');
    await request(t.http).put('/v1/me/push-token').set(a.auth).send({ token: TOKEN(1) }).expect(204);
    await request(t.http).put('/v1/me/push-token').set(a.auth).send({ token: 'pendek' }).expect(400);
    const { rows } = await t.pool.query<{ user_id: string; token_enc: Buffer }>('SELECT user_id, token_enc FROM push_tokens');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_enc.toString('latin1')).not.toContain('fcm-token');

    // Perangkat yang sama login dengan akun lain: token berpindah, tidak ganda.
    await request(t.http).put('/v1/me/push-token').set(b.auth).send({ token: TOKEN(1) }).expect(204);
    expect((await t.pool.query('SELECT user_id FROM push_tokens')).rows).toEqual([{ user_id: b.id }]);

    await request(t.http).post('/v1/auth/logout').set(b.auth).send({ refreshToken: b.refreshToken }).expect(204);
    expect((await t.pool.query('SELECT 1 FROM push_tokens')).rowCount).toBe(0);
  });

  it('pesan chat: push tanpa isi pesan, menghormati pengaturan; ajakan lari masuk kotak notifikasi', async () => {
    const ani = await user('Ani');
    const budi = await user('Budi');
    const cici = await user('Cici');
    const c = await community(ani, [budi, cici]);
    const conv = (await request(t.http).get(`/v1/chat/communities/${c}`).set(ani.auth).expect(200)).body.id as string;

    await request(t.http).post(`/v1/chat/conversations/${conv}/messages`).set(ani.auth).send({ clientMsgId: randomUUID(), kind: 'text', text: 'rahasia kita' }).expect(201);
    const job = t.push.jobs.at(-1)!;
    expect(job.userIds.sort()).toEqual([budi.id, cici.id].sort());
    expect(job).toMatchObject({ title: 'Lari Pagi', body: 'Ani mengirim pesan', data: { category: 'chat', type: 'chat', conversationId: conv }, tag: `conv:${conv}` });
    expect(JSON.stringify(job)).not.toContain('rahasia');

    // Budi mematikan push chat.
    const s = await request(t.http).put('/v1/me/notification-settings').set(budi.auth).send({ chat: false }).expect(200);
    expect(s.body).toEqual({ chat: false, community: true, run_invite: true, friend_running: true, social: true });
    await request(t.http).put('/v1/me/notification-settings').set(budi.auth).send({ spam: true }).expect(400);
    await request(t.http).post(`/v1/chat/conversations/${conv}/messages`).set(ani.auth).send({ clientMsgId: randomUUID(), kind: 'text', text: 'halo' }).expect(201);
    expect(t.push.jobs.at(-1)!.userIds).toEqual([cici.id]);

    // Chat pribadi.
    const dm = (await request(t.http).post('/v1/chat/direct').set(budi.auth).send({ userId: cici.id }).expect(200)).body.id as string;
    await request(t.http).post(`/v1/chat/conversations/${dm}/messages`).set(budi.auth).send({ clientMsgId: randomUUID(), kind: 'text', text: 'x' }).expect(201);
    expect(t.push.jobs.at(-1)).toMatchObject({ userIds: [cici.id], title: 'Budi', body: 'Mengirim pesan' });

    // Ajakan lari: kategori sendiri, dan tercatat di kotak notifikasi (Budi mematikan chat, bukan ajakan).
    const invite = { title: 'Lari pagi rahasia', startsAt: new Date(Date.now() + 86_400_000).toISOString(), place: 'GBK', note: '' };
    await request(t.http).post(`/v1/chat/conversations/${conv}/messages`).set(ani.auth).send({ clientMsgId: randomUUID(), kind: 'run_invite', invite }).expect(201);
    const inv = t.push.jobs.at(-1)!;
    expect(inv).toMatchObject({ title: 'Ani mengajak lari bareng', body: 'Di Lari Pagi. Ketuk untuk ikut', data: { category: 'run_invite' } });
    expect(inv.userIds.sort()).toEqual([budi.id, cici.id].sort());
    expect(JSON.stringify(inv)).not.toContain('rahasia');
    const box = await request(t.http).get('/v1/notifications').set(budi.auth).expect(200);
    expect(box.body.unread).toBe(1);
    expect(box.body.items[0]).toMatchObject({ type: 'run_invite', read: false, actor: { id: ani.id, displayName: 'Ani' }, community: { id: c, name: 'Lari Pagi' }, data: { conversationId: conv } });
    await request(t.http).post('/v1/notifications/read').set(budi.auth).expect(204);
    expect((await request(t.http).get('/v1/notifications').set(budi.auth).expect(200)).body.unread).toBe(0);
  });

  it('undangan langsung: hanya pengguna yang dikenal admin, terima = anggota (batas paket tetap berlaku), tolak', async () => {
    const admin = await user('Admin');
    const friend = await user('Teman');
    const stranger = await user('Orang Asing');
    await community(admin, [friend], { name: 'Komunitas Lama' });
    const target = await community(admin, [], { name: 'Komunitas Baru', visibility: 'private', plan: 'free' });

    const cands = await request(t.http).get(`/v1/communities/${target}/invite-candidates`).set(admin.auth).expect(200);
    expect(cands.body).toEqual([{ id: friend.id, displayName: 'Teman', avatarUrl: null, invited: false }]);
    await request(t.http).get(`/v1/communities/${target}/invite-candidates`).set(friend.auth).expect(403);
    await request(t.http).post(`/v1/communities/${target}/invitations`).set(admin.auth).send({ userId: stranger.id }).expect(404);

    const inv = (await request(t.http).post(`/v1/communities/${target}/invitations`).set(admin.auth).send({ userId: friend.id }).expect(201)).body.id as string;
    const again = await request(t.http).post(`/v1/communities/${target}/invitations`).set(admin.auth).send({ userId: friend.id }).expect(201);
    expect(again.body.id).toBe(inv);
    expect(t.push.to(friend.id)).toHaveLength(1);
    expect(t.push.to(friend.id)[0]).toMatchObject({ title: 'Undangan komunitas', body: 'Admin mengundangmu ke Komunitas Baru' });
    const box = await request(t.http).get('/v1/notifications').set(friend.auth).expect(200);
    expect(box.body.items[0]).toMatchObject({ type: 'community_invite', data: { invitationId: inv } });

    const mine = await request(t.http).get('/v1/invitations').set(friend.auth).expect(200);
    expect(mine.body[0]).toMatchObject({ id: inv, invitedBy: { displayName: 'Admin' }, community: { id: target, name: 'Komunitas Baru' } });
    await request(t.http).post(`/v1/invitations/${inv}/accept`).set(stranger.auth).expect(404);

    const accepted = await request(t.http).post(`/v1/invitations/${inv}/accept`).set(friend.auth).expect(200);
    expect(accepted.body).toMatchObject({ id: target, myStatus: 'active' });
    expect((await request(t.http).get('/v1/invitations').set(friend.auth).expect(200)).body).toEqual([]);
    await request(t.http).post(`/v1/invitations/${inv}/accept`).set(friend.auth).expect(404);

    // Komunitas gratis maks. 3 anggota: admin + teman + satu lagi, undangan keempat ditolak saat diterima.
    const b = await user('B');
    const c2 = await user('C');
    await community(b, [admin, c2], { name: 'Komunitas Ketiga' });
    const invB = (await request(t.http).post(`/v1/communities/${target}/invitations`).set(admin.auth).send({ userId: b.id }).expect(201)).body.id;
    const invC = (await request(t.http).post(`/v1/communities/${target}/invitations`).set(admin.auth).send({ userId: c2.id }).expect(201)).body.id;
    await request(t.http).post(`/v1/invitations/${invB}/accept`).set(b.auth).expect(200);
    const full = await request(t.http).post(`/v1/invitations/${invC}/accept`).set(c2.auth).expect(403);
    expect(full.body.limit.kind).toBe('community_members');
    await request(t.http).post(`/v1/invitations/${invC}/decline`).set(c2.auth).expect(204);
    expect((await request(t.http).get('/v1/invitations').set(c2.auth).expect(200)).body).toEqual([]);
  });

  it('permintaan bergabung ke komunitas privat memberi tahu admin; disetujui memberi tahu pemohon', async () => {
    const owner = await user('Pemilik');
    const asker = await user('Pemohon');
    const c = await community(owner, [], { visibility: 'private' });
    await request(t.http).post(`/v1/communities/${c}/join`).set(asker.auth).expect(200);
    await request(t.http).post(`/v1/communities/${c}/join`).set(asker.auth).expect(200); // ulang: tidak memberi tahu lagi
    expect(t.push.to(owner.id)).toHaveLength(1);
    expect(t.push.to(owner.id)[0]).toMatchObject({ title: 'Permintaan bergabung', body: 'Pemohon ingin bergabung ke Lari Pagi', data: { communityId: c } });
    expect((await request(t.http).get('/v1/notifications').set(owner.auth).expect(200)).body.items[0]).toMatchObject({ type: 'join_request', actor: { id: asker.id } });

    await request(t.http).post(`/v1/communities/${c}/members/${asker.id}/approve`).set(owner.auth).send({}).expect(204);
    expect(t.push.to(asker.id)[0]).toMatchObject({ title: 'Permintaan diterima', body: 'Kamu sekarang anggota Lari Pagi' });
  });

  it('teman mulai lari: sekali per lari, hanya ke komunitas yang dipilih; hapus akun membersihkan notifikasi', async () => {
    const runner = await user('Ani');
    const friend = await user('Teman');
    const other = await user('Komunitas Lain');
    const chosen = await community(runner, [friend], { name: 'Pilihan' });
    await community(runner, [other], { name: 'Tidak Dipilih' });
    const runId = randomUUID();
    const status = { clientRunId: runId, communities: [{ id: chosen, showLocation: false }], startedAt: new Date().toISOString(), distanceM: 10, movingTimeS: 5, paused: false };

    await request(t.http).put('/v1/live').set(runner.auth).send(status).expect(200);
    await request(t.http).put('/v1/live').set(runner.auth).send({ ...status, distanceM: 50 }).expect(200);
    const jobs = t.push.jobs.filter((j) => j.data.category === 'friend_running');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ userIds: [friend.id], title: 'Ani mulai lari', body: 'Lihat di Pilihan', data: { communityId: chosen } });

    // Hapus akun penerima: kotak notifikasi dan pengaturannya hilang.
    await request(t.http).put('/v1/me/notification-settings').set(friend.auth).send({ friend_running: false }).expect(200);
    await request(t.http).post('/v1/me/delete').set(friend.auth).send({ password: PASSWORD, confirm: 'HAPUS' }).expect(204);
    expect((await t.pool.query('SELECT 1 FROM notification_prefs WHERE user_id = $1', [friend.id])).rowCount).toBe(0);
  });

  it('worker: kirim ke semua perangkat, token yang ditolak FCM dihapus', async () => {
    const a = await user('Ani');
    await request(t.http).put('/v1/me/push-token').set(a.auth).send({ token: TOKEN(1) }).expect(204);
    await request(t.http).put('/v1/me/push-token').set(a.auth).send({ token: TOKEN(2) }).expect(204);
    const sent: string[] = [];
    const sender: PushSender = {
      enabled: true,
      async send(token) {
        sent.push(token);
        return token === TOKEN(2) ? 'invalid_token' : 'ok';
      },
    };
    const job = { userIds: [a.id], title: 'Judul', body: 'Isi', data: { type: 'chat' }, tag: 'conv:1' };
    expect(await sendPushJob(t.pool, crypto, sender, job)).toEqual({ sent: 1, failed: 0 });
    expect(sent.sort()).toEqual([TOKEN(1), TOKEN(2)]);
    expect((await t.pool.query('SELECT 1 FROM push_tokens')).rowCount).toBe(1);
    expect(await sendPushJob(t.pool, crypto, { enabled: false, send: async () => 'ok' }, job)).toEqual({ sent: 0, skipped: true });
    expect(fcmMessage('tok', job)).toEqual({
      message: { token: 'tok', notification: { title: 'Judul', body: 'Isi' }, data: { type: 'chat' }, android: { priority: 'HIGH', notification: { tag: 'conv:1' } } },
    });
  });
});
