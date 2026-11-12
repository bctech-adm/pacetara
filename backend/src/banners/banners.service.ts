import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import sharp, { type Metadata } from 'sharp';
import { audit } from '../admin/admin-auth.service.js';
import { type Queryable, withTx } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { ENV, type Env } from '../config/env.js';
import { PG_POOL, REDIS } from '../core.module.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { MAX_UPLOAD_BYTES } from '../storage/image.js';
import { StorageService } from '../storage/storage.service.js';

export type BannerSlot = 'home' | 'events' | 'event_detail';
export const BANNER_SLOTS: BannerSlot[] = ['home', 'events', 'event_detail'];
/** Ukuran akhir banner (3:1). Unggahan dengan rasio 2,4–3,6 dipotong tengah ke ukuran ini. */
export const BANNER_W = 1200;
export const BANNER_H = 400;
export const MAX_CITIES = 10;
export const MAX_PENDING_BANNERS = 5;
const TODAY = `(now() AT TIME ZONE 'Asia/Jakarta')::date`;
/** Banner tayang: disetujui dan hari ini (WIB) di dalam periodenya. Turun otomatis setelah periode habis. */
const ACTIVE = `b.status = 'approved' AND b.starts_on <= ${TODAY} AND b.starts_on + b.days > ${TODAY}`;

export interface BannerInput {
  slot: BannerSlot;
  title: string;
  eventId?: string;
  targetUrl?: string;
  cities: string[];
  startsOn: string;
  days: number;
}

interface BannerRow {
  id: string;
  sponsor_id: string | null;
  slot: BannerSlot;
  title: string;
  event_id: string | null;
  target_url: string | null;
  cities: string[];
  starts_on: string;
  days: number;
  image_key: string | null;
  amount: string;
  status: 'pending_payment' | 'pending_review' | 'approved' | 'rejected' | 'cancelled';
  reject_reason: string | null;
  paid_at: Date | null;
  created_at: Date;
  ends_on: string;
  today: string;
  event_name?: string | null;
  impressions?: string;
  clicks?: string;
  sponsor_name?: string | null;
}

const COLS = `b.id, b.sponsor_id, b.slot, b.title, b.event_id, b.target_url, b.cities, to_char(b.starts_on, 'YYYY-MM-DD') AS starts_on, b.days,
  b.image_key, b.amount, b.status, b.reject_reason, b.paid_at, b.created_at,
  to_char(b.starts_on + b.days - 1, 'YYYY-MM-DD') AS ends_on, to_char(${TODAY}, 'YYYY-MM-DD') AS today`;

/** Harga = tarif harian slot × hari × jumlah kota (nasional = faktor nasional). Fungsi murni, dipakai server dan diuji. */
export function bannerQuote(perDay: number, days: number, cityCount: number, nationalFactor: number): number {
  return perDay * days * (cityCount > 0 ? cityCount : nationalFactor);
}

/** Validasi tautan sponsor: https, port bawaan, tanpa kredensial. Ditinjau super admin sebelum tayang. */
export function validateTargetUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password || !u.hostname.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Banner sponsor (modul 3.3). Dibuat dan dibayar sponsor Level 2 di dasbor web (Midtrans, REVIEW-PRD C1), tayang
 * setelah disetujui super admin, turun otomatis saat periode habis. Aplikasi meminta satu banner per slot
 * (beranda, daftar event, detail event) untuk kota pengguna; Premium tidak melihat banner (PRD: Premium tanpa iklan).
 * Statistik tayangan/klik unik per pengguna per hari, disimpan agregat.
 */
/** Masih ada tautan Snap (24 jam) yang bisa dibayar untuk banner ini. */
const PAYABLE = `EXISTS (SELECT 1 FROM payments p WHERE p.purpose = 'banner' AND p.ref_id = {ref} AND p.status = 'pending'
                       AND p.created_at > now() - interval '24 hours')`;

