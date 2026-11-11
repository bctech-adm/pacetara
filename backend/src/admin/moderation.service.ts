import { Inject, Injectable, Logger } from '@nestjs/common';
import type pg from 'pg';
import { TokenService } from '../auth/token.service.js';
import { convChannel } from '../chat/chat.service.js';
import { withTx } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { PG_POOL } from '../core.module.js';
import { FieldCrypto } from '../crypto/field-crypto.js';
import { LiveService } from '../live/live.service.js';
import { commentBodyAad, postBodyAad } from '../feed/feed.service.js';
import { reportDetailsAad, type ReportTarget } from '../moderation/reports.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { StorageService } from '../storage/storage.service.js';
import { UsersRepository } from '../users/users.repository.js';
import { audit } from './admin-auth.service.js';

export const appealAad = (id: string) => `appeals.message:${id}`;
const bodyAad = (messageId: string) => `chat_messages.body:${messageId}`;
const CONTEXT_MESSAGES = 10;

/**
 * Tindakan super admin. Setiap tindakan dan setiap kali isi chat dibuka tercatat di admin_audit_log.
 * Super admin hanya bisa membuka chat yang dilaporkan: isi pesan (dan konteks di sekitarnya) hanya
 * tersedia untuk pesan yang punya laporan.
 */
