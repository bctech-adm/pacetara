import { Inject, Injectable, Logger } from '@nestjs/common';
import type pg from 'pg';
import { withTx } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { PG_POOL } from '../core.module.js';
import { verifyPassword } from '../auth/password.js';
import { TokenService } from '../auth/token.service.js';
import { ChatService } from '../chat/chat.service.js';
import { CommunitiesService } from '../communities/communities.service.js';
import { EventsService } from '../events/events.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { LiveService } from '../live/live.service.js';
import { ReportsService } from '../moderation/reports.service.js';
import { RunsService } from '../runs/runs.service.js';
import { processImage } from '../storage/image.js';
import { StorageService } from '../storage/storage.service.js';
import { avatarPath, type MyProfile, UsersRepository } from './users.repository.js';

export const DELETED_USER_NAME = 'Pengguna dihapus';

export interface PublicProfile {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  city: string | null;
  badges: string[];
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger('UsersService');

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly repo: UsersRepository,
    private readonly storage: StorageService,
    private readonly tokens: TokenService,
    private readonly communities: CommunitiesService,
    private readonly runs: RunsService,
    private readonly live: LiveService,
    private readonly chat: ChatService,
    private readonly reports: ReportsService,
    private readonly events: EventsService,
    private readonly notifications: NotificationsService,
  ) {}

  async me(userId: string): Promise<MyProfile> {
    const row = await this.repo.findById(userId);
    if (!row || row.status === 'deleted') throw new ApiError(401, 'unauthorized', 'Perlu login');
    return this.repo.toMyProfile(row);
  }

  async updateProfile(
    userId: string,
    patch: { displayName?: string; city?: string | null; avgPaceSecPerKm?: number | null },
  ): Promise<MyProfile> {
    const sets: string[] = [];
    const values: unknown[] = [userId];
    const add = (col: string, v: unknown) => {
      values.push(v);
      sets.push(`${col} = $${values.length}`);
    };
    if (patch.displayName !== undefined) add('display_name', patch.displayName);
    if (patch.city !== undefined) add('city', patch.city);
    if (patch.avgPaceSecPerKm !== undefined) add('avg_pace_sec_per_km', patch.avgPaceSecPerKm);
    if (sets.length > 0) {
      await this.pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1 AND status = 'active'`, values);
    }
    return this.me(userId);
  }

  async setAvatar(userId: string, file: Buffer): Promise<MyProfile> {
    const webp = await processImage(file, { size: 512, square: true });
    const key = `avatars/${userId}/${Date.now()}.webp`;
    await this.storage.put(key, webp, 'image/webp');
    const { rows } = await this.pool.query<{ old: string | null }>(
      `UPDATE users u SET avatar_key = $2, avatar_updated_at = now()
         FROM (SELECT avatar_key AS old FROM users WHERE id = $1) prev
        WHERE u.id = $1 RETURNING prev.old`,
      [userId, key],
    );
    const old = rows[0]?.old;
    if (old) await this.storage.delete(old).catch(() => this.logger.warn('Gagal menghapus avatar lama'));
    return this.me(userId);
  }

  async removeAvatar(userId: string): Promise<MyProfile> {
    const { rows } = await this.pool.query<{ old: string | null }>(
      `UPDATE users u SET avatar_key = NULL, avatar_updated_at = now()
         FROM (SELECT avatar_key AS old FROM users WHERE id = $1) prev
        WHERE u.id = $1 RETURNING prev.old`,
      [userId],
    );
    if (rows[0]?.old) await this.storage.delete(rows[0].old).catch(() => undefined);
    return this.me(userId);
  }

  /**
   * Profil pengguna lain. PRD (Akses): pengguna hanya bisa mengambil data miliknya atau komunitas
   * tempat ia terdaftar, jadi profil hanya terlihat oleh diri sendiri dan sesama anggota komunitas.
   */
  async publicProfile(viewerId: string, userId: string): Promise<PublicProfile> {
    if (viewerId !== userId && !(await this.communities.shareCommunity(viewerId, userId))) {
      throw new ApiError(404, 'not_found', 'Pengguna tidak ditemukan');
    }
    const row = await this.repo.findById(userId);
    if (!row || row.status !== 'active') throw new ApiError(404, 'not_found', 'Pengguna tidak ditemukan');
    return {
      id: row.id,
      displayName: row.display_name,
      avatarUrl: avatarPath(row),
      city: row.city,
      badges: row.verification_level >= 2 ? ['verified'] : [],
    };
  }

  async avatarFile(viewerId: string, userId: string) {
    if (viewerId !== userId && !(await this.communities.shareCommunity(viewerId, userId))) return undefined;
    const row = await this.repo.findById(userId);
    if (!row?.avatar_key || row.status !== 'active') return undefined;
    return this.storage.get(row.avatar_key);
  }

  /**
   * Hapus akun: semua data pribadi dihapus dan baris pengguna dianonimkan (bukan dihapus),
   * agar pesan komunitas nanti tampil sebagai "Pengguna dihapus" (PRD: Privasi lokasi dan chat).
   * Modul berikutnya menambah langkah di sini: hapus chat pribadi, lari, status, dsb.
   */
  async deleteAccount(userId: string, confirm: { password?: string }): Promise<void> {
    const row = await this.repo.findById(userId);
    if (!row || row.status === 'deleted') throw new ApiError(401, 'unauthorized', 'Perlu login');
    if (row.password_hash && !(confirm.password && (await verifyPassword(row.password_hash, confirm.password)))) {
      throw new ApiError(401, 'invalid_credentials', 'Kata sandi salah');
    }

    const logos = await withTx(this.pool, async (db) => {
      // Komunitas: ditolak jika masih memiliki komunitas beranggota; selain itu keluar dari semua komunitas.
      const communityLogos = await this.communities.onAccountDeletion(db, userId);
      // Lari, rute, dan foto lari adalah data pribadi: dihapus seluruhnya.
      const runPhotos = await this.runs.onAccountDeletion(db, userId);
      // Chat: pesan di chat pribadi dihapus; di chat komunitas nama menjadi "Pengguna dihapus".
      const chatImages = await this.chat.onAccountDeletion(db, userId);
      // Laporan: keterangan yang ditulis pengguna dihapus; banding dihapus.
      await this.reports.onAccountDeletion(db, userId);
      // Event: tanda "ikut" dihapus.
      await this.events.onAccountDeletion(db, userId);
      // Notifikasi, pengaturan, token push, dan undangan.
      await this.notifications.onAccountDeletion(db, userId);
      await this.tokens.revokeAllForUser(userId, db);
      await db.query('DELETE FROM verification_codes WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
      await db.query(
        `UPDATE users SET
           status = 'deleted', deleted_at = now(), display_name = $2,
           email_enc = NULL, email_bidx = NULL, email_verified_at = NULL,
           phone_enc = NULL, phone_bidx = NULL, phone_verified_at = NULL,
           password_hash = NULL, google_sub = NULL, nik_hmac = NULL,
           avatar_key = NULL, avatar_updated_at = NULL, city = NULL, avg_pace_sec_per_km = NULL,
           privacy_accepted_at = NULL, privacy_version = NULL, verification_level = 0
         WHERE id = $1`,
        [userId, DELETED_USER_NAME],
      );
      return [...communityLogos, ...runPhotos, ...chatImages];
    });
    // Status lari langsung (Redis) ikut dihapus.
    await this.live.onAccountDeletion(userId).catch(() => this.logger.warn('Gagal menghapus status lari akun terhapus'));
    for (const key of logos) await this.storage.delete(key).catch(() => undefined);
    if (row.avatar_key) await this.storage.delete(row.avatar_key).catch(() => this.logger.warn('Gagal menghapus avatar akun terhapus'));
  }
}
