import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { ApiError } from '../common/http.js';
import { PG_POOL, REDIS } from '../core.module.js';
import { FieldCrypto } from '../crypto/field-crypto.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { haversine } from '../runs/geo.js';
import { avatarPath } from '../users/users.repository.js';

/**
 * Status "sedang lari" hanya ada di Redis dengan TTL; tidak pernah ditulis ke Postgres.
 * Aplikasi memperbarui setiap ±10 detik. Jika aplikasi mati tanpa sempat mengakhiri, status
 * hilang sendiri setelah TTL. Selesai lari = dihapus eksplisit.
 */
export const LIVE_TTL_S = 180;
/** Posisi dibulatkan ke 4 desimal (±11 m): cukup untuk "di mana dia", tidak lebih. */
const POSITION_DECIMALS = 4;

const sessionKey = (userId: string) => `live:s:${userId}`;
const communityKey = (communityId: string) => `live:c:${communityId}`;
export const liveChannel = (communityId: string) => `community:${communityId}:live`;
const LIVE_CHANNEL = /^community:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):live$/;

export interface LatLng {
  lat: number;
  lng: number;
}

export interface LiveUpdateInput {
  clientRunId: string;
  communities: { id: string; showLocation: boolean }[];
  startedAt: Date;
  distanceM: number;
  movingTimeS: number;
  paused: boolean;
  position?: LatLng | null;
  /** Titik pertama rekaman (pusat zona privasi). */
  origin?: LatLng | null;
}

interface StoredSession {
  runId: string;
  startedAt: string;
  updatedAt: string;
  communities: { id: string; loc: boolean }[];
  distanceM: number;
  movingTimeS: number;
  paused: boolean;
  radiusM: number;
  /** Pusat zona privasi, terenkripsi (base64). Hanya ada jika posisi dibagikan ke minimal satu komunitas. */
  origin?: string;
  /** Posisi terakhir di luar zona privasi, terenkripsi (base64). */
  pos?: string;
  inPrivacyZone: boolean;
}