@Injectable()
export class ModerationService {
  private readonly logger = new Logger('Moderation');

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly crypto: FieldCrypto,
    private readonly tokens: TokenService,
    private readonly live: LiveService,
    private readonly storage: StorageService,
    private readonly realtime: RealtimeService,
    private readonly users: UsersRepository,
  ) {}

  // ---------- Antrean laporan ----------

  async queue(status: 'open' | 'closed') {
    const { rows } = await this.pool.query<{
      target_type: ReportTarget;
      target_id: string;
      reports: string;
      reporters: string;
      reasons: string[];
      first_at: Date;
      last_at: Date;
      statuses: string[];
    }>(
      `SELECT target_type, target_id, count(*) AS reports, count(DISTINCT reporter_id) AS reporters,
              array_agg(DISTINCT reason) AS reasons, min(created_at) AS first_at, max(created_at) AS last_at,
              array_agg(DISTINCT status) AS statuses
         FROM reports
        WHERE ${status === 'open' ? `status = 'open'` : `status <> 'open' AND resolved_at > now() - interval '30 days'`}
        GROUP BY target_type, target_id
        ORDER BY ${status === 'open' ? 'count(DISTINCT reporter_id) DESC, min(created_at)' : 'max(resolved_at) DESC'}
        LIMIT 200`,
    );
    const labels = await this.labels(rows.map((r) => ({ type: r.target_type, id: r.target_id })));
    return rows.map((r) => ({
      targetType: r.target_type,
      targetId: r.target_id,
      label: labels.get(`${r.target_type}:${r.target_id}`) ?? '(tidak ditemukan)',
      reports: Number(r.reports),
      reporters: Number(r.reporters),
      reasons: r.reasons,
      statuses: r.statuses,
      firstAt: r.first_at.toISOString(),
      lastAt: r.last_at.toISOString(),
    }));
  }

  /** Detail sasaran laporan. Membuka isi pesan dicatat di log. */
  async target(adminId: string, type: ReportTarget, id: string) {
    const { rows: reports } = await this.pool.query<{
      id: string;
      reason: string;
      details_enc: Buffer | null;
      status: string;
      created_at: Date;
      reporter_id: string;
      reporter_name: string;
    }>(
      `SELECT r.id, r.reason, r.details_enc, r.status, r.created_at, r.reporter_id, u.display_name AS reporter_name
         FROM reports r JOIN users u ON u.id = r.reporter_id
        WHERE r.target_type = $1 AND r.target_id = $2 ORDER BY r.created_at DESC LIMIT 100`,
      [type, id],
    );
    if (reports.length === 0) throw new ApiError(404, 'no_reports', 'Tidak ada laporan untuk konten ini');

    let target: unknown;
    if (type === 'message') {
      target = await this.messageWithContext(id);
      await audit(this.pool, adminId, 'report.view_message', { type: 'message', id });
    } else if (type === 'community') {
      const { rows } = await this.pool.query<{
        name: string;
        city: string;
        description: string;
        member_count: number;
        owner_id: string;
        owner_name: string;
        hidden_at: Date | null;
        removed_at: Date | null;
      }>(
        `SELECT c.name, c.city, c.description, c.member_count, c.owner_id, u.display_name AS owner_name, c.hidden_at, c.removed_at
           FROM communities c JOIN users u ON u.id = c.owner_id WHERE c.id = $1`,
        [id],
      );
      const c = rows[0];
      target = c
        ? {
            id,
            name: c.name,
            city: c.city,
            description: c.description,
            memberCount: c.member_count,
            owner: { id: c.owner_id, displayName: c.owner_name },
            hidden: Boolean(c.hidden_at),
            removed: Boolean(c.removed_at),
          }
        : null;
    } else if (type === 'post') {
      target = await this.postSummary(id);
      await audit(this.pool, adminId, 'report.view_post', { type: 'post', id });
    } else if (type === 'comment') {
      target = await this.commentSummary(id);
      await audit(this.pool, adminId, 'report.view_comment', { type: 'comment', id });
    } else if (type === 'user') {
      target = await this.userSummary(id);
    } else if (type === 'event') {
      const { rows } = await this.pool.query<{
        name: string;
        date: string;
        city: string;
        venue: string;
        description: string;
        registration_url: string;
        hidden_at: Date | null;
        removed_at: Date | null;
      }>(
        `SELECT name, to_char(event_date, 'YYYY-MM-DD') AS date, city, venue, description, registration_url, hidden_at, removed_at
           FROM events WHERE id = $1`,
        [id],
      );
      const e = rows[0];
      target = e
        ? {
            id,
            name: e.name,
            date: e.date,
            city: e.city,
            venue: e.venue,
            description: e.description,
            registrationUrl: e.registration_url,
            hidden: Boolean(e.hidden_at),
            removed: Boolean(e.removed_at),
          }
        : null;
    }

    return {
      targetType: type,
      targetId: id,
      target,
      reports: reports.map((r) => ({
        id: r.id,
        reason: r.reason,
        details: r.details_enc ? this.crypto.decryptString(r.details_enc, reportDetailsAad(r.id)) : null,
        status: r.status,
        createdAt: r.created_at.toISOString(),
        reporter: { id: r.reporter_id, displayName: r.reporter_name },
      })),
    };
  }

  /** Selesaikan semua laporan terbuka untuk satu sasaran: abaikan, atau turunkan kontennya. */
  async resolve(adminId: string, type: ReportTarget, id: string, action: 'dismiss' | 'remove', note?: string) {
    if (action === 'remove' && type === 'user') {
      throw new ApiError(400, 'use_account_action', 'Untuk pengguna, pakai tangguhkan atau blokir akun');
    }
    const outcome = await withTx(this.pool, async (db) => {
      const { rowCount } = await db.query(
        `UPDATE reports SET status = $3, resolved_at = now(), resolved_by = $4
          WHERE target_type = $1 AND target_id = $2 AND status = 'open'`,
        [type, id, action === 'remove' ? 'actioned' : 'dismissed', adminId],
      );
      if (!rowCount) throw new ApiError(404, 'no_open_reports', 'Tidak ada laporan terbuka untuk konten ini');

      let imageKey: string | null = null;
      let photoKeys: string[] = [];
      let conversationId: string | null = null;
      if (type === 'message') {
        if (action === 'remove') {
          const { rows } = await db.query<{ image_key: string | null; conversation_id: string }>(
            `UPDATE chat_messages m SET deleted_at = COALESCE(m.deleted_at, now()), body_enc = NULL, image_key = NULL,
                    removed_by_admin = true, held_at = NULL, hidden_at = NULL
               FROM chat_messages old WHERE old.id = m.id AND m.id = $1
             RETURNING old.image_key, m.conversation_id`,
            [id],
          );
          imageKey = rows[0]?.image_key ?? null;
          conversationId = rows[0]?.conversation_id ?? null;
          await db.query('DELETE FROM chat_run_invite_rsvps WHERE message_id = $1', [id]);
        } else {
          const { rows } = await db.query<{ conversation_id: string }>(
            'UPDATE chat_messages SET held_at = NULL, hidden_at = NULL WHERE id = $1 RETURNING conversation_id',
            [id],
          );
          conversationId = rows[0]?.conversation_id ?? null;
        }
      } else if (type === 'community') {
        await db.query(
          action === 'remove' ? 'UPDATE communities SET removed_at = now() WHERE id = $1' : 'UPDATE communities SET hidden_at = NULL WHERE id = $1',
          [id],
        );
      } else if (type === 'event') {
        await db.query(action === 'remove' ? 'UPDATE events SET removed_at = now() WHERE id = $1' : 'UPDATE events SET hidden_at = NULL WHERE id = $1', [id]);
      } else if (type === 'post') {
        if (action === 'remove') {
          // Diturunkan: isi dan foto dihapus, postingan tidak ada lagi bagi siapa pun (termasuk penulis).
          await db.query('UPDATE feed_posts SET removed_at = now(), body_enc = NULL, held_at = NULL, hidden_at = NULL WHERE id = $1', [id]);
          const { rows } = await db.query<{ storage_key: string }>('DELETE FROM feed_post_photos WHERE post_id = $1 RETURNING storage_key', [id]);
          photoKeys = rows.map((r) => r.storage_key);
        } else {
          await db.query('UPDATE feed_posts SET held_at = NULL, hidden_at = NULL WHERE id = $1', [id]);
        }
      } else if (type === 'comment') {
        await db.query(
          action === 'remove'
            ? 'UPDATE feed_comments SET removed_at = now(), body_enc = NULL, held_at = NULL, hidden_at = NULL WHERE id = $1'
            : 'UPDATE feed_comments SET held_at = NULL, hidden_at = NULL WHERE id = $1',
          [id],
        );
      }
      await audit(db, adminId, `report.${action}`, { type, id }, { reports: rowCount, ...(note ? { note: note.slice(0, 500) } : {}) });
      return { imageKey, conversationId, photoKeys };
    });
    for (const k of outcome.photoKeys) await this.storage.delete(k).catch(() => this.logger.warn('Gagal menghapus foto postingan yang diturunkan'));
    if (outcome.imageKey) await this.storage.delete(outcome.imageKey).catch(() => this.logger.warn('Gagal menghapus gambar yang diturunkan'));
    if (outcome.conversationId) await this.realtime.publish(convChannel(outcome.conversationId), 'message.updated', { id });
  }

  // ---------- Akun ----------

  async user(adminId: string, userId: string) {
    const u = await this.userSummary(userId);
    if (!u) throw new ApiError(404, 'user_not_found', 'Pengguna tidak ditemukan');
    await audit(this.pool, adminId, 'user.view', { type: 'user', id: userId });
    return u;
  }

  /** Cari akun lewat email (blind index, tidak ada pencarian sebagian). Email tidak dicatat di log. */
  async lookup(adminId: string, email: string) {
    const row = await this.users.findByEmail(email);
    await audit(this.pool, adminId, 'user.lookup', row ? { type: 'user', id: row.id } : undefined, { found: Boolean(row) });
    if (!row) throw new ApiError(404, 'user_not_found', 'Pengguna tidak ditemukan');
    return this.userSummary(row.id);
  }

  async suspend(adminId: string, userId: string, input: { days: number | null; reason: string }) {
    await this.setStatus(adminId, userId, 'suspended', input.days === null ? null : new Date(Date.now() + input.days * 86_400_000), input.reason);
  }

  async ban(adminId: string, userId: string, reason: string) {
    await this.setStatus(adminId, userId, 'banned', null, reason);
  }

  async reinstate(adminId: string, userId: string, reason: string) {
    await this.setStatus(adminId, userId, 'active', null, reason);
  }

  private async setStatus(adminId: string, userId: string, status: 'active' | 'suspended' | 'banned', until: Date | null, reason: string) {
    if (userId === adminId) throw new ApiError(400, 'cannot_moderate_self', 'Tidak bisa menindak akun sendiri');
    await withTx(this.pool, async (db) => {
      const { rows } = await db.query<{ role: string; status: string }>('SELECT role, status FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const u = rows[0];
      if (!u || u.status === 'deleted') throw new ApiError(404, 'user_not_found', 'Pengguna tidak ditemukan');
      if (u.role === 'super_admin') throw new ApiError(403, 'cannot_moderate_admin', 'Super admin tidak bisa ditindak dari panel');
      await db.query('UPDATE users SET status = $2, suspended_until = $3 WHERE id = $1', [userId, status, until]);
      // Ditangguhkan/diblokir: semua sesi dicabut saat itu juga.
      if (status !== 'active') await this.tokens.revokeAllForUser(userId, db);
      await audit(db, adminId, `user.${status === 'active' ? 'reinstate' : status === 'suspended' ? 'suspend' : 'ban'}`, { type: 'user', id: userId }, {
        reason: reason.slice(0, 500),
        ...(until ? { until: until.toISOString() } : {}),
      });
    });
    if (status !== 'active') await this.live.end(userId).catch(() => undefined);
  }

  // ---------- Banding ----------

  /** Dipanggil dari endpoint publik setelah kredensial akun diverifikasi. Satu banding terbuka per akun. */
  async createAppeal(userId: string, message: string): Promise<void> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO appeals (user_id, message_enc) VALUES ($1, '\\x00') ON CONFLICT (user_id) WHERE status = 'open' DO NOTHING RETURNING id`,
      [userId],
    );
    const id = rows[0]?.id;
    if (!id) throw new ApiError(409, 'appeal_pending', 'Banding sebelumnya masih ditinjau');
    await this.pool.query('UPDATE appeals SET message_enc = $2 WHERE id = $1', [id, this.crypto.encrypt(message, appealAad(id))]);
  }

  async appeals(status: 'open' | 'closed') {
    const { rows } = await this.pool.query<{
      id: string;
      user_id: string;
      display_name: string;
      user_status: string;
      suspended_until: Date | null;
      message_enc: Buffer;
      status: string;
      created_at: Date;
      decided_at: Date | null;
      decision_note: string | null;
    }>(
      `SELECT a.id, a.user_id, u.display_name, u.status AS user_status, u.suspended_until, a.message_enc, a.status,
              a.created_at, a.decided_at, a.decision_note
         FROM appeals a JOIN users u ON u.id = a.user_id
        WHERE ${status === 'open' ? `a.status = 'open'` : `a.status <> 'open'`}
        ORDER BY a.created_at ${status === 'open' ? 'ASC' : 'DESC'} LIMIT 200`,
    );
    return rows.map((a) => ({
      id: a.id,
      user: { id: a.user_id, displayName: a.display_name, status: a.user_status, suspendedUntil: a.suspended_until?.toISOString() ?? null },
      message: this.crypto.decryptString(a.message_enc, appealAad(a.id)),
      status: a.status,
      createdAt: a.created_at.toISOString(),
      decidedAt: a.decided_at?.toISOString() ?? null,
      decisionNote: a.decision_note,
    }));
  }

  async decideAppeal(adminId: string, appealId: string, accept: boolean, note: string) {
    const { rows } = await this.pool.query<{ user_id: string }>(
      `UPDATE appeals SET status = $2, decided_at = now(), decided_by = $3, decision_note = $4
        WHERE id = $1 AND status = 'open' RETURNING user_id`,
      [appealId, accept ? 'accepted' : 'rejected', adminId, note.slice(0, 500)],
    );
    const userId = rows[0]?.user_id;
    if (!userId) throw new ApiError(404, 'appeal_not_found', 'Banding tidak ditemukan atau sudah diputuskan');
    await audit(this.pool, adminId, accept ? 'appeal.accept' : 'appeal.reject', { type: 'appeal', id: appealId }, { user: userId });
    if (accept) await this.reinstate(adminId, userId, `Banding diterima: ${note}`);
  }

  // ---------- Log ----------

  async auditLog(before?: string) {
    const params: unknown[] = [];
    let where = '';
    if (before) {
      params.push(before);
      where = 'WHERE l.id < $1';
    }
    const { rows } = await this.pool.query<{
      id: string;
      actor_id: string | null;
      actor_name: string | null;
      action: string;
      target_type: string | null;
      target_id: string | null;
      metadata: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT l.id, l.actor_id, u.display_name AS actor_name, l.action, l.target_type, l.target_id, l.metadata, l.created_at
         FROM admin_audit_log l LEFT JOIN users u ON u.id = l.actor_id ${where}
        ORDER BY l.id DESC LIMIT 100`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      actor: r.actor_id ? { id: r.actor_id, displayName: r.actor_name } : null,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      metadata: r.metadata,
      createdAt: r.created_at.toISOString(),
    }));
  }

  // ---------- Bantuan ----------

  private async messageWithContext(id: string) {
    const { rows } = await this.pool.query<{ conversation_id: string; seq: string; kind: string; community_name: string | null }>(
      `SELECT m.conversation_id, m.seq, c.kind, cm.name AS community_name
         FROM chat_messages m JOIN conversations c ON c.id = m.conversation_id LEFT JOIN communities cm ON cm.id = c.community_id
        WHERE m.id = $1`,
      [id],
    );
    const m = rows[0];
    if (!m) return null;
    const { rows: ctx } = await this.pool.query<{
      id: string;
      seq: string;
      kind: string;
      body_enc: Buffer | null;
      image_key: string | null;
      deleted_at: Date | null;
      removed_by_admin: boolean;
      hidden_at: Date | null;
      held_at: Date | null;
      created_at: Date;
      sender_id: string;
      display_name: string;
    }>(
      `(SELECT x.*, u.display_name FROM chat_messages x JOIN users u ON u.id = x.sender_id
         WHERE x.conversation_id = $1 AND x.seq <= $2 ORDER BY x.seq DESC LIMIT $3)
       UNION ALL
       (SELECT x.*, u.display_name FROM chat_messages x JOIN users u ON u.id = x.sender_id
         WHERE x.conversation_id = $1 AND x.seq > $2 ORDER BY x.seq ASC LIMIT $4)
       ORDER BY seq`,
      [m.conversation_id, m.seq, CONTEXT_MESSAGES + 1, CONTEXT_MESSAGES],
    );
    return {
      conversation: { id: m.conversation_id, kind: m.kind, communityName: m.community_name },
      messages: ctx.map((x) => ({
        id: x.id,
        isReported: x.id === id,
        kind: x.kind,
        text: x.body_enc ? this.crypto.decryptString(x.body_enc, bodyAad(x.id)) : null,
        hasImage: Boolean(x.image_key),
        deleted: Boolean(x.deleted_at),
        removedByAdmin: x.removed_by_admin,
        hidden: Boolean(x.hidden_at),
        held: Boolean(x.held_at),
        createdAt: x.created_at.toISOString(),
        sender: { id: x.sender_id, displayName: x.display_name },
      })),
    };
  }

  /** Foto postingan yang dilaporkan (panel admin). Postingan tanpa laporan tidak bisa dibuka; tercatat di log. */
  async postPhoto(adminId: string, postId: string, photoId: string) {
    const { rowCount } = await this.pool.query(`SELECT 1 FROM reports WHERE target_type = 'post' AND target_id = $1 LIMIT 1`, [postId]);
    if (!rowCount) return undefined;
    const { rows } = await this.pool.query<{ storage_key: string }>('SELECT storage_key FROM feed_post_photos WHERE id = $1 AND post_id = $2', [
      photoId,
      postId,
    ]);
    if (!rows[0]) return undefined;
    await audit(this.pool, adminId, 'report.view_post_photo', { type: 'post', id: postId });
    return this.storage.get(rows[0].storage_key);
  }

  private async postSummary(id: string) {
    const { rows } = await this.pool.query<{
      user_id: string;
      display_name: string;
      kind: string;
      body_enc: Buffer | null;
      visibility: string;
      run_id: string | null;
      created_at: Date;
      hidden_at: Date | null;
      removed_at: Date | null;
      run_title: string | null;
      run_distance_m: number | null;
    }>(
      `SELECT p.user_id, u.display_name, p.kind, p.body_enc, p.visibility, p.run_id, p.created_at, p.hidden_at, p.removed_at,
              r.title AS run_title, r.distance_m AS run_distance_m
         FROM feed_posts p JOIN users u ON u.id = p.user_id LEFT JOIN runs r ON r.id = p.run_id WHERE p.id = $1`,
      [id],
    );
    const p = rows[0];
    if (!p) return null;
    const { rows: photos } = await this.pool.query<{ id: string }>('SELECT id FROM feed_post_photos WHERE post_id = $1 ORDER BY position', [id]);
    return {
      id,
      author: { id: p.user_id, displayName: p.display_name },
      kind: p.kind,
      text: p.body_enc ? this.crypto.decryptString(p.body_enc, postBodyAad(id)) : null,
      visibility: p.visibility,
      run: p.run_id ? { id: p.run_id, title: p.run_title, distanceM: p.run_distance_m } : null,
      photos: photos.map((ph) => ({ id: ph.id, url: `/v1/admin/feed/posts/${id}/photos/${ph.id}` })),
      createdAt: p.created_at.toISOString(),
      hidden: Boolean(p.hidden_at),
      removed: Boolean(p.removed_at),
    };
  }

  private async commentSummary(id: string) {
    const { rows } = await this.pool.query<{
      user_id: string;
      display_name: string;
      body_enc: Buffer | null;
      post_id: string;
      created_at: Date;
      hidden_at: Date | null;
      removed_at: Date | null;
      post_author: string;
      post_body_enc: Buffer | null;
    }>(
      `SELECT c.user_id, u.display_name, c.body_enc, c.post_id, c.created_at, c.hidden_at, c.removed_at,
              pu.display_name AS post_author, p.body_enc AS post_body_enc
         FROM feed_comments c JOIN users u ON u.id = c.user_id
         JOIN feed_posts p ON p.id = c.post_id JOIN users pu ON pu.id = p.user_id
        WHERE c.id = $1`,
      [id],
    );
    const c = rows[0];
    if (!c) return null;
    const postText = c.post_body_enc ? this.crypto.decryptString(c.post_body_enc, postBodyAad(c.post_id)) : null;
    return {
      id,
      author: { id: c.user_id, displayName: c.display_name },
      text: c.body_enc ? this.crypto.decryptString(c.body_enc, commentBodyAad(id)) : null,
      post: { id: c.post_id, author: c.post_author, text: postText ? postText.slice(0, 300) : null },
      createdAt: c.created_at.toISOString(),
      hidden: Boolean(c.hidden_at),
      removed: Boolean(c.removed_at),
    };
  }

  private async userSummary(id: string) {
    const { rows } = await this.pool.query<{
      id: string;
      display_name: string;
      city: string | null;
      status: string;
      role: string;
      verification_level: number;
      suspended_until: Date | null;
      created_at: Date;
      open_reports: string;
      communities: string;
    }>(
      `SELECT u.id, u.display_name, u.city, u.status, u.role, u.verification_level, u.suspended_until, u.created_at,
              (SELECT count(*) FROM reports r WHERE r.target_type = 'user' AND r.target_id = u.id AND r.status = 'open') AS open_reports,
              (SELECT count(*) FROM community_members m WHERE m.user_id = u.id AND m.status = 'active') AS communities
         FROM users u WHERE u.id = $1`,
      [id],
    );
    const u = rows[0];
    if (!u) return null;
    return {
      id: u.id,
      displayName: u.display_name,
      city: u.city,
      status: u.status,
      role: u.role,
      verificationLevel: u.verification_level,
      suspendedUntil: u.suspended_until?.toISOString() ?? null,
      createdAt: u.created_at.toISOString(),
      openReports: Number(u.open_reports),
      communities: Number(u.communities),
    };
  }

  private async labels(targets: { type: ReportTarget; id: string }[]) {
    const out = new Map<string, string>();
    const ids = (t: ReportTarget) => targets.filter((x) => x.type === t).map((x) => x.id);
    if (ids('user').length) {
      const { rows } = await this.pool.query<{ id: string; display_name: string }>('SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])', [ids('user')]);
      for (const r of rows) out.set(`user:${r.id}`, r.display_name);
    }
    if (ids('community').length) {
      const { rows } = await this.pool.query<{ id: string; name: string }>('SELECT id, name FROM communities WHERE id = ANY($1::uuid[])', [ids('community')]);
      for (const r of rows) out.set(`community:${r.id}`, r.name);
    }
    if (ids('event').length) {
      const { rows } = await this.pool.query<{ id: string; name: string }>('SELECT id, name FROM events WHERE id = ANY($1::uuid[])', [ids('event')]);
      for (const r of rows) out.set(`event:${r.id}`, r.name);
    }
    if (ids('post').length) {
      const { rows } = await this.pool.query<{ id: string; display_name: string }>(
        'SELECT p.id, u.display_name FROM feed_posts p JOIN users u ON u.id = p.user_id WHERE p.id = ANY($1::uuid[])',
        [ids('post')],
      );
      for (const r of rows) out.set(`post:${r.id}`, `Postingan dari ${r.display_name}`);
    }
    if (ids('comment').length) {
      const { rows } = await this.pool.query<{ id: string; display_name: string }>(
        'SELECT c.id, u.display_name FROM feed_comments c JOIN users u ON u.id = c.user_id WHERE c.id = ANY($1::uuid[])',
        [ids('comment')],
      );
      for (const r of rows) out.set(`comment:${r.id}`, `Komentar dari ${r.display_name}`);
    }
    if (ids('message').length) {
      // Daftar antrean tidak menampilkan isi pesan; isi hanya dibuka di detail (tercatat di log).
      const { rows } = await this.pool.query<{ id: string; display_name: string; kind: string }>(
        `SELECT m.id, u.display_name, m.kind FROM chat_messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ANY($1::uuid[])`,
        [ids('message')],
      );
      for (const r of rows) out.set(`message:${r.id}`, `${r.kind === 'image' ? 'Gambar' : 'Pesan'} dari ${r.display_name}`);
    }
    return out;
  }
}