@Injectable()
export class BannersService {
  private readonly logger = new Logger('Banners');

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
    private readonly storage: StorageService,
    private readonly payments: PaymentsService,
    private readonly notifications: NotificationsService,
  ) {}

  private perDay(slot: BannerSlot): number {
    return { home: this.env.BANNER_PRICE_HOME, events: this.env.BANNER_PRICE_EVENTS, event_detail: this.env.BANNER_PRICE_EVENT_DETAIL }[slot];
  }

  config() {
    return {
      slots: BANNER_SLOTS.map((s) => ({ slot: s, perDay: this.perDay(s) })),
      nationalFactor: this.env.BANNER_NATIONAL_FACTOR,
      maxDays: 90,
      maxCities: MAX_CITIES,
      size: { width: BANNER_W, height: BANNER_H },
      paymentsEnabled: this.payments.enabled,
    };
  }

  quote(slot: BannerSlot, days: number, cityCount: number) {
    return bannerQuote(this.perDay(slot), days, cityCount, this.env.BANNER_NATIONAL_FACTOR);
  }

  // ---------- Sponsor (dasbor web) ----------

  async create(userId: string, input: BannerInput, image: Buffer) {
    const cities = [...new Set(input.cities.map((c) => c.trim().toLowerCase()).filter(Boolean))];
    if (cities.length > MAX_CITIES) throw new ApiError(400, 'too_many_cities', `Maksimal ${MAX_CITIES} kota`);
    let targetUrl: string | null = null;
    if (input.targetUrl) {
      targetUrl = validateTargetUrl(input.targetUrl);
      if (!targetUrl) throw new ApiError(400, 'invalid_url', 'Tautan harus https');
    }
    if (input.eventId && targetUrl) throw new ApiError(400, 'one_target', 'Pilih salah satu: event atau tautan');
    if (input.slot === 'event_detail' && !input.eventId) throw new ApiError(400, 'event_required', 'Banner detail event wajib tertaut ke event');
    const processed = await processBanner(image);

    const id = await withTx(this.pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`banner:${userId}`]);
      const { rows: d } = await db.query<{ ok: boolean; too_far: boolean }>(
        `SELECT $1::date >= ${TODAY} AS ok, $1::date > ${TODAY} + 180 AS too_far`,
        [input.startsOn],
      );
      if (!d[0]!.ok) throw new ApiError(400, 'invalid_start', 'Tanggal mulai tidak boleh lampau');
      if (d[0]!.too_far) throw new ApiError(400, 'invalid_start', 'Tanggal mulai maksimal 180 hari ke depan');
      if (input.eventId) {
        const { rows: ev } = await db.query<{ ok: boolean }>(
          `SELECT event_date >= $2::date AS ok FROM events WHERE id = $1 AND removed_at IS NULL AND archived_at IS NULL`,
          [input.eventId, input.startsOn],
        );
        if (!ev[0]) throw new ApiError(404, 'event_not_found', 'Event tidak ditemukan atau sudah lewat');
        if (!ev[0].ok) throw new ApiError(400, 'event_before_start', 'Event sudah lewat sebelum banner mulai tayang');
      }
      const { rows: n } = await db.query<{ n: string }>(`SELECT count(*) AS n FROM sponsor_banners WHERE sponsor_id = $1 AND status = 'pending_payment'`, [userId]);
      if (Number(n[0]!.n) >= MAX_PENDING_BANNERS) throw new ApiError(429, 'too_many_pending', 'Selesaikan atau batalkan banner yang menunggu pembayaran dulu');
      const amount = this.quote(input.slot, input.days, cities.length);
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO sponsor_banners (sponsor_id, slot, title, event_id, target_url, cities, starts_on, days, amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [userId, input.slot, input.title, input.eventId ?? null, targetUrl, cities, input.startsOn, input.days, amount],
      );
      return rows[0]!.id;
    });
    const key = `banners/${id}/${randomBytes(8).toString('hex')}.webp`;
    try {
      await this.storage.put(key, processed, 'image/webp');
      await this.pool.query('UPDATE sponsor_banners SET image_key = $2 WHERE id = $1', [id, key]);
    } catch (err) {
      await this.pool.query('DELETE FROM sponsor_banners WHERE id = $1', [id]);
      throw err;
    }
    return this.mineOne(userId, id);
  }

  async pay(userId: string, bannerId: string) {
    const b = await this.own(userId, bannerId);
    if (b.status !== 'pending_payment') throw new ApiError(409, 'banner_not_payable', 'Banner ini tidak menunggu pembayaran');
    const { rows } = await this.pool.query<{ past: boolean }>(`SELECT $1::date < ${TODAY} AS past`, [b.starts_on]);
    if (rows[0]!.past) throw new ApiError(409, 'start_passed', 'Tanggal mulai sudah lewat. Batalkan dan buat banner baru');
    return this.payments.create(userId, 'banner', bannerId, Number(b.amount), `Banner ${slotLabel(b.slot)} ${b.days} hari`, '?paid=banner');
  }

  async cancel(userId: string, bannerId: string): Promise<void> {
    const key = await withTx(this.pool, async (db) => {
      const { rows } = await db.query<{ status: string; image_key: string | null }>(
        'SELECT status, image_key FROM sponsor_banners WHERE id = $1 AND sponsor_id = $2 FOR UPDATE',
        [bannerId, userId],
      );
      if (!rows[0]) throw bannerNotFound();
      if (rows[0].status !== 'pending_payment') throw new ApiError(409, 'banner_not_cancellable', 'Banner yang sudah dibayar tidak bisa dibatalkan sendiri. Hubungi tim PaceTara');
      // Tautan Snap berlaku 24 jam dan tidak bisa ditarik kembali dengan pasti: selama masih bisa dibayar, banner
      // tidak dibatalkan agar sponsor tidak tertagih untuk banner yang sudah hilang.
      const { rows: payable } = await db.query(`SELECT ${PAYABLE.replace('{ref}', '$1')} AS payable`, [bannerId]);
      if (payable[0]?.payable) {
        throw new ApiError(409, 'payment_in_progress', 'Tautan pembayaran banner ini masih aktif (berlaku 24 jam sejak dibuat). Jika tidak dibayar, banner batal otomatis');
      }
      await db.query(`UPDATE sponsor_banners SET status = 'cancelled', image_key = NULL WHERE id = $1`, [bannerId]);
      return rows[0].image_key;
    });
    if (key) await this.storage.delete(key).catch(() => undefined);
  }

  async mine(userId: string) {
    const { rows } = await this.pool.query<BannerRow>(
      `SELECT ${COLS}, e.name AS event_name,
              COALESCE((SELECT sum(impressions) FROM sponsor_banner_stats s WHERE s.banner_id = b.id), 0) AS impressions,
              COALESCE((SELECT sum(clicks) FROM sponsor_banner_stats s WHERE s.banner_id = b.id), 0) AS clicks
         FROM sponsor_banners b LEFT JOIN events e ON e.id = b.event_id
        WHERE b.sponsor_id = $1 AND b.status <> 'cancelled' ORDER BY b.created_at DESC LIMIT 100`,
      [userId],
    );
    return { items: rows.map((r) => this.json(r)) };
  }

  /** Statistik harian satu banner milik sponsor. */
  async stats(userId: string, bannerId: string) {
    await this.own(userId, bannerId);
    const { rows } = await this.pool.query<{ day: string; impressions: number; clicks: number }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, impressions, clicks FROM sponsor_banner_stats WHERE banner_id = $1 ORDER BY day`,
      [bannerId],
    );
    const impressions = rows.reduce((a, r) => a + r.impressions, 0);
    const clicks = rows.reduce((a, r) => a + r.clicks, 0);
    return { days: rows, totals: { impressions, clicks, ctr: impressions ? Math.round((clicks / impressions) * 10_000) / 100 : 0 } };
  }

  // ---------- Aplikasi ----------

  /** Satu banner untuk slot + kota (+ event untuk detail event). Premium = tanpa banner. Area/kota di body, bukan URL. */
  async pick(userId: string, q: { slot: BannerSlot; city?: string; eventId?: string }) {
    const { rows: u } = await this.pool.query<{ plan: string }>('SELECT plan FROM users WHERE id = $1', [userId]);
    if (u[0]?.plan === 'premium') return { banner: null };
    if (q.slot === 'event_detail' && !q.eventId) return { banner: null };
    const { rows } = await this.pool.query<BannerRow>(
      `SELECT ${COLS} FROM sponsor_banners b LEFT JOIN events e ON e.id = b.event_id
        WHERE ${ACTIVE} AND b.slot = $1 AND b.image_key IS NOT NULL
          AND (cardinality(b.cities) = 0 OR lower($2) = ANY(b.cities))
          AND ($3::uuid IS NULL OR b.event_id = $3)
          AND (b.event_id IS NULL OR (e.removed_at IS NULL AND e.archived_at IS NULL))
        ORDER BY random() LIMIT 1`,
      [q.slot, q.city?.trim() ?? '', q.slot === 'event_detail' ? q.eventId : null],
    );
    const b = rows[0];
    if (!b) return { banner: null };
    return {
      banner: { id: b.id, title: b.title, imageUrl: `/v1/banners/${b.id}/image`, eventId: b.event_id, hasLink: Boolean(b.event_id || b.target_url), sponsored: true },
    };
  }

  /** Tayangan unik per pengguna per banner per hari (WIB). */
  async impression(userId: string, bannerId: string): Promise<void> {
    await this.activeOrThrow(bannerId);
    await this.count(userId, bannerId, 'impressions');
  }

  /** Klik: dicatat unik per hari, mengembalikan tujuan (event di aplikasi atau tautan https di browser luar). */
  async click(userId: string, bannerId: string) {
    const b = await this.activeOrThrow(bannerId);
    await this.count(userId, bannerId, 'clicks');
    return { eventId: b.event_id, url: b.target_url };
  }

  async image(userId: string, bannerId: string) {
    const { rows } = await this.pool.query<{ image_key: string | null }>(
      `SELECT b.image_key FROM sponsor_banners b WHERE b.id = $1 AND (b.sponsor_id = $2 OR (${ACTIVE}))`,
      [bannerId, userId],
    );
    if (!rows[0]?.image_key) throw bannerNotFound();
    return this.storage.get(rows[0].image_key);
  }

  // ---------- Panel super admin ----------

  async adminList(status: BannerRow['status']) {
    const { rows } = await this.pool.query<BannerRow>(
      `SELECT ${COLS}, e.name AS event_name, u.display_name AS sponsor_name,
              COALESCE((SELECT sum(impressions) FROM sponsor_banner_stats s WHERE s.banner_id = b.id), 0) AS impressions,
              COALESCE((SELECT sum(clicks) FROM sponsor_banner_stats s WHERE s.banner_id = b.id), 0) AS clicks
         FROM sponsor_banners b LEFT JOIN events e ON e.id = b.event_id LEFT JOIN users u ON u.id = b.sponsor_id
        WHERE b.status = $1 ORDER BY b.created_at ${status === 'pending_review' ? 'ASC' : 'DESC'} LIMIT 200`,
      [status],
    );
    return { items: rows.map((r) => ({ ...this.json(r), sponsor: r.sponsor_name ?? 'Pengguna dihapus', targetUrl: r.target_url })) };
  }

  async adminImage(bannerId: string) {
    const { rows } = await this.pool.query<{ image_key: string | null }>('SELECT image_key FROM sponsor_banners WHERE id = $1', [bannerId]);
    if (!rows[0]?.image_key) throw bannerNotFound();
    return this.storage.get(rows[0].image_key);
  }

  /** Setujui: jika disetujui setelah tanggal mulai, periode digeser ke hari ini agar sponsor tetap mendapat semua harinya. */
  async approve(adminId: string, bannerId: string) {
    const b = await withTx(this.pool, async (db) => {
      const b = await this.reviewForUpdate(db, bannerId);
      await db.query(
        `UPDATE sponsor_banners SET status = 'approved', starts_on = GREATEST(starts_on, ${TODAY}), reviewed_by = $2, reviewed_at = now() WHERE id = $1`,
        [bannerId, adminId],
      );
      await audit(db, adminId, 'banner.approve', { type: 'banner', id: bannerId }, { slot: b.slot, days: b.days, amount: Number(b.amount) });
      return b;
    });
    if (b.sponsor_id) {
      await this.notifications.notify([b.sponsor_id], {
        category: 'market',
        inbox: { type: 'banner_approved', data: { bannerId } },
        push: { title: 'Banner disetujui', body: `Banner "${b.title}" akan tayang sesuai jadwal`, data: { type: 'banner_approved', bannerId } },
      });
    }
    return { id: bannerId, status: 'approved' };
  }

  /** Tolak: refund biaya dilakukan admin di dasbor Midtrans (dicatat di alasan). Gambar dihapus. */
  async reject(adminId: string, bannerId: string, reason: string): Promise<void> {
    const b = await withTx(this.pool, async (db) => {
      const b = await this.reviewForUpdate(db, bannerId);
      await db.query(
        `UPDATE sponsor_banners SET status = 'rejected', reject_reason = $3, image_key = NULL, reviewed_by = $2, reviewed_at = now() WHERE id = $1`,
        [bannerId, adminId, reason],
      );
      await audit(db, adminId, 'banner.reject', { type: 'banner', id: bannerId }, { reason, amount: Number(b.amount) });
      return b;
    });
    if (b.image_key) await this.storage.delete(b.image_key).catch(() => undefined);
    if (b.sponsor_id) {
      await this.notifications.notify([b.sponsor_id], {
        category: 'market',
        inbox: { type: 'banner_rejected', data: { bannerId } },
        push: { title: 'Banner tidak disetujui', body: `Banner "${b.title}" tidak disetujui. Lihat alasannya di dasbor`, data: { type: 'banner_rejected', bannerId } },
      });
    }
  }

  /** Job worker: banner menunggu pembayaran > 2 hari dibatalkan (gambar dihapus), kecuali tautan bayarnya masih berlaku. */
  async cleanup(): Promise<number> {
    const { rows } = await this.pool.query<{ image_key: string | null }>(
      `WITH old AS (
         SELECT id, image_key FROM sponsor_banners b
          WHERE status = 'pending_payment' AND created_at < now() - interval '2 days' AND NOT ${PAYABLE.replace('{ref}', 'b.id')}
            FOR UPDATE
       )
       UPDATE sponsor_banners b SET status = 'cancelled', image_key = NULL FROM old WHERE b.id = old.id RETURNING old.image_key`,
    );
    for (const r of rows) if (r.image_key) await this.storage.delete(r.image_key).catch(() => undefined);
    return rows.length;
  }

  /** Hapus akun: banner yang belum dibayar dihapus beserta gambarnya; yang sudah dibayar tetap (catatan akuntansi) tanpa tautan akun. */
  async onAccountDeletion(db: Queryable, userId: string): Promise<string[]> {
    const { rows } = await db.query<{ image_key: string | null }>(
      `DELETE FROM sponsor_banners WHERE sponsor_id = $1 AND status IN ('pending_payment', 'cancelled') RETURNING image_key`,
      [userId],
    );
    await db.query('UPDATE sponsor_banners SET sponsor_id = NULL WHERE sponsor_id = $1', [userId]);
    await db.query('UPDATE sponsor_banners SET reviewed_by = NULL WHERE reviewed_by = $1', [userId]);
    return rows.map((r) => r.image_key).filter((k): k is string => Boolean(k));
  }

  // ---------- Bantuan ----------

  private async count(userId: string, bannerId: string, col: 'impressions' | 'clicks') {
    const { rows } = await this.pool.query<{ day: string }>(`SELECT to_char(${TODAY}, 'YYYY-MM-DD') AS day`);
    const day = rows[0]!.day;
    const fresh = await this.redis.set(`bn:${col === 'impressions' ? 'i' : 'c'}:${bannerId}:${day}:${userId}`, '1', 'EX', 172_800, 'NX');
    if (fresh !== 'OK') return;
    await this.pool.query(
      `INSERT INTO sponsor_banner_stats (banner_id, day, ${col}) VALUES ($1, $2, 1)
       ON CONFLICT (banner_id, day) DO UPDATE SET ${col} = sponsor_banner_stats.${col} + 1`,
      [bannerId, day],
    );
  }

  private async activeOrThrow(bannerId: string) {
    const { rows } = await this.pool.query<{ event_id: string | null; target_url: string | null }>(
      `SELECT b.event_id, b.target_url FROM sponsor_banners b WHERE b.id = $1 AND ${ACTIVE}`,
      [bannerId],
    );
    if (!rows[0]) throw bannerNotFound();
    return rows[0];
  }

  private async own(userId: string, bannerId: string) {
    const { rows } = await this.pool.query<BannerRow>(`SELECT ${COLS} FROM sponsor_banners b WHERE b.id = $1 AND b.sponsor_id = $2`, [bannerId, userId]);
    if (!rows[0]) throw bannerNotFound();
    return rows[0];
  }

  private async mineOne(userId: string, bannerId: string) {
    const { rows } = await this.pool.query<BannerRow>(
      `SELECT ${COLS}, e.name AS event_name, 0 AS impressions, 0 AS clicks FROM sponsor_banners b LEFT JOIN events e ON e.id = b.event_id WHERE b.id = $1 AND b.sponsor_id = $2`,
      [bannerId, userId],
    );
    return this.json(rows[0]!);
  }

  private async reviewForUpdate(db: Queryable, bannerId: string) {
    const { rows } = await db.query<BannerRow>(`SELECT ${COLS} FROM sponsor_banners b WHERE b.id = $1 FOR UPDATE`, [bannerId]);
    const b = rows[0];
    if (!b) throw bannerNotFound();
    if (b.status !== 'pending_review') throw new ApiError(409, 'banner_reviewed', 'Banner ini tidak menunggu tinjauan');
    return b;
  }

  private json(r: BannerRow) {
    const state =
      r.status !== 'approved' ? r.status : r.today < r.starts_on ? 'scheduled' : r.today > r.ends_on ? 'ended' : 'live';
    return {
      id: r.id,
      slot: r.slot,
      title: r.title,
      eventId: r.event_id,
      eventName: r.event_name ?? null,
      targetUrl: r.target_url,
      cities: r.cities,
      startsOn: r.starts_on,
      endsOn: r.ends_on,
      days: r.days,
      amount: Number(r.amount),
      status: r.status,
      state,
      rejectReason: r.reject_reason,
      imageUrl: r.image_key ? `/v1/banners/${r.id}/image` : null,
      impressions: Number(r.impressions ?? 0),
      clicks: Number(r.clicks ?? 0),
      createdAt: r.created_at.toISOString(),
    };
  }
}

/**
 * Gambar banner: jenis dari isi berkas, maks. 8 MB / 50 MP, rasio 2,4–3,6 (mendekati 3:1), dipotong tengah ke
 * 1200×400 dan di-encode ulang ke WebP sehingga semua metadata (EXIF/GPS) terbuang.
 */
export async function processBanner(input: Buffer): Promise<Buffer> {
  if (input.length === 0 || input.length > MAX_UPLOAD_BYTES) throw new ApiError(413, 'file_too_large', 'Ukuran gambar maksimal 8 MB');
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: 50_000_000 }).metadata();
  } catch {
    throw new ApiError(415, 'unsupported_image', 'Berkas bukan gambar yang didukung (JPG, PNG, WebP)');
  }
  if (!meta.format || !['jpeg', 'png', 'webp'].includes(meta.format) || !meta.width || !meta.height) {
    throw new ApiError(415, 'unsupported_image', 'Berkas bukan gambar yang didukung (JPG, PNG, WebP)');
  }
  const swap = (meta.orientation ?? 1) >= 5;
  const w = swap ? meta.height : meta.width;
  const h = swap ? meta.width : meta.height;
  const ratio = w / h;
  if (ratio < 2.4 || ratio > 3.6) throw new ApiError(422, 'invalid_ratio', `Rasio banner harus mendekati 3:1 (disarankan ${BANNER_W}×${BANNER_H} px)`);
  if (w < 900) throw new ApiError(422, 'image_too_small', `Lebar banner minimal 900 px (disarankan ${BANNER_W} px)`);
  return sharp(input, { limitInputPixels: 50_000_000 }).rotate().resize(BANNER_W, BANNER_H, { fit: 'cover' }).webp({ quality: 85 }).toBuffer();
}

function slotLabel(s: BannerSlot) {
  return { home: 'beranda', events: 'daftar event', event_detail: 'detail event' }[s];
}

function bannerNotFound() {
  return new ApiError(404, 'banner_not_found', 'Banner tidak ditemukan');
}