@Injectable()
export class LiveService implements OnModuleInit {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly crypto: FieldCrypto,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    // Hanya anggota aktif yang boleh menerima sinyal perubahan status lari komunitas.
    this.realtime.register(LIVE_CHANNEL, (userId, m) => this.isActiveMember(userId, m[1]!));
  }

  /** Mulai atau perbarui status. Komunitas yang bukan tempat pengguna terdaftar aktif diabaikan. */
  async update(userId: string, input: LiveUpdateInput) {
    const requested = dedupe(input.communities);
    const allowed = await this.activeCommunities(userId, requested.map((c) => c.id));
    const communities = requested.filter((c) => allowed.has(c.id)).map((c) => ({ id: c.id, loc: c.showLocation }));
    if (communities.length === 0) {
      await this.end(userId);
      return { sharing: false, communities: [], positionHidden: false, ttlS: 0 };
    }

    const previous = await this.load(userId);
    const same = previous?.runId === input.clientRunId ? previous : undefined;
    const now = new Date();

    const radiusM = same?.radiusM ?? (await this.privacyRadius(userId));
    const sharesLocation = communities.some((c) => c.loc);
    let origin: LatLng | undefined;
    let pos: LatLng | undefined;
    let inPrivacyZone = false;
    if (sharesLocation) {
      origin = (same?.origin ? this.decryptPoint(same.origin, userId, 'origin') : undefined) ?? input.origin ?? input.position ?? undefined;
      if (input.position) {
        inPrivacyZone = !origin || haversine([origin.lat, origin.lng], [input.position.lat, input.position.lng]) < radiusM;
        if (!inPrivacyZone) pos = roundPoint(input.position);
      } else if (same?.pos) {
        // Pembaruan tanpa posisi (mis. sinyal GPS hilang): pertahankan posisi terakhir yang aman.
        pos = this.decryptPoint(same.pos, userId, 'pos');
        inPrivacyZone = same.inPrivacyZone;
      }
    }

    const session: StoredSession = {
      runId: input.clientRunId,
      startedAt: input.startedAt.toISOString(),
      updatedAt: now.toISOString(),
      communities,
      distanceM: Math.round(input.distanceM),
      movingTimeS: input.movingTimeS,
      paused: input.paused,
      radiusM,
      inPrivacyZone,
      ...(origin ? { origin: this.encryptPoint(origin, userId, 'origin') } : {}),
      ...(pos ? { pos: this.encryptPoint(pos, userId, 'pos') } : {}),
    };

    const removed = (previous?.communities ?? []).map((c) => c.id).filter((id) => !communities.some((c) => c.id === id));
    const expiresAt = now.getTime() + LIVE_TTL_S * 1000;
    const multi = this.redis.multi().set(sessionKey(userId), JSON.stringify(session), 'EX', LIVE_TTL_S);
    for (const c of communities) multi.zadd(communityKey(c.id), expiresAt, userId).expire(communityKey(c.id), LIVE_TTL_S);
    for (const id of removed) multi.zrem(communityKey(id), userId);
    await multi.exec();
    await this.notify([...communities.map((c) => c.id), ...removed]);
    await this.notifyStarted(userId, input.clientRunId, communities.map((c) => c.id));

    return {
      sharing: true,
      communities: communities.map((c) => ({ id: c.id, showLocation: c.loc })),
      positionHidden: sharesLocation && !pos,
      ttlS: LIVE_TTL_S,
    };
  }

  /**
   * Push "teman mulai lari" ke anggota komunitas yang dipilih pelari (hanya komunitas itu, sama dengan
   * siapa yang boleh melihat statusnya). Sekali per lari per komunitas, walau status diperbarui tiap 10 detik.
   */
  private async notifyStarted(userId: string, runId: string, communityIds: string[]) {
    const fresh: string[] = [];
    for (const id of communityIds) {
      if (await this.redis.set(`live:notified:${userId}:${runId}:${id}`, '1', 'EX', 6 * 3600, 'NX')) fresh.push(id);
    }
    if (fresh.length === 0) return;
    const { rows } = await this.pool.query<{ user_id: string; name: string }>(
      `SELECT DISTINCT m.user_id, c.name FROM community_members m JOIN communities c ON c.id = m.community_id
        WHERE m.community_id = ANY($1::uuid[]) AND m.status = 'active' AND m.user_id <> $2`,
      [fresh, userId],
    );
    if (rows.length === 0) return;
    const l = await this.notifications.labels(userId, fresh[0]);
    await this.notifications.notify(
      rows.map((r) => r.user_id),
      {
        category: 'friend_running',
        actorId: userId,
        push: {
          title: `${l.actor} mulai lari`,
          body: fresh.length > 1 ? 'Lihat siapa yang sedang lari di komunitasmu' : `Lihat di ${l.community}`,
          data: { type: 'friend_running', communityId: fresh[0]! },
          tag: `live:${userId}`,
        },
      },
    );
  }

  /**
   * Akhiri status: titik lokasi dan seluruh status dihapus dari Redis saat itu juga.
   * Jika [clientRunId] diberikan, hanya mengakhiri sesi lari itu (dipakai saat lari diunggah).
   */
  async end(userId: string, clientRunId?: string): Promise<void> {
    const s = await this.load(userId);
    if (!s || (clientRunId && s.runId !== clientRunId)) return;
    const multi = this.redis.multi().del(sessionKey(userId));
    for (const c of s.communities) multi.zrem(communityKey(c.id), userId);
    await multi.exec();
    await this.notify(s.communities.map((c) => c.id));
  }

  /** Status saya sendiri (untuk aplikasi yang dibuka ulang di tengah lari). */
  async mine(userId: string) {
    const s = await this.load(userId);
    if (!s) return { sharing: false as const };
    return {
      sharing: true as const,
      clientRunId: s.runId,
      communities: s.communities.map((c) => ({ id: c.id, showLocation: c.loc })),
      updatedAt: s.updatedAt,
    };
  }

  /** Daftar "sedang lari" di satu komunitas. Hanya untuk anggota aktif komunitas itu. */
  async list(viewerId: string, communityId: string) {
    if (!(await this.isActiveMember(viewerId, communityId))) {
      throw new ApiError(403, 'not_member', 'Hanya anggota komunitas yang bisa melihat siapa yang sedang lari');
    }
    const key = communityKey(communityId);
    await this.redis.zremrangebyscore(key, '-inf', String(Date.now()));
    const userIds = await this.redis.zrange(key, '0', '-1');
    if (userIds.length === 0) return { items: [], ttlS: LIVE_TTL_S };

    const raw = await this.redis.mget(userIds.map(sessionKey));
    const sessions = new Map<string, StoredSession>();
    raw.forEach((v, i) => {
      if (!v) return;
      const s = JSON.parse(v) as StoredSession;
      if (s.communities.some((c) => c.id === communityId)) sessions.set(userIds[i]!, s);
    });
    if (sessions.size === 0) return { items: [], ttlS: LIVE_TTL_S };

    // Cek ulang di database: pelari harus masih anggota aktif dan akunnya aktif.
    const { rows } = await this.pool.query<{
      id: string;
      display_name: string;
      avatar_key: string | null;
      avatar_updated_at: Date | null;
    }>(
      `SELECT u.id, u.display_name, u.avatar_key, u.avatar_updated_at
         FROM community_members m JOIN users u ON u.id = m.user_id
        WHERE m.community_id = $1 AND m.status = 'active' AND u.status = 'active' AND u.id = ANY($2::uuid[])`,
      [communityId, [...sessions.keys()]],
    );

    const items = rows.map((u) => {
      const s = sessions.get(u.id)!;
      const share = s.communities.find((c) => c.id === communityId)!;
      const position = share.loc && s.pos ? this.decryptPoint(s.pos, u.id, 'pos') : null;
      return {
        userId: u.id,
        displayName: u.display_name,
        avatarUrl: avatarPath(u),
        isMe: u.id === viewerId,
        startedAt: s.startedAt,
        updatedAt: s.updatedAt,
        distanceM: s.distanceM,
        movingTimeS: s.movingTimeS,
        paused: s.paused,
        position: position ?? null,
        /** Pelari membagikan posisi, tetapi sedang di zona privasi (dekat titik mulai). */
        positionHidden: share.loc && !position,
      };
    });
    items.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return { items, ttlS: LIVE_TTL_S };
  }

  /** Dipanggil saat hapus akun. */
  async onAccountDeletion(userId: string): Promise<void> {
    await this.end(userId);
  }

  // ---------- Bantuan ----------

  private async load(userId: string): Promise<StoredSession | undefined> {
    const v = await this.redis.get(sessionKey(userId));
    return v ? (JSON.parse(v) as StoredSession) : undefined;
  }

  private async notify(communityIds: string[]): Promise<void> {
    await Promise.all([...new Set(communityIds)].map((id) => this.realtime.publish(liveChannel(id), 'live.changed')));
  }

  private async isActiveMember(userId: string, communityId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `SELECT 1 FROM community_members m JOIN users u ON u.id = m.user_id
        WHERE m.community_id = $1 AND m.user_id = $2 AND m.status = 'active' AND u.status = 'active'`,
      [communityId, userId],
    );
    return (rowCount ?? 0) > 0;
  }

  private async activeCommunities(userId: string, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const { rows } = await this.pool.query<{ community_id: string }>(
      `SELECT m.community_id FROM community_members m JOIN users u ON u.id = m.user_id
        WHERE m.user_id = $1 AND m.status = 'active' AND u.status = 'active' AND m.community_id = ANY($2::uuid[])`,
      [userId, ids],
    );
    return new Set(rows.map((r) => r.community_id));
  }

  private async privacyRadius(userId: string): Promise<number> {
    const { rows } = await this.pool.query<{ privacy_radius_m: number }>('SELECT privacy_radius_m FROM users WHERE id = $1', [userId]);
    return rows[0]?.privacy_radius_m ?? 250;
  }

  private encryptPoint(p: LatLng, userId: string, kind: 'origin' | 'pos'): string {
    return this.crypto.encrypt(JSON.stringify([p.lat, p.lng]), `live.${kind}:${userId}`).toString('base64');
  }

  private decryptPoint(b64: string, userId: string, kind: 'origin' | 'pos'): LatLng {
    const [lat, lng] = JSON.parse(this.crypto.decryptString(Buffer.from(b64, 'base64'), `live.${kind}:${userId}`)) as [number, number];
    return { lat, lng };
  }
}

function roundPoint(p: LatLng): LatLng {
  const f = 10 ** POSITION_DECIMALS;
  return { lat: Math.round(p.lat * f) / f, lng: Math.round(p.lng * f) / f };
}

function dedupe(list: { id: string; showLocation: boolean }[]) {
  const seen = new Map<string, { id: string; showLocation: boolean }>();
  for (const c of list) seen.set(c.id, c);
  return [...seen.values()];
}
