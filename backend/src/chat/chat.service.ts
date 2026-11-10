import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type pg from 'pg';
import { CommunitiesService } from '../communities/communities.service.js';
import { type Queryable, withTx } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { PG_POOL } from '../core.module.js';
import { FieldCrypto } from '../crypto/field-crypto.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { processImage } from '../storage/image.js';
import { StorageService } from '../storage/storage.service.js';
import { avatarPath } from '../users/users.repository.js';

export const convChannel = (id: string) => `conv:${id}`;
export const inboxChannel = (userId: string) => `user:${userId}:chat`;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const bodyAad = (messageId: string) => `chat_messages.body:${messageId}`;
const PREVIEW_CHARS = 100;
const RSVP_NAMES = 10;

export type MessageKind = 'text' | 'image' | 'run_invite';

export interface RunInvite {
  title: string;
  startsAt: string;
  place: string;
  note: string;
}

export type SendInput =
  | { clientMsgId: string; kind: 'text'; text: string }
  | { clientMsgId: string; kind: 'run_invite'; invite: RunInvite };

interface ConvAccess {
  id: string;
  kind: 'direct' | 'community';
  community_id: string | null;
  user_a: string | null;
  user_b: string | null;
  /** Pesan sebelum waktu ini tidak terlihat (anggota baru tanpa riwayat). */
  history_from: Date | null;
}

interface MessageRow {
  id: string;
  seq: string;
  conversation_id: string;
  sender_id: string;
  kind: MessageKind;
  body_enc: Buffer | null;
  image_key: string | null;
  image_expired_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  display_name: string;
  avatar_key: string | null;
  avatar_updated_at: Date | null;
}

const MSG_COLS = `m.id, m.seq, m.conversation_id, m.sender_id, m.kind, m.body_enc, m.image_key, m.image_expired_at,
  m.deleted_at, m.created_at, u.display_name, u.avatar_key, u.avatar_updated_at`;

/**
 * Chat pribadi dan komunitas. Isi pesan terenkripsi di database (FieldCrypto), tidak ujung-ke-ujung.
 * Setiap permintaan memeriksa hak akses: chat pribadi hanya untuk kedua pesertanya, chat komunitas
 * hanya untuk anggota aktif (dan hanya pesan sejak `history_from`). Yang tidak berhak mendapat 404.
 * Jangan pernah me-log isi pesan.
 */
@Injectable()
export class ChatService implements OnModuleInit {
  private readonly logger = new Logger('Chat');

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly crypto: FieldCrypto,
    private readonly storage: StorageService,
    private readonly communities: CommunitiesService,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit(): void {
    this.realtime.register(new RegExp(`^conv:(${UUID})$`), async (userId, m) => {
      try {
        await this.access(userId, m[1]!);
        return true;
      } catch {
        return false;
      }
    });
    this.realtime.register(new RegExp(`^user:(${UUID}):chat$`), async (userId, m) => userId === m[1]);
  }

  // ---------- Percakapan ----------

  /** Daftar percakapan: chat semua komunitas tempat saya aktif + chat pribadi yang sudah berisi pesan. */
  async conversations(userId: string) {
    await this.pool.query(
      `INSERT INTO conversations (kind, community_id)
       SELECT 'community', m.community_id FROM community_members m WHERE m.user_id = $1 AND m.status = 'active'
       ON CONFLICT (community_id) DO NOTHING`,
      [userId],
    );
    return this.querySummaries(userId);
  }

  async conversation(userId: string, convId: string) {
    await this.access(userId, convId);
    const [summary] = await this.querySummaries(userId, convId);
    if (!summary) throw notFound();
    return summary;
  }

