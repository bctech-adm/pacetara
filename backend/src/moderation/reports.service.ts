import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { ChatService } from '../chat/chat.service.js';
import { CommunitiesService } from '../communities/communities.service.js';
import type { Queryable } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { PG_POOL } from '../core.module.js';
import { FieldCrypto } from '../crypto/field-crypto.js';
import { EventsService } from '../events/events.service.js';
import { FeedService } from '../feed/feed.service.js';
import { BuddiesService } from '../buddies/buddies.service.js';
import { SpotsService } from '../spots/spots.service.js';
import { MarketService } from '../market/market.service.js';

export type ReportTarget = 'user' | 'community' | 'message' | 'event' | 'post' | 'comment' | 'spot' | 'listing';
export const REPORT_REASONS = ['spam', 'harassment', 'hate', 'sexual', 'violence', 'scam', 'impersonation', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** Jumlah pelapor berbeda (laporan terbuka) sebelum konten disembunyikan otomatis sambil menunggu tinjauan. */
export const AUTO_HIDE_REPORTERS = 3;

export const reportDetailsAad = (id: string) => `reports.details:${id}`;

/**
 * Laporan dari pengguna. Pelapor hanya bisa melaporkan sesuatu yang memang bisa ia lihat
 * (pesan di percakapannya, komunitas yang ada, pengguna yang satu komunitas/pernah chat pribadi),
 * agar endpoint ini tidak bisa dipakai untuk menebak id.
 */
@Injectable()
export class ReportsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly crypto: FieldCrypto,
    private readonly chat: ChatService,
    private readonly communities: CommunitiesService,
    private readonly events: EventsService,
    private readonly feed: FeedService,
    private readonly buddies: BuddiesService,
    private readonly spots: SpotsService,
    private readonly market: MarketService,
  ) {}

  async create(
    reporterId: string,
    input: { targetType: ReportTarget; targetId: string; reason: ReportReason; details?: string },
  ): Promise<{ id: string; created: boolean }> {
    await this.assertReportable(reporterId, input.targetType, input.targetId);

    const { rows: existing } = await this.pool.query<{ id: string }>(
      `SELECT id FROM reports WHERE reporter_id = $1 AND target_type = $2 AND target_id = $3 AND status = 'open'`,
      [reporterId, input.targetType, input.targetId],
    );
    if (existing[0]) return { id: existing[0].id, created: false };

    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES ($1, $2, $3, $4)
       ON CONFLICT (reporter_id, target_type, target_id) WHERE status = 'open' DO NOTHING RETURNING id`,
      [reporterId, input.targetType, input.targetId, input.reason],
    );
    const id = rows[0]?.id;
    if (!id) return this.create(reporterId, input); // laporan ganda bersamaan: kembalikan yang sudah ada
    if (input.details) {
      await this.pool.query('UPDATE reports SET details_enc = $2 WHERE id = $1', [id, this.crypto.encrypt(input.details, reportDetailsAad(id))]);
    }
    await this.applyHolds(this.pool, input.targetType, input.targetId);
    return { id, created: true };
  }

  /**
   * Pesan yang dilaporkan ditahan (tidak bisa dihapus pengirim) sampai laporannya selesai.
   * Setelah AUTO_HIDE_REPORTERS pelapor berbeda, pesan/komunitas disembunyikan sambil menunggu tinjauan.
   */
  private async applyHolds(db: Queryable, type: ReportTarget, targetId: string) {
    if (type === 'message') await db.query('UPDATE chat_messages SET held_at = COALESCE(held_at, now()) WHERE id = $1', [targetId]);
    if (type === 'post') await db.query('UPDATE feed_posts SET held_at = COALESCE(held_at, now()) WHERE id = $1', [targetId]);
    if (type === 'comment') await db.query('UPDATE feed_comments SET held_at = COALESCE(held_at, now()) WHERE id = $1', [targetId]);
    if (type === 'listing') await db.query('UPDATE market_listings SET held_at = COALESCE(held_at, now()) WHERE id = $1', [targetId]);
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(DISTINCT reporter_id) AS n FROM reports WHERE target_type = $1 AND target_id = $2 AND status = 'open'`,
      [type, targetId],
    );
    if (Number(rows[0]!.n) < AUTO_HIDE_REPORTERS) return;
    if (type === 'message') await db.query('UPDATE chat_messages SET hidden_at = COALESCE(hidden_at, now()) WHERE id = $1', [targetId]);
    if (type === 'community') await db.query('UPDATE communities SET hidden_at = COALESCE(hidden_at, now()) WHERE id = $1', [targetId]);
    if (type === 'event') await db.query('UPDATE events SET hidden_at = COALESCE(hidden_at, now()) WHERE id = $1', [targetId]);
    if (type === 'post') await db.query('UPDATE feed_posts SET hidden_at = COALESCE(hidden_at, now()) WHERE id = $1', [targetId]);
    if (type === 'comment') await db.query('UPDATE feed_comments SET hidden_at = COALESCE(hidden_at, now()) WHERE id = $1', [targetId]);
    if (type === 'spot') await db.query('UPDATE run_spots SET hidden_at = COALESCE(hidden_at, now()) WHERE id = $1', [targetId]);
    if (type === 'listing') await db.query('UPDATE market_listings SET hidden_at = COALESCE(hidden_at, now()) WHERE id = $1', [targetId]);
  }

  private async assertReportable(reporterId: string, type: ReportTarget, targetId: string) {
    switch (type) {
      case 'message': {
        const m = await this.chat.reportableMessage(reporterId, targetId);
        if (m.senderId === reporterId) throw new ApiError(400, 'cannot_report_self', 'Tidak bisa melaporkan pesan sendiri');
        return;
      }
      case 'community': {
        const { rows } = await this.pool.query<{ owner_id: string; my_status: string | null }>(
          `SELECT c.owner_id, m.status AS my_status FROM communities c
             LEFT JOIN community_members m ON m.community_id = c.id AND m.user_id = $2
            WHERE c.id = $1 AND c.removed_at IS NULL`,
          [targetId, reporterId],
        );
        const c = rows[0];
        if (!c || c.my_status === 'banned') throw new ApiError(404, 'community_not_found', 'Komunitas tidak ditemukan');
        if (c.owner_id === reporterId) throw new ApiError(400, 'cannot_report_self', 'Tidak bisa melaporkan komunitas sendiri');
        return;
      }
      case 'post': {
        const p = await this.feed.reportablePost(reporterId, targetId);
        if (p.authorId === reporterId) throw new ApiError(400, 'cannot_report_self', 'Tidak bisa melaporkan postingan sendiri');
        return;
      }
      case 'comment': {
        const c = await this.feed.reportableComment(reporterId, targetId);
        if (c.authorId === reporterId) throw new ApiError(400, 'cannot_report_self', 'Tidak bisa melaporkan komentar sendiri');
        return;
      }
      case 'spot': {
        // Spot tayang terlihat semua pengguna Level 1 (modul 2.6).
        const sp = await this.spots.reportable(reporterId, targetId);
        if (sp.submittedBy === reporterId) throw new ApiError(400, 'cannot_report_self', 'Tidak bisa melaporkan spot kirimanmu sendiri');
        return;
      }
      case 'listing': {
        // Listing tayang terlihat semua pengguna Level 1 (modul 3.2). Penjual dilaporkan lewat sasaran `user`.
        const l = await this.market.reportable(reporterId, targetId);
        if (l.sellerId === reporterId) throw new ApiError(400, 'cannot_report_self', 'Tidak bisa melaporkan listing sendiri');
        return;
      }
      case 'event':
        // Event dimasukkan super admin dan terlihat oleh semua pengguna Level 1.
        await this.events.assertExists(targetId);
        return;
      case 'user': {
        if (targetId === reporterId) throw new ApiError(400, 'cannot_report_self', 'Tidak bisa melaporkan diri sendiri');
        const { rows } = await this.pool.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [targetId]);
        const known =
          rows[0] && rows[0].status !== 'deleted' &&
          ((await this.communities.shareCommunity(reporterId, targetId)) ||
            (await this.chat.haveDirectConversation(reporterId, targetId)) ||
            (await this.feed.canSeeProfile(reporterId, targetId)) ||
            // Cari teman lari (modul 2.6): pernah saling sapa atau terlihat di pencarian.
            (await this.buddies.canSee(reporterId, targetId)) ||
            // Marketplace (modul 3.2): penjual listing yang tayang, atau pasangan yang terhubung lewat "Hubungi penjual".
            (await this.market.canReportUser(reporterId, targetId)));
        if (!known) throw new ApiError(404, 'user_not_found', 'Pengguna tidak ditemukan');
        return;
      }
    }
  }

  /** Hapus akun: keterangan bebas yang ditulis pengguna (data pribadi) dihapus; catatan laporannya tetap. */
  async onAccountDeletion(db: Queryable, userId: string): Promise<void> {
    await db.query('UPDATE reports SET details_enc = NULL WHERE reporter_id = $1', [userId]);
    await db.query('DELETE FROM appeals WHERE user_id = $1', [userId]);
  }
}
