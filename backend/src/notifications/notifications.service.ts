import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type pg from 'pg';
import type { Queryable } from '../common/db.js';
import { PG_POOL } from '../core.module.js';
import { FieldCrypto } from '../crypto/field-crypto.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { avatarPath } from '../users/users.repository.js';
import { hashPushToken, PushQueue, pushTokenAad } from './push.js';

/**
 * Kategori pengaturan push (PRD 1.9: pesan baru, undangan komunitas, ajakan lari, teman mulai lari;
 * modul 2.1: social = pengikut baru, suka, dan komentar di feed; modul 2.2: achievement = lencana baru;
 * modul 2.4: event = kiriman event disetujui/ditolak).
 */
export const NOTIF_CATEGORIES = ['chat', 'community', 'run_invite', 'friend_running', 'social', 'achievement', 'event'] as const;
export type NotifCategory = (typeof NOTIF_CATEGORIES)[number];

/** Jenis entri di kotak notifikasi aplikasi. Pesan chat biasa dan teman mulai lari hanya push. */
export type InboxType = 'community_invite' | 'join_request' | 'join_approved' | 'run_invite' | 'new_follower' | 'post_like' | 'post_comment' | 'badge_earned'
  | 'event_submission_approved'
  | 'event_submission_rejected';

export const notifChannel = (userId: string) => `user:${userId}:notif`;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PAGE = 50;

export interface NotifyInput {
  category: NotifCategory;
  actorId?: string;
  communityId?: string;
  /** Diisi = juga dicatat di kotak notifikasi aplikasi. */
  inbox?: { type: InboxType; data?: Record<string, string> };
  push: { title: string; body: string; data: Record<string, string>; tag?: string };
}