  /** Percakapan komunitas (dibuat jika belum ada). Hanya anggota aktif. */
  async communityConversation(userId: string, communityId: string) {
    if (!(await this.isActiveMember(this.pool, userId, communityId))) throw notFound();
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO conversations (kind, community_id) VALUES ('community', $1)
       ON CONFLICT (community_id) DO UPDATE SET community_id = EXCLUDED.community_id RETURNING id`,
      [communityId],
    );
    return this.conversation(userId, rows[0]!.id);
  }

  /** Buka (atau buat) chat pribadi. Hanya dengan sesama anggota aktif satu komunitas (anti-spam). */
  async direct(userId: string, otherId: string) {
    if (otherId === userId) throw new ApiError(400, 'invalid_target', 'Tidak bisa mengobrol dengan diri sendiri');
    await this.assertCanDirect(userId, otherId);
    const [a, b] = userId < otherId ? [userId, otherId] : [otherId, userId];
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO conversations (kind, user_a, user_b) VALUES ('direct', $1, $2)
       ON CONFLICT (user_a, user_b) DO UPDATE SET user_a = EXCLUDED.user_a RETURNING id`,
      [a, b],
    );
    return this.conversation(userId, rows[0]!.id);
  }

  // ---------- Pesan ----------

  /**
   * Riwayat bertahap. Tanpa kursor: pesan terbaru. `before`: pesan lebih lama dari seq itu.
   * `after`: pesan baru setelah seq itu (sinkronisasi setelah sinyal WebSocket). Hasil selalu urut naik.
   */
  async messages(userId: string, convId: string, q: { before?: string; after?: string; limit: number }) {
    const conv = await this.access(userId, convId);
    const params: unknown[] = [convId, conv.history_from, q.limit + 1];
    let cursor = '';
    let order = 'DESC';
    if (q.after) {
      params.push(q.after);
      cursor = `AND m.seq > $${params.length}`;
      order = 'ASC';
    } else if (q.before) {
      params.push(q.before);
      cursor = `AND m.seq < $${params.length}`;
    }
    const { rows } = await this.pool.query<MessageRow>(
      `SELECT ${MSG_COLS} FROM chat_messages m JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = $1 AND ($2::timestamptz IS NULL OR m.created_at >= $2) ${cursor}
        ORDER BY m.seq ${order} LIMIT $3`,
      params,
    );
    const hasMore = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    if (order === 'DESC') page.reverse();
    return { items: await this.toMessages(userId, page), hasMore };
  }

  async message(userId: string, messageId: string) {
    const row = await this.visibleMessage(userId, messageId);
    return (await this.toMessages(userId, [row]))[0]!;
  }

  async send(userId: string, convId: string, input: SendInput) {
    const conv = await this.access(userId, convId);
    await this.assertCanSend(userId, conv);
    const existing = await this.byClientId(userId, input.clientMsgId);
    if (existing) return this.message(userId, existing);

    const id = randomUUID();
    const plaintext = input.kind === 'text' ? input.text : JSON.stringify(input.invite);
    return this.insert(userId, conv, { id, clientMsgId: input.clientMsgId, kind: input.kind, body: this.crypto.encrypt(plaintext, bodyAad(id)) });
  }

  async sendImage(userId: string, convId: string, clientMsgId: string, file: Buffer) {
    const conv = await this.access(userId, convId);
    await this.assertCanSend(userId, conv);
    const existing = await this.byClientId(userId, clientMsgId);
    if (existing) return this.message(userId, existing);

    const webp = await processImage(file, { size: 1600 });
    const id = randomUUID();
    const key = `chat/${conv.id}/${id}.webp`;
    await this.storage.put(key, webp, 'image/webp');
    try {
      return await this.insert(userId, conv, { id, clientMsgId, kind: 'image', imageKey: key });
    } catch (err) {
      await this.storage.delete(key).catch(() => undefined);
      throw err;
    }
  }

  /** Hapus pesan sendiri. Pesan yang sedang dilaporkan ditahan sampai laporannya selesai (modul 1.8). */
  async remove(userId: string, messageId: string): Promise<void> {
    const outcome = await withTx(this.pool, async (db) => {
      const { rows } = await db.query<{ sender_id: string; conversation_id: string; image_key: string | null; deleted_at: Date | null; held_at: Date | null }>(
        'SELECT sender_id, conversation_id, image_key, deleted_at, held_at FROM chat_messages WHERE id = $1 FOR UPDATE',
        [messageId],
      );
      const m = rows[0];
      if (!m || m.sender_id !== userId) throw notFound();
      if (m.deleted_at) return undefined;
      if (m.held_at) throw new ApiError(409, 'message_held', 'Pesan ini sedang ditinjau karena dilaporkan dan belum bisa dihapus');
      await db.query('UPDATE chat_messages SET deleted_at = now(), body_enc = NULL, image_key = NULL WHERE id = $1', [messageId]);
      await db.query('DELETE FROM chat_run_invite_rsvps WHERE message_id = $1', [messageId]);
      return m;
    });
    if (!outcome) return;
    if (outcome.image_key) await this.storage.delete(outcome.image_key).catch(() => this.logger.warn('Gagal menghapus gambar chat'));
    await this.realtime.publish(convChannel(outcome.conversation_id), 'message.updated', { id: messageId });
  }

  async rsvp(userId: string, messageId: string, going: boolean) {
    const row = await this.visibleMessage(userId, messageId);
    if (row.kind !== 'run_invite' || row.deleted_at) throw new ApiError(409, 'not_run_invite', 'Pesan ini bukan ajakan lari');
    if (going) {
      await this.pool.query('INSERT INTO chat_run_invite_rsvps (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [messageId, userId]);
    } else {
      await this.pool.query('DELETE FROM chat_run_invite_rsvps WHERE message_id = $1 AND user_id = $2', [messageId, userId]);
    }
    await this.realtime.publish(convChannel(row.conversation_id), 'message.updated', { id: messageId });
    return this.message(userId, messageId);
  }

  async imageFile(userId: string, messageId: string) {
    const row = await this.visibleMessage(userId, messageId);
    return row.image_key ? this.storage.get(row.image_key) : undefined;
  }

  async markRead(userId: string, convId: string, seq: string): Promise<void> {
    await this.access(userId, convId);
    await this.pool.query(
      `INSERT INTO chat_reads (conversation_id, user_id, last_read_seq) VALUES ($1, $2, $3)
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_seq = GREATEST(chat_reads.last_read_seq, EXCLUDED.last_read_seq)`,
      [convId, userId, seq],
    );
  }

  /**
   * Hapus akun (dalam transaksi yang sama): pesan pengguna di chat pribadi dihapus; di chat komunitas
   * pesannya tetap dan namanya otomatis menjadi "Pengguna dihapus" (users.display_name dianonimkan).
   * Mengembalikan kunci gambar untuk dihapus dari penyimpanan.
   */
  async onAccountDeletion(db: Queryable, userId: string): Promise<string[]> {
    const { rows } = await db.query<{ image_key: string | null }>(
      `DELETE FROM chat_messages m USING conversations c
        WHERE m.conversation_id = c.id AND c.kind = 'direct' AND m.sender_id = $1
        RETURNING m.image_key`,
      [userId],
    );
    await db.query('DELETE FROM chat_run_invite_rsvps WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM chat_reads WHERE user_id = $1', [userId]);
    return rows.map((r) => r.image_key).filter((k): k is string => Boolean(k));
  }

  // ---------- Bantuan ----------

  /** Hak akses ke percakapan. Bukan peserta = 404 (seolah tidak ada). */
  private async access(userId: string, convId: string): Promise<ConvAccess> {
    const { rows } = await this.pool.query<ConvAccess & { member_status: string | null }>(
      `SELECT c.id, c.kind, c.community_id, c.user_a, c.user_b, m.history_from, m.status AS member_status
         FROM conversations c
         LEFT JOIN community_members m ON c.kind = 'community' AND m.community_id = c.community_id AND m.user_id = $2
        WHERE c.id = $1`,
      [convId, userId],
    );
    const c = rows[0];
    if (!c) throw notFound();
    if (c.kind === 'direct' && c.user_a !== userId && c.user_b !== userId) throw notFound();
    if (c.kind === 'community' && c.member_status !== 'active') throw notFound();
    return c;
  }

  /** Pesan yang boleh dilihat pengguna (percakapan bisa diakses dan pesan dalam rentang riwayatnya). */
  private async visibleMessage(userId: string, messageId: string): Promise<MessageRow> {
    const { rows } = await this.pool.query<MessageRow>(
      `SELECT ${MSG_COLS} FROM chat_messages m JOIN users u ON u.id = m.sender_id WHERE m.id = $1`,
      [messageId],
    );
    const row = rows[0];
    if (!row) throw messageNotFound();
    let conv: ConvAccess;
    try {
      conv = await this.access(userId, row.conversation_id);
    } catch {
      throw messageNotFound();
    }
    if (conv.history_from && row.created_at < conv.history_from) throw messageNotFound();
    return row;
  }

  private async assertCanSend(userId: string, conv: ConvAccess) {
    if (conv.kind !== 'direct') return;
    await this.assertCanDirect(userId, conv.user_a === userId ? conv.user_b! : conv.user_a!);
  }

  /**
   * Chat pribadi hanya dengan pengguna aktif yang sama-sama anggota aktif minimal satu komunitas.
   * Riwayat lama tetap bisa dibaca walau sudah tidak satu komunitas, tetapi tidak bisa mengirim lagi.
   */
  private async assertCanDirect(userId: string, otherId: string) {
    const { rows } = await this.pool.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [otherId]);
    if (rows[0]?.status !== 'active') throw new ApiError(404, 'user_not_found', 'Pengguna tidak ditemukan');
    if (!(await this.communities.shareCommunity(userId, otherId))) {
      throw new ApiError(403, 'no_shared_community', 'Chat pribadi hanya bisa dengan sesama anggota komunitasmu');
    }
  }

  private async isActiveMember(db: Queryable, userId: string, communityId: string): Promise<boolean> {
    const { rowCount } = await db.query(
      `SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2 AND status = 'active'`,
      [communityId, userId],
    );
    return (rowCount ?? 0) > 0;
  }

  private async byClientId(userId: string, clientMsgId: string): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ id: string }>('SELECT id FROM chat_messages WHERE sender_id = $1 AND client_msg_id = $2', [
      userId,
      clientMsgId,
    ]);
    return rows[0]?.id;
  }

  private async insert(
    userId: string,
    conv: ConvAccess,
    m: { id: string; clientMsgId: string; kind: MessageKind; body?: Buffer; imageKey?: string },
  ) {
    let seq: string;
    try {
      seq = await withTx(this.pool, async (db) => {
        const { rows } = await db.query<{ seq: string }>(
          `INSERT INTO chat_messages (id, conversation_id, sender_id, client_msg_id, kind, body_enc, image_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING seq`,
          [m.id, conv.id, userId, m.clientMsgId, m.kind, m.body ?? null, m.imageKey ?? null],
        );
        await db.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [conv.id]);
        // Pesan sendiri dianggap sudah dibaca.
        await db.query(
          `INSERT INTO chat_reads (conversation_id, user_id, last_read_seq) VALUES ($1, $2, $3)
           ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_seq = GREATEST(chat_reads.last_read_seq, EXCLUDED.last_read_seq)`,
          [conv.id, userId, rows[0]!.seq],
        );
        return rows[0]!.seq;
      });
    } catch (err) {
      // Kiriman ganda bersamaan dengan clientMsgId sama: kembalikan yang sudah tersimpan.
      if ((err as { code?: string }).code === '23505') {
        const again = await this.byClientId(userId, m.clientMsgId);
        if (again) {
          if (m.imageKey) await this.storage.delete(m.imageKey).catch(() => undefined);
          return this.message(userId, again);
        }
      }
      throw err;
    }
    await this.realtime.publish(convChannel(conv.id), 'message.new', { seq });
    if (conv.kind === 'direct') {
      await Promise.all([conv.user_a!, conv.user_b!].map((u) => this.realtime.publish(inboxChannel(u), 'inbox.changed')));
    }
    return this.message(userId, m.id);
  }

  private async toMessages(viewerId: string, rows: MessageRow[]) {
    const inviteIds = rows.filter((r) => r.kind === 'run_invite' && !r.deleted_at).map((r) => r.id);
    const rsvps = new Map<string, { count: number; mine: boolean; names: string[] }>();
    if (inviteIds.length) {
      const { rows: rs } = await this.pool.query<{ message_id: string; user_id: string; display_name: string }>(
        `SELECT r.message_id, r.user_id, u.display_name FROM chat_run_invite_rsvps r JOIN users u ON u.id = r.user_id
          WHERE r.message_id = ANY($1::uuid[]) AND u.status = 'active' ORDER BY r.created_at`,
        [inviteIds],
      );
      for (const r of rs) {
        const e = rsvps.get(r.message_id) ?? { count: 0, mine: false, names: [] };
        e.count++;
        if (r.user_id === viewerId) e.mine = true;
        if (e.names.length < RSVP_NAMES) e.names.push(r.display_name);
        rsvps.set(r.message_id, e);
      }
    }
    return rows.map((r) => {
      const base = {
        id: r.id,
        seq: r.seq,
        conversationId: r.conversation_id,
        sender: { id: r.sender_id, displayName: r.display_name, avatarUrl: avatarPath({ id: r.sender_id, avatar_key: r.avatar_key, avatar_updated_at: r.avatar_updated_at }) },
        isMine: r.sender_id === viewerId,
        kind: r.kind,
        createdAt: r.created_at.toISOString(),
        deleted: Boolean(r.deleted_at),
      };
      if (r.deleted_at) return base;
      switch (r.kind) {
        case 'text':
          return { ...base, text: this.decrypt(r) };
        case 'image':
          return r.image_key
            ? { ...base, imageUrl: `/v1/chat/messages/${r.id}/image` }
            : { ...base, imageExpired: Boolean(r.image_expired_at) };
        case 'run_invite': {
          const e = rsvps.get(r.id) ?? { count: 0, mine: false, names: [] };
          return { ...base, invite: { ...(JSON.parse(this.decrypt(r)) as RunInvite), goingCount: e.count, iAmGoing: e.mine, going: e.names } };
        }
      }
    });
  }

  private decrypt(r: { id: string; body_enc: Buffer | null }): string {
    return r.body_enc ? this.crypto.decryptString(r.body_enc, bodyAad(r.id)) : '';
  }

  private async querySummaries(userId: string, onlyId?: string) {
    const params: unknown[] = [userId];
    let filter = `((c.kind = 'community' AND mem.status = 'active') OR (c.kind = 'direct' AND (c.user_a = $1 OR c.user_b = $1) AND c.last_message_at IS NOT NULL))`;
    if (onlyId) {
      params.push(onlyId);
      filter = `c.id = $2`;
    }
    const { rows } = await this.pool.query<{
      id: string;
      kind: 'direct' | 'community';
      community_id: string | null;
      community_name: string | null;
      logo_key: string | null;
      logo_updated_at: Date | null;
      other_id: string | null;
      other_name: string | null;
      other_avatar_key: string | null;
      other_avatar_updated_at: Date | null;
      other_status: string | null;
      unread: string;
      lm_id: string | null;
      lm_kind: MessageKind | null;
      lm_body: Buffer | null;
      lm_deleted: Date | null;
      lm_created: Date | null;
      lm_sender: string | null;
      lm_sender_name: string | null;
    }>(
      `SELECT c.id, c.kind, c.community_id, cm.name AS community_name, cm.logo_key, cm.logo_updated_at,
              o.id AS other_id, o.display_name AS other_name, o.avatar_key AS other_avatar_key,
              o.avatar_updated_at AS other_avatar_updated_at, o.status AS other_status,
              (SELECT count(*) FROM chat_messages x
                WHERE x.conversation_id = c.id AND x.seq > COALESCE(r.last_read_seq, 0) AND x.sender_id <> $1
                  AND x.deleted_at IS NULL AND (mem.history_from IS NULL OR x.created_at >= mem.history_from)) AS unread,
              lm.id AS lm_id, lm.kind AS lm_kind, lm.body_enc AS lm_body, lm.deleted_at AS lm_deleted,
              lm.created_at AS lm_created, lm.sender_id AS lm_sender, lu.display_name AS lm_sender_name
         FROM conversations c
         LEFT JOIN community_members mem ON c.kind = 'community' AND mem.community_id = c.community_id AND mem.user_id = $1
         LEFT JOIN communities cm ON cm.id = c.community_id
         LEFT JOIN users o ON c.kind = 'direct' AND o.id = CASE WHEN c.user_a = $1 THEN c.user_b ELSE c.user_a END
         LEFT JOIN chat_reads r ON r.conversation_id = c.id AND r.user_id = $1
         LEFT JOIN LATERAL (
           SELECT x.id, x.kind, x.body_enc, x.deleted_at, x.created_at, x.sender_id FROM chat_messages x
            WHERE x.conversation_id = c.id AND (mem.history_from IS NULL OR x.created_at >= mem.history_from)
            ORDER BY x.seq DESC LIMIT 1
         ) lm ON true
         LEFT JOIN users lu ON lu.id = lm.sender_id
        WHERE ${filter}
        ORDER BY lm.created_at DESC NULLS LAST, cm.name`,
      params,
    );
    return rows.map((r) => {
      let preview: string | null = null;
      if (r.lm_id && !r.lm_deleted && r.lm_kind === 'text') preview = this.decrypt({ id: r.lm_id, body_enc: r.lm_body }).slice(0, PREVIEW_CHARS);
      if (r.lm_id && !r.lm_deleted && r.lm_kind === 'run_invite') {
        preview = (JSON.parse(this.decrypt({ id: r.lm_id, body_enc: r.lm_body })) as RunInvite).title.slice(0, PREVIEW_CHARS);
      }
      return {
        id: r.id,
        kind: r.kind,
        communityId: r.community_id,
        title: r.kind === 'community' ? r.community_name! : r.other_name!,
        avatarUrl:
          r.kind === 'community'
            ? r.logo_key
              ? `/v1/communities/${r.community_id}/logo?v=${r.logo_updated_at?.getTime() ?? 0}`
              : null
            : avatarPath({ id: r.other_id!, avatar_key: r.other_avatar_key, avatar_updated_at: r.other_avatar_updated_at }),
        otherUser: r.kind === 'direct' ? { id: r.other_id!, active: r.other_status === 'active' } : null,
        unread: Number(r.unread),
        lastMessage: r.lm_id
          ? {
              kind: r.lm_kind!,
              preview,
              deleted: Boolean(r.lm_deleted),
              isMine: r.lm_sender === userId,
              senderName: r.lm_sender_name,
              createdAt: r.lm_created!.toISOString(),
            }
          : null,
      };
    });
  }
}

function notFound() {
  return new ApiError(404, 'conversation_not_found', 'Percakapan tidak ditemukan');
}

function messageNotFound() {
  return new ApiError(404, 'message_not_found', 'Pesan tidak ditemukan');
}