/**
 * Notifikasi: kotak notifikasi di aplikasi (selalu) dan push FCM (jika pengguna tidak mematikan
 * kategorinya dan FCM dikonfigurasi). Push hanya berisi judul/teks singkat dan id — isi chat tidak
 * pernah dikirim ke Google. Kegagalan notifikasi tidak pernah menggagalkan permintaan asal.
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger('Notifications');

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly crypto: FieldCrypto,
    private readonly realtime: RealtimeService,
    private readonly queue: PushQueue,
  ) {}

  onModuleInit(): void {
    this.realtime.register(new RegExp(`^user:(${UUID}):notif$`), async (userId, m) => userId === m[1]);
  }

  /** Kirim ke [recipients] (pelaku dan akun nonaktif dibuang). Tidak pernah melempar galat. */
  async notify(recipients: string[], n: NotifyInput): Promise<void> {
    try {
      const ids = [...new Set(recipients)].filter((id) => id !== n.actorId);
      if (ids.length === 0) return;
      const { rows } = await this.pool.query<{ id: string; push_off: boolean }>(
        `SELECT u.id, COALESCE($2 = ANY(p.disabled), false) AS push_off
           FROM users u LEFT JOIN notification_prefs p ON p.user_id = u.id
          WHERE u.id = ANY($1::uuid[]) AND u.status = 'active'`,
        [ids, n.category],
      );
      if (rows.length === 0) return;
      if (n.inbox) {
        await this.pool.query(
          `INSERT INTO notifications (user_id, type, actor_id, community_id, data)
           SELECT unnest($1::uuid[]), $2, $3, $4, $5`,
          [rows.map((r) => r.id), n.inbox.type, n.actorId ?? null, n.communityId ?? null, JSON.stringify(n.inbox.data ?? {})],
        );
        await Promise.all(rows.map((r) => this.realtime.publish(notifChannel(r.id), 'notif.new')));
      }
      const pushTo = rows.filter((r) => !r.push_off).map((r) => r.id);
      await this.queue.enqueue({ userIds: pushTo, title: n.push.title, body: n.push.body, data: { category: n.category, ...n.push.data }, tag: n.push.tag });
    } catch (err) {
      this.logger.warn(`Gagal membuat notifikasi (${n.category}): ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  /** Nama pelaku dan komunitas untuk teks push. */
  async labels(actorId?: string, communityId?: string): Promise<{ actor: string; community: string }> {
    const { rows } = await this.pool.query<{ actor: string | null; community: string | null }>(
      `SELECT (SELECT display_name FROM users WHERE id = $1) AS actor, (SELECT name FROM communities WHERE id = $2) AS community`,
      [actorId ?? null, communityId ?? null],
    );
    return { actor: rows[0]?.actor ?? 'Seseorang', community: rows[0]?.community ?? 'komunitas' };
  }

  // ---------- Kotak notifikasi ----------

  async list(userId: string, before?: string) {
    const params: unknown[] = [userId, PAGE + 1];
    let cursor = '';
    if (before) {
      params.push(before);
      cursor = `AND n.created_at < (SELECT created_at FROM notifications WHERE id = $3 AND user_id = $1)`;
    }
    const { rows } = await this.pool.query<{
      id: string;
      type: InboxType;
      data: Record<string, string>;
      created_at: Date;
      read_at: Date | null;
      actor_id: string | null;
      actor_name: string | null;
      avatar_key: string | null;
      avatar_updated_at: Date | null;
      community_id: string | null;
      community_name: string | null;
      community_removed: boolean | null;
    }>(
      `SELECT n.id, n.type, n.data, n.created_at, n.read_at, n.actor_id, u.display_name AS actor_name, u.avatar_key, u.avatar_updated_at,
              n.community_id, c.name AS community_name, c.removed_at IS NOT NULL AS community_removed
         FROM notifications n
         LEFT JOIN users u ON u.id = n.actor_id
         LEFT JOIN communities c ON c.id = n.community_id
        WHERE n.user_id = $1 ${cursor}
        ORDER BY n.created_at DESC, n.id DESC LIMIT $2`,
      params,
    );
    const page = rows.slice(0, PAGE).filter((r) => !r.community_removed);
    return {
      items: page.map((r) => ({
        id: r.id,
        type: r.type,
        createdAt: r.created_at.toISOString(),
        read: Boolean(r.read_at),
        actor: r.actor_id
          ? { id: r.actor_id, displayName: r.actor_name, avatarUrl: avatarPath({ id: r.actor_id, avatar_key: r.avatar_key, avatar_updated_at: r.avatar_updated_at }) }
          : null,
        community: r.community_id ? { id: r.community_id, name: r.community_name } : null,
        data: r.data,
      })),
      unread: await this.unread(userId),
      hasMore: rows.length > PAGE,
    };
  }

  async unread(userId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>('SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId]);
    return Number(rows[0]!.n);
  }

  async markAllRead(userId: string): Promise<void> {
    await this.pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [userId]);
  }

  // ---------- Pengaturan ----------

  async settings(userId: string): Promise<Record<NotifCategory, boolean>> {
    const { rows } = await this.pool.query<{ disabled: string[] }>('SELECT disabled FROM notification_prefs WHERE user_id = $1', [userId]);
    const off = new Set(rows[0]?.disabled ?? []);
    return Object.fromEntries(NOTIF_CATEGORIES.map((c) => [c, !off.has(c)])) as Record<NotifCategory, boolean>;
  }

  async updateSettings(userId: string, patch: Partial<Record<NotifCategory, boolean>>) {
    const current = await this.settings(userId);
    const next = { ...current, ...patch };
    const disabled = NOTIF_CATEGORIES.filter((c) => !next[c]);
    await this.pool.query(
      `INSERT INTO notification_prefs (user_id, disabled) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET disabled = EXCLUDED.disabled, updated_at = now()`,
      [userId, disabled],
    );
    return next;
  }

  // ---------- Token perangkat ----------

  /** Daftarkan token FCM perangkat ke sesi login saat ini. Token yang pindah akun ikut berpindah. */
  async registerToken(userId: string, sessionId: string, token: string): Promise<void> {
    const hash = hashPushToken(token);
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO push_tokens (user_id, session_id, token_hash, token_enc) VALUES ($1, $2, $3, '\\x00')
       ON CONFLICT (token_hash) DO UPDATE SET user_id = EXCLUDED.user_id, session_id = EXCLUDED.session_id, updated_at = now()
       RETURNING id`,
      [userId, sessionId, hash],
    );
    const id = rows[0]!.id;
    await this.pool.query('UPDATE push_tokens SET token_enc = $2 WHERE id = $1', [id, this.crypto.encrypt(token, pushTokenAad(id))]);
  }

  async removeToken(userId: string, token: string): Promise<void> {
    await this.pool.query('DELETE FROM push_tokens WHERE user_id = $1 AND token_hash = $2', [userId, hashPushToken(token)]);
  }

  /** Hapus akun: notifikasi, pengaturan, dan undangan milik pengguna dihapus (token sudah dihapus bersama sesi). */
  async onAccountDeletion(db: Queryable, userId: string): Promise<void> {
    await db.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM notification_prefs WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM push_tokens WHERE user_id = $1', [userId]);
    await db.query(`UPDATE community_invitations SET status = 'cancelled', decided_at = now() WHERE user_id = $1 AND status = 'pending'`, [userId]);
  }
}
