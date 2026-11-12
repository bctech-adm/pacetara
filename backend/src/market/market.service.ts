import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type pg from 'pg';
import { audit } from '../admin/admin-auth.service.js';
import { ChatService } from '../chat/chat.service.js';
import { type Queryable, withTx } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { ENV, type Env } from '../config/env.js';
import { PG_POOL } from '../core.module.js';
import { FieldCrypto } from '../crypto/field-crypto.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { processImage } from '../storage/image.js';
import { StorageService } from '../storage/storage.service.js';
import { computeFee, outboundUrl, parseAffiliateTemplates, validateAffiliateUrl } from './rules.js';
import { MarketOrderSync, type OrderRow } from './market-orders.js';
import { mapAccountStatus, XenditApi, type XenditClient, XenditError } from './xendit.js';

export type ListingModel = 'listing_fee' | 'affiliate' | 'split';
export interface ListingInput {
  model: ListingModel;
  title: string;
  description: string;
  category: string;
  condition: string;
  price: number;
  city: string;
  affiliateUrl?: string;
  stock?: number;
}

/** Listing aktif maksimum per penjual dan listing baru per 24 jam. */
export const MAX_ACTIVE_LISTINGS = 20;
/** Pesanan yang dibatalkan pembeli per 24 jam sebelum tidak bisa memesan lagi (anti penahanan stok). */
const MAX_CANCELLED_PER_DAY = 5;
export const LISTINGS_PER_DAY = 10;
/** "Hubungi penjual" baru per 24 jam (anti-spam chat ke orang asing). */
export const CONTACTS_PER_DAY = 20;
/** Sengketa bisa dibuka sampai sekian hari setelah dibayar/dikirim. */
export const DISPUTE_DAYS = 7;

interface ListingRow {
  id: string;
  seller_id: string;
  model: ListingModel;
  title: string;
  description: string;
  category: string;
  condition: string;
  price: string;
  city: string;
  affiliate_url: string | null;
  stock: number | null;
  status: 'pending_payment' | 'active' | 'sold' | 'expired' | 'closed';
  active_until: Date | null;
  boosted_until: Date | null;
  clicks: number;
  hidden_at: Date | null;
  created_at: Date;
  seller_name: string;
  seller_level: number;
  photo_ids: string[] | null;
}

/** Listing tampil: aktif, belum lewat masa tayang, tidak diturunkan/disembunyikan, penjual aktif; split hanya dari akun penjual live. */
const VISIBLE = `l.status = 'active' AND l.removed_at IS NULL AND l.hidden_at IS NULL AND (l.active_until IS NULL OR l.active_until > now())
  AND u.status = 'active'
  AND (l.model <> 'split' OR (u.verification_level >= 2
    AND EXISTS (SELECT 1 FROM market_seller_accounts sa WHERE sa.user_id = l.seller_id AND sa.status = 'live')))`;

const LISTING_COLS = `l.id, l.seller_id, l.model, l.title, l.description, l.category, l.condition, l.price, l.city, l.affiliate_url, l.stock,
  l.status, l.active_until, l.boosted_until, l.clicks, l.hidden_at, l.created_at, u.display_name AS seller_name, u.verification_level AS seller_level,
  (SELECT array_agg(p.id ORDER BY p.position) FROM market_listing_photos p WHERE p.listing_id = l.id) AS photo_ids`;

/**
 * Marketplace (modul 3.2). Tiga model per listing:
 * - `listing_fee`: penjual membayar biaya pasang/boost lewat Midtrans di dasbor web; transaksi di luar aplikasi.
 * - `affiliate`: tautan ke toko penjual di marketplace lain (dengan template afiliasi PaceTara bila ada).
 * - `split`: pembeli membayar lewat invoice Xendit di akun Xendit penjual (MANAGED, wajib Level 2); komisi PaceTara
 *   dipotong otomatis lewat split rule. PaceTara tidak menampung dana pembeli.
 * Pembeli menghubungi penjual lewat chat aplikasi. Kebijakan transaksi wajib disetujui sebelum memasang atau membeli.
 */
@Injectable()
export class MarketService {
  private readonly logger = new Logger('Market');
  private readonly templates: Map<string, string>;

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(ENV) private readonly env: Env,
    private readonly crypto: FieldCrypto,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
    private readonly chat: ChatService,
    private readonly payments: PaymentsService,
    @Inject(XenditApi) private readonly xendit: XenditClient,
    private readonly orderSync: MarketOrderSync,
  ) {
    this.templates = parseAffiliateTemplates(env.AFFILIATE_TEMPLATES);
  }

  // ---------- Konfigurasi dan kebijakan ----------

  async config(userId: string) {
    const { rows } = await this.pool.query<{ market_policy_version: string | null; verification_level: number }>(
      'SELECT market_policy_version, verification_level FROM users WHERE id = $1',
      [userId],
    );
    return {
      policyVersion: this.env.MARKET_POLICY_VERSION,
      policyUrl: `${this.env.PUBLIC_WEB_URL}/kebijakan-transaksi`,
      policyAccepted: rows[0]?.market_policy_version === this.env.MARKET_POLICY_VERSION,
      level: rows[0]?.verification_level ?? 0,
      splitEnabled: this.xendit.enabled,
      fee: { percent: this.env.MARKET_FEE_PERCENT, flat: this.env.MARKET_FEE_FLAT },
      listingFee: { amount: this.env.MARKET_LISTING_FEE, days: this.env.MARKET_LISTING_DAYS },
      boost: { amount: this.env.MARKET_BOOST_FEE, days: this.env.MARKET_BOOST_DAYS },
      dashboardUrl: this.env.DASHBOARD_URL,
    };
  }

  async acceptPolicy(userId: string, version: string) {
    if (version !== this.env.MARKET_POLICY_VERSION) {
      throw new ApiError(428, 'policy_outdated', 'Kebijakan transaksi sudah diperbarui. Baca dan setujui versi terbaru');
    }
    await this.pool.query('UPDATE users SET market_policy_version = $2, market_policy_accepted_at = now() WHERE id = $1', [userId, version]);
    return { accepted: true, version };
  }

  private async assertPolicy(db: Queryable, userId: string) {
    const { rows } = await db.query<{ market_policy_version: string | null }>('SELECT market_policy_version FROM users WHERE id = $1', [userId]);
    if (rows[0]?.market_policy_version !== this.env.MARKET_POLICY_VERSION) {
      throw new ApiError(428, 'policy_required', 'Setujui kebijakan transaksi marketplace dulu', { policyVersion: this.env.MARKET_POLICY_VERSION });
    }
  }

  // ---------- Listing ----------

  /** Pencarian listing tayang. Urutan: yang di-boost dulu, lalu terbaru. Kursor = offset (maks. 500). */
  async search(q: { q?: string; category?: string; city?: string; model?: ListingModel; offset: number; limit: number }) {
    const where = [VISIBLE];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.q) add(`l.title ILIKE ?`, `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    if (q.category) add('l.category = ?', q.category);
    if (q.city) add('lower(l.city) = lower(?)', q.city);
    if (q.model) add('l.model = ?', q.model);
    params.push(q.limit + 1, q.offset);
    const { rows } = await this.pool.query<ListingRow>(
      `SELECT ${LISTING_COLS} FROM market_listings l JOIN users u ON u.id = l.seller_id
        WHERE ${where.join(' AND ')}
        ORDER BY (l.boosted_until > now()) DESC NULLS LAST, l.created_at DESC, l.id
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const more = rows.length > q.limit;
    return { items: rows.slice(0, q.limit).map((r) => this.listingJson(r)), nextOffset: more && q.offset + q.limit < 500 ? q.offset + q.limit : null };
  }

  async detail(userId: string, listingId: string) {
    const r = await this.visibleListing(this.pool, userId, listingId);
    const { rows: acct } = await this.pool.query<{ status: string }>('SELECT status FROM market_seller_accounts WHERE user_id = $1', [r.seller_id]);
    const mine = r.seller_id === userId;
    return {
      ...this.listingJson(r),
      mine,
      description: r.description,
      canBuy: !mine && r.model === 'split' && r.status === 'active' && (r.stock ?? 0) > 0 && acct[0]?.status === 'live' && this.xendit.enabled,
      ...(mine ? { clicks: r.clicks, hidden: Boolean(r.hidden_at) } : {}),
    };
  }

  async photo(userId: string, listingId: string, photoId: string) {
    await this.visibleListing(this.pool, userId, listingId);
    const { rows } = await this.pool.query<{ storage_key: string }>('SELECT storage_key FROM market_listing_photos WHERE id = $1 AND listing_id = $2', [photoId, listingId]);
    if (!rows[0]) throw listingNotFound();
    return this.storage.get(rows[0].storage_key);
  }

  /**
   * Pasang listing. Foto (1–6) diproses sebelum apa pun disimpan. `listing_fee` mulai `pending_payment` dan tayang
   * setelah dibayar di dasbor web; `affiliate`/`split` langsung tayang selama MARKET_LISTING_DAYS. `split` wajib
   * Level 2 + akun penjual Xendit `live`.
   */
  async create(userId: string, input: ListingInput, photos: Buffer[]) {
    if (photos.length < 1 || photos.length > 6) throw new ApiError(400, 'photos_required', 'Tambahkan 1–6 foto barang');
    let affiliateUrl: string | null = null;
    if (input.model === 'affiliate') {
      affiliateUrl = validateAffiliateUrl(input.affiliateUrl ?? '');
      if (!affiliateUrl) throw new ApiError(400, 'invalid_affiliate_url', 'Tautan harus https ke Tokopedia, Shopee, Lazada, Blibli, Bukalapak, TikTok Shop, atau Zalora');
    }
    if (input.model === 'split') {
      if (!this.xendit.enabled) throw new ApiError(503, 'not_configured', 'Pembayaran di aplikasi belum tersedia');
      if (input.stock === undefined) throw new ApiError(400, 'stock_required', 'Isi jumlah stok');
    }
    // Prasyarat dicek sebelum foto diproses.
    await withTx(this.pool, (db) => this.assertCanList(db, userId, input.model));
    const processed: Buffer[] = [];
    for (const p of photos) processed.push(await processImage(p, { size: 1600 }));

    const listingId = await withTx(this.pool, async (db) => {
      await this.assertCanList(db, userId, input.model);
      const active = input.model !== 'listing_fee';
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO market_listings (seller_id, model, title, description, category, condition, price, city, affiliate_url, stock, status, active_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $12 THEN now() + make_interval(days => $13) END) RETURNING id`,
        [
          userId,
          input.model,
          input.title,
          input.description,
          input.category,
          input.condition,
          input.price,
          input.city,
          affiliateUrl,
          input.model === 'split' ? input.stock : null,
          active ? 'active' : 'pending_payment',
          active,
          this.env.MARKET_LISTING_DAYS,
        ],
      );
      return rows[0]!.id;
    });
    const keys: string[] = [];
    try {
      for (let i = 0; i < processed.length; i++) {
        const key = `market/${userId}/${listingId}/${randomBytes(8).toString('hex')}.webp`;
        await this.storage.put(key, processed[i]!, 'image/webp');
        keys.push(key);
        await this.pool.query('INSERT INTO market_listing_photos (listing_id, position, storage_key) VALUES ($1, $2, $3)', [listingId, i, key]);
      }
    } catch (err) {
      await this.pool.query('DELETE FROM market_listings WHERE id = $1', [listingId]);
      for (const k of keys) await this.storage.delete(k).catch(() => undefined);
      throw err;
    }
    return this.detail(userId, listingId);
  }

  private async assertCanList(db: Queryable, userId: string, model: ListingModel, opts: { countToday?: boolean; countActive?: boolean } = {}) {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`market-list:${userId}`]);
    await this.assertPolicy(db, userId);
    if (model === 'split') {
      const { rows } = await db.query<{ verification_level: number; acct: string | null }>(
        `SELECT u.verification_level, sa.status AS acct FROM users u LEFT JOIN market_seller_accounts sa ON sa.user_id = u.id WHERE u.id = $1`,
        [userId],
      );
      if ((rows[0]?.verification_level ?? 0) < 2) {
        throw new ApiError(403, 'verification_required', 'Verifikasi KTP (Level 2) dulu untuk berjualan dengan pembayaran di aplikasi', { requiredLevel: 2 });
      }
      if (rows[0]?.acct !== 'live') throw new ApiError(409, 'seller_not_live', 'Aktifkan dan selesaikan verifikasi akun pembayaran Xendit dulu');
    }
    const { rows: n } = await db.query<{ active: string; today: string }>(
      `SELECT count(*) FILTER (WHERE status IN ('active', 'pending_payment') AND removed_at IS NULL) AS active,
              count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS today
         FROM market_listings WHERE seller_id = $1`,
      [userId],
    );
    if (opts.countActive !== false && Number(n[0]!.active) >= MAX_ACTIVE_LISTINGS) {
      throw new ApiError(409, 'listing_limit', `Maksimal ${MAX_ACTIVE_LISTINGS} listing aktif`);
    }
    if (opts.countToday !== false && Number(n[0]!.today) >= LISTINGS_PER_DAY) throw new ApiError(429, 'listing_rate_limited', `Maksimal ${LISTINGS_PER_DAY} listing baru per hari`);
  }

  async update(userId: string, listingId: string, patch: { title?: string; description?: string; price?: number; city?: string; stock?: number; status?: 'sold' | 'closed' }) {
    await withTx(this.pool, async (db) => {
      const l = await this.ownListingForUpdate(db, userId, listingId);
      // Isi yang dilaporkan dibekukan sampai ditinjau, agar bukti tidak bisa diganti sebelum admin melihatnya.
      if (l.held_at) throw new ApiError(409, 'content_held', 'Listing sedang ditinjau karena dilaporkan dan belum bisa diubah');
      if (patch.stock !== undefined && l.model !== 'split') throw new ApiError(400, 'stock_not_applicable', 'Stok hanya untuk listing pembayaran di aplikasi');
      if (patch.status && !['active', 'pending_payment'].includes(l.status)) throw new ApiError(409, 'listing_closed', 'Listing ini sudah tidak tayang');
      const sets: string[] = [];
      const values: unknown[] = [listingId];
      const add = (col: string, v: unknown) => {
        values.push(v);
        sets.push(`${col} = $${values.length}`);
      };
      if (patch.title !== undefined) add('title', patch.title);
      if (patch.description !== undefined) add('description', patch.description);
      if (patch.price !== undefined) add('price', patch.price);
      if (patch.city !== undefined) add('city', patch.city);
      if (patch.stock !== undefined) add('stock', patch.stock);
      if (patch.status !== undefined) add('status', patch.status);
      if (sets.length) await db.query(`UPDATE market_listings SET ${sets.join(', ')} WHERE id = $1`, values);
    });
    return this.detail(userId, listingId);
  }

  /** Perpanjang masa tayang gratis untuk afiliasi/split; listing berbayar diperpanjang dengan membayar lagi di dasbor web. */
  async renew(userId: string, listingId: string) {
    await withTx(this.pool, async (db) => {
      const l = await this.ownListingForUpdate(db, userId, listingId);
      if (l.model === 'listing_fee') throw new ApiError(409, 'payment_required', 'Listing berbayar diperpanjang lewat dasbor web');
      if (!['active', 'expired'].includes(l.status)) throw new ApiError(409, 'listing_closed', 'Listing ini sudah tidak tayang');
      if (l.held_at) throw new ApiError(409, 'content_held', 'Listing sedang ditinjau karena dilaporkan dan belum bisa diperpanjang');
      if (l.status === 'expired') {
        // Kembali tayang = dihitung lagi ke batas listing aktif (dan syarat Level 2/akun live untuk split).
        await this.assertCanList(db, userId, l.model, { countToday: false });
      } else if (l.model === 'split') {
        await this.assertCanList(db, userId, l.model, { countToday: false, countActive: false });
      }
      await this.assertPolicy(db, userId);
      await db.query(`UPDATE market_listings SET status = 'active', active_until = now() + make_interval(days => $2) WHERE id = $1`, [
        listingId,
        this.env.MARKET_LISTING_DAYS,
      ]);
    });
    return this.detail(userId, listingId);
  }

  async remove(userId: string, listingId: string): Promise<void> {
    const keys = await withTx(this.pool, async (db) => {
      await this.ownListingForUpdate(db, userId, listingId);
      const { rows: open } = await db.query(`SELECT 1 FROM market_orders WHERE listing_id = $1 AND status IN ('pending', 'paid', 'shipped', 'disputed') LIMIT 1`, [listingId]);
      if (open[0]) throw new ApiError(409, 'open_orders', 'Listing ini masih punya pesanan berjalan. Tutup listing saja');
      const { rows: held } = await db.query<{ held_at: Date | null }>('SELECT held_at FROM market_listings WHERE id = $1', [listingId]);
      if (held[0]?.held_at) throw new ApiError(409, 'content_held', 'Listing sedang ditinjau karena dilaporkan dan belum bisa dihapus');
      const { rows } = await db.query<{ storage_key: string }>('SELECT storage_key FROM market_listing_photos WHERE listing_id = $1', [listingId]);
      await db.query('DELETE FROM market_listings WHERE id = $1', [listingId]);
      return rows.map((r) => r.storage_key);
    });
    for (const k of keys) await this.storage.delete(k).catch(() => undefined);
  }

  async mine(userId: string) {
    const { rows } = await this.pool.query<ListingRow>(
      `SELECT ${LISTING_COLS} FROM market_listings l JOIN users u ON u.id = l.seller_id
        WHERE l.seller_id = $1 AND l.removed_at IS NULL ORDER BY l.created_at DESC LIMIT 100`,
      [userId],
    );
    return { items: rows.map((r) => ({ ...this.listingJson(r), clicks: r.clicks, hidden: Boolean(r.hidden_at) })) };
  }

  /** "Hubungi penjual": catat kontak (membuka chat pribadi untuk pasangan ini) lalu buka percakapan. */
  async contact(userId: string, listingId: string) {
    const l = await this.visibleListing(this.pool, userId, listingId);
    if (l.seller_id === userId) throw new ApiError(400, 'invalid_target', 'Ini listing milikmu sendiri');
    await withTx(this.pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`market-contact:${userId}`]);
      const { rows: exists } = await db.query('SELECT 1 FROM market_contacts WHERE listing_id = $1 AND buyer_id = $2', [listingId, userId]);
      if (exists[0]) return;
      const { rows } = await db.query<{ n: string }>(`SELECT count(*) AS n FROM market_contacts WHERE buyer_id = $1 AND created_at > now() - interval '24 hours'`, [userId]);
      if (Number(rows[0]!.n) >= CONTACTS_PER_DAY) throw new ApiError(429, 'contact_rate_limited', `Maksimal ${CONTACTS_PER_DAY} penjual baru dihubungi per hari`);
      await db.query('INSERT INTO market_contacts (listing_id, buyer_id, seller_id) VALUES ($1, $2, $3)', [listingId, userId, l.seller_id]);
    });
    return this.chat.direct(userId, l.seller_id);
  }

  /** Tautan keluar listing afiliasi (dihitung sebagai klik). Dibuka aplikasi di browser luar. */
  async go(userId: string, listingId: string) {
    const l = await this.visibleListing(this.pool, userId, listingId);
    if (l.model !== 'affiliate' || !l.affiliate_url) throw new ApiError(409, 'not_affiliate', 'Listing ini tidak punya tautan toko');
    if (l.seller_id !== userId) await this.pool.query('UPDATE market_listings SET clicks = clicks + 1 WHERE id = $1', [listingId]);
    return { url: outboundUrl(l.affiliate_url, this.templates) };
  }

  /** Dasbor web: bayar biaya pasang (atau perpanjang) atau boost lewat Midtrans. */
  async pay(userId: string, listingId: string, purpose: 'listing_fee' | 'listing_boost') {
    const l = await withTx(this.pool, (db) => this.ownListingForUpdate(db, userId, listingId));
    if (purpose === 'listing_fee') {
      if (l.model !== 'listing_fee') throw new ApiError(409, 'not_listing_fee', 'Listing ini tidak memakai biaya pasang');
      if (!['pending_payment', 'expired', 'active'].includes(l.status)) throw new ApiError(409, 'listing_closed', 'Listing ini sudah tidak tayang');
    } else if (l.status !== 'active') {
      throw new ApiError(409, 'listing_not_active', 'Hanya listing yang tayang yang bisa dinaikkan');
    }
    const amount = purpose === 'listing_fee' ? this.env.MARKET_LISTING_FEE : this.env.MARKET_BOOST_FEE;
    const label = purpose === 'listing_fee' ? `Biaya pasang listing ${this.env.MARKET_LISTING_DAYS} hari` : `Boost listing ${this.env.MARKET_BOOST_DAYS} hari`;
    return this.payments.create(userId, purpose, listingId, amount, label, '?paid=listing');
  }

  // ---------- Akun penjual (Xendit) ----------

  async seller(userId: string) {
    const { rows } = await this.pool.query<{ status: string; suspended_reason: string | null }>(
      'SELECT status, suspended_reason FROM market_seller_accounts WHERE user_id = $1',
      [userId],
    );
    return { enabled: this.xendit.enabled, status: rows[0]?.status ?? null, suspendedReason: rows[0]?.suspended_reason ?? null };
  }

  /**
   * Aktifkan pembayaran di aplikasi: buat sub-akun Xendit MANAGED dengan email terverifikasi penjual. Xendit mengirim
   * undangan ke email itu; penjual menyelesaikan verifikasi di Xendit, lalu status menjadi `live`.
   */
  async activateSeller(userId: string) {
    if (!this.xendit.enabled) throw new ApiError(503, 'not_configured', 'Pembayaran di aplikasi belum tersedia');
    const { email, name } = await withTx(this.pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`market-seller:${userId}`]);
      await this.assertPolicy(db, userId);
      const { rows } = await db.query<{ verification_level: number; email_enc: Buffer | null; email_verified_at: Date | null; display_name: string }>(
        'SELECT verification_level, email_enc, email_verified_at, display_name FROM users WHERE id = $1',
        [userId],
      );
      const u = rows[0]!;
      if (u.verification_level < 2) throw new ApiError(403, 'verification_required', 'Verifikasi KTP (Level 2) dulu untuk berjualan dengan pembayaran di aplikasi', { requiredLevel: 2 });
      const { rows: acct } = await db.query('SELECT 1 FROM market_seller_accounts WHERE user_id = $1', [userId]);
      if (acct[0]) throw new ApiError(409, 'seller_exists', 'Akun pembayaran sudah dibuat. Periksa email undangan dari Xendit');
      if (!u.email_enc || !u.email_verified_at) throw new ApiError(409, 'email_required', 'Akun butuh email terverifikasi');
      return { email: this.crypto.decryptString(u.email_enc, `users.email:${userId}`), name: u.display_name };
    });
    let account;
    try {
      account = await this.xendit.createManagedAccount(email, name);
    } catch (err) {
      this.logger.warn(`Gagal membuat akun Xendit: ${err instanceof Error ? err.message : 'unknown'}`);
      throw new ApiError(502, 'xendit_unavailable', 'Gagal menghubungi Xendit. Coba lagi');
    }
    await this.pool.query(
      `INSERT INTO market_seller_accounts (user_id, xendit_account_id, status) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, account.id, mapAccountStatus(account.status)],
    );
    return this.seller(userId);
  }

  /** Muat ulang status akun dari Xendit (tombol "Perbarui status" dan callback akun). */
  async refreshSeller(userId: string) {
    const { rows } = await this.pool.query<{ xendit_account_id: string; status: string }>('SELECT xendit_account_id, status FROM market_seller_accounts WHERE user_id = $1', [userId]);
    if (!rows[0]) throw new ApiError(404, 'seller_not_found', 'Akun pembayaran belum dibuat');
    await this.syncAccount(rows[0].xendit_account_id);
    return this.seller(userId);
  }

  private async syncAccount(accountId: string) {
    const acct = await this.xendit.getAccount(accountId);
    const next = mapAccountStatus(acct.status);
    const { rows } = await this.pool.query<{ user_id: string | null; prev: string }>(
      `UPDATE market_seller_accounts sa SET status = $2 FROM (SELECT status AS prev FROM market_seller_accounts WHERE xendit_account_id = $1) old
        WHERE sa.xendit_account_id = $1 AND sa.status <> 'suspended' RETURNING sa.user_id, old.prev`,
      [accountId, next],
    );
    const r = rows[0];
    if (r?.user_id && next === 'live' && r.prev !== 'live') {
      await this.notifications.notify([r.user_id], {
        category: 'market',
        inbox: { type: 'market_seller_live', data: {} },
        push: { title: 'Pembayaran di aplikasi aktif', body: 'Kamu sekarang bisa memasang listing dengan pembayaran lewat aplikasi', data: { type: 'market_seller_live' } },
      });
    }
  }

  // ---------- Pesanan (split payment) ----------

  async createOrder(userId: string, listingId: string, qty: number) {
    if (!this.xendit.enabled) throw new ApiError(503, 'not_configured', 'Pembayaran di aplikasi belum tersedia');
    const order = await withTx(this.pool, async (db) => {
      await this.assertPolicy(db, userId);
      const { rows } = await db.query<ListingRow & { acct_id: string | null; acct_status: string | null }>(
        `SELECT ${LISTING_COLS}, sa.xendit_account_id AS acct_id, sa.status AS acct_status
           FROM market_listings l JOIN users u ON u.id = l.seller_id LEFT JOIN market_seller_accounts sa ON sa.user_id = l.seller_id
          WHERE l.id = $1 AND ${VISIBLE} FOR UPDATE OF l`,
        [listingId],
      );
      const l = rows[0];
      if (!l) throw listingNotFound();
      if (l.seller_id === userId) throw new ApiError(400, 'invalid_target', 'Tidak bisa membeli barang sendiri');
      if (l.model !== 'split' || l.acct_status !== 'live' || !l.acct_id) throw new ApiError(409, 'not_purchasable', 'Barang ini tidak dijual lewat pembayaran di aplikasi');
      if ((l.stock ?? 0) < qty) throw new ApiError(409, 'out_of_stock', 'Stok tidak cukup');
      // Kunci per pembeli: hitungan di bawah tidak bisa dilewati dengan permintaan bersamaan ke listing berbeda.
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`market-buyer:${userId}`]);
      const { rows: pend } = await db.query<{ n: string; here: string; cancelled: string }>(
        `SELECT count(*) FILTER (WHERE status = 'pending') AS n,
                count(*) FILTER (WHERE status = 'pending' AND listing_id = $2) AS here,
                count(*) FILTER (WHERE status = 'cancelled' AND created_at > now() - interval '24 hours') AS cancelled
           FROM market_orders WHERE buyer_id = $1`,
        [userId, listingId],
      );
      if (Number(pend[0]!.n) >= 5) throw new ApiError(429, 'too_many_pending', 'Selesaikan atau batalkan pesanan yang menunggu pembayaran dulu');
      // Satu pesanan menunggu per listing, dan siklus batal lalu pesan ulang dibatasi: stok penjual tidak bisa ditahan terus.
      if (Number(pend[0]!.here) >= 1) throw new ApiError(409, 'order_pending', 'Kamu masih punya pesanan menunggu pembayaran untuk barang ini');
      if (Number(pend[0]!.cancelled) >= MAX_CANCELLED_PER_DAY) {
        throw new ApiError(429, 'too_many_cancelled', 'Terlalu banyak pesanan dibatalkan hari ini. Coba lagi besok');
      }
      // Stok dipesan saat pesanan dibuat dan dikembalikan jika kedaluwarsa/dibatalkan.
      await db.query('UPDATE market_listings SET stock = stock - $2 WHERE id = $1', [listingId, qty]);
      const amount = Number(l.price) * qty;
      const fee = computeFee(amount, this.env.MARKET_FEE_PERCENT, this.env.MARKET_FEE_FLAT);
      const externalId = `PT-MO-${randomBytes(9).toString('base64url')}`;
      const { rows: o } = await db.query<OrderRow>(
        `INSERT INTO market_orders (external_id, listing_id, buyer_id, seller_id, xendit_account_id, title, qty, unit_price, amount, fee_amount, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending') RETURNING *`,
        [externalId, listingId, userId, l.seller_id, l.acct_id, l.title, qty, Number(l.price), amount, fee],
      );
      return o[0]!;
    });
    try {
      const splitRule = Number(order.fee_amount) > 0 ? await this.splitRuleId() : null;
      const inv = await this.xendit.createInvoice(order.xendit_account_id, splitRule, {
        externalId: order.external_id,
        amount: Number(order.amount),
        description: `PaceTara: ${order.title} x${order.qty}`,
        successUrl: `${this.env.PUBLIC_WEB_URL}/bayar/selesai`,
        failureUrl: `${this.env.PUBLIC_WEB_URL}/bayar/gagal`,
      });
      if (!inv.invoice_url?.startsWith('https://')) throw new XenditError(0);
      await this.pool.query('UPDATE market_orders SET xendit_invoice_id = $2, invoice_url = $3 WHERE id = $1', [order.id, inv.id, inv.invoice_url]);
    } catch (err) {
      await this.orderSync.closeOrder(order.id, 'cancelled');
      this.logger.warn(`Gagal membuat invoice Xendit: ${err instanceof Error ? err.message : 'unknown'}`);
      throw new ApiError(502, 'xendit_unavailable', 'Gagal membuat tagihan pembayaran. Coba lagi');
    }
    return this.order(userId, order.id);
  }

  /** Split rule komisi dibuat sekali per besaran (persen/flat) lalu dipakai ulang. */
  private async splitRuleId(): Promise<string> {
    const key = `xendit_split_rule:${this.env.MARKET_FEE_PERCENT}:${this.env.MARKET_FEE_FLAT}`;
    const { rows } = await this.pool.query<{ value: string }>('SELECT value FROM provider_settings WHERE key = $1', [key]);
    if (rows[0]) return rows[0].value;
    const rule = await this.xendit.createSplitRule({
      name: `PaceTara ${this.env.MARKET_FEE_PERCENT}% + ${this.env.MARKET_FEE_FLAT}`,
      percent: this.env.MARKET_FEE_PERCENT,
      flat: this.env.MARKET_FEE_FLAT,
      destinationAccountId: this.env.XENDIT_MASTER_ACCOUNT_ID,
      reference: 'pacetara-fee',
    });
    await this.pool.query('INSERT INTO provider_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, rule.id]);
    const { rows: again } = await this.pool.query<{ value: string }>('SELECT value FROM provider_settings WHERE key = $1', [key]);
    return again[0]!.value;
  }

  async orders(userId: string, role: 'buyer' | 'seller') {
    const { rows } = await this.pool.query<OrderRow>(
      `SELECT o.*, b.display_name AS buyer_name, s.display_name AS seller_name FROM market_orders o
         LEFT JOIN users b ON b.id = o.buyer_id LEFT JOIN users s ON s.id = o.seller_id
        WHERE ${role === 'buyer' ? 'o.buyer_id' : 'o.seller_id'} = $1 ORDER BY o.created_at DESC LIMIT 100`,
      [userId],
    );
    return { items: rows.map((r) => this.orderJson(r, userId)) };
  }

  async order(userId: string, orderId: string) {
    const { rows } = await this.pool.query<OrderRow>(
      `SELECT o.*, b.display_name AS buyer_name, s.display_name AS seller_name FROM market_orders o
         LEFT JOIN users b ON b.id = o.buyer_id LEFT JOIN users s ON s.id = o.seller_id
        WHERE o.id = $1 AND (o.buyer_id = $2 OR o.seller_id = $2)`,
      [orderId, userId],
    );
    if (!rows[0]) throw orderNotFound();
    return this.orderJson(rows[0], userId);
  }

  async ship(userId: string, orderId: string, trackingNote: string | undefined) {
    const o = await withTx(this.pool, async (db) => {
      const o = await this.orderForUpdate(db, orderId, userId, 'seller');
      if (o.status !== 'paid') throw new ApiError(409, 'invalid_order_state', 'Hanya pesanan yang sudah dibayar yang bisa ditandai dikirim');
      await db.query(`UPDATE market_orders SET status = 'shipped', shipped_at = now(), tracking_note = $2 WHERE id = $1`, [orderId, trackingNote ?? null]);
      return o;
    });
    if (o.buyer_id) {
      await this.notifications.notify([o.buyer_id], {
        category: 'market',
        actorId: userId,
        inbox: { type: 'market_order_shipped', data: { orderId } },
        push: { title: 'Pesanan dikirim', body: `${o.title} sudah dikirim penjual`, data: { type: 'market_order_shipped', orderId } },
      });
    }
    return this.order(userId, orderId);
  }

  async complete(userId: string, orderId: string) {
    const o = await withTx(this.pool, async (db) => {
      const o = await this.orderForUpdate(db, orderId, userId, 'buyer');
      if (!['paid', 'shipped'].includes(o.status)) throw new ApiError(409, 'invalid_order_state', 'Pesanan ini tidak bisa diselesaikan');
      await db.query(`UPDATE market_orders SET status = 'completed', completed_at = now() WHERE id = $1`, [orderId]);
      return o;
    });
    await this.orderSync.notifyCompleted(o);
    return this.order(userId, orderId);
  }

  async dispute(userId: string, orderId: string, reason: string) {
    const o = await withTx(this.pool, async (db) => {
      const o = await this.orderForUpdate(db, orderId, userId, 'buyer');
      if (!['paid', 'shipped'].includes(o.status)) throw new ApiError(409, 'invalid_order_state', 'Sengketa hanya untuk pesanan yang sudah dibayar dan belum selesai');
      const since = o.shipped_at ?? o.paid_at;
      if (since && Date.now() - since.getTime() > DISPUTE_DAYS * 86_400_000) throw new ApiError(409, 'dispute_window_closed', `Sengketa hanya bisa dibuka ${DISPUTE_DAYS} hari setelah pesanan dibayar/dikirim`);
      await db.query(`UPDATE market_orders SET status = 'disputed', dispute_opened_at = now(), dispute_reason_enc = $2 WHERE id = $1`, [
        orderId,
        this.crypto.encrypt(reason, `market_orders.dispute:${orderId}`),
      ]);
      return o;
    });
    if (o.seller_id) {
      await this.notifications.notify([o.seller_id], {
        category: 'market',
        actorId: userId,
        inbox: { type: 'market_order_disputed', data: { orderId } },
        push: { title: 'Pembeli membuka sengketa', body: `Pesanan ${o.title} ditinjau tim PaceTara`, data: { type: 'market_order_disputed', orderId } },
      });
    }
    return this.order(userId, orderId);
  }

  /** Pembeli membatalkan pesanan yang belum dibayar (invoice di Xendit ikut dikedaluwarsakan). */
  async cancel(userId: string, orderId: string) {
    const o = await withTx(this.pool, (db) => this.orderForUpdate(db, orderId, userId, 'buyer'));
    if (o.status !== 'pending') throw new ApiError(409, 'invalid_order_state', 'Hanya pesanan yang belum dibayar yang bisa dibatalkan');
    if (o.xendit_invoice_id) {
      // Pastikan belum dibayar di detik terakhir sebelum membatalkan.
      const inv = await this.xendit.getInvoice(o.xendit_account_id, o.xendit_invoice_id).catch(() => null);
      if (inv && ['PAID', 'SETTLED'].includes((inv.status ?? '').toUpperCase())) {
        await this.orderSync.applyInvoice(o.xendit_account_id, o.xendit_invoice_id);
        throw new ApiError(409, 'already_paid', 'Pesanan ini sudah dibayar');
      }
      await this.xendit.expireInvoice(o.xendit_account_id, o.xendit_invoice_id).catch(() => undefined);
    }
    await this.orderSync.closeOrder(orderId, 'cancelled');
    return this.order(userId, orderId);
  }

  /**
   * Callback invoice Xendit. Token header diperiksa dulu; isi tidak dipercaya: invoice diambil ulang dari Xendit
   * dengan akun penjual yang tercatat di pesanan kita.
   */
  async invoiceCallback(token: unknown, body: Record<string, unknown>): Promise<void> {
    if (!this.xendit.enabled) throw new ApiError(503, 'not_configured', 'Pembayaran di aplikasi belum tersedia');
    if (!this.xendit.verifyCallbackToken(token)) throw new ApiError(401, 'invalid_callback_token', 'Token callback tidak valid');
    const externalId = typeof body.external_id === 'string' ? body.external_id : null;
    if (!externalId) return;
    const { rows } = await this.pool.query<{ xendit_account_id: string; xendit_invoice_id: string | null }>(
      'SELECT xendit_account_id, xendit_invoice_id FROM market_orders WHERE external_id = $1',
      [externalId],
    );
    if (!rows[0]?.xendit_invoice_id) return;
    await this.orderSync.applyInvoice(rows[0].xendit_account_id, rows[0].xendit_invoice_id);
  }

  /** Callback status akun xenPlatform: hanya pemicu; status diambil ulang dari Xendit. */
  async accountCallback(token: unknown, body: Record<string, unknown>): Promise<void> {
    if (!this.xendit.enabled) throw new ApiError(503, 'not_configured', 'Pembayaran di aplikasi belum tersedia');
    if (!this.xendit.verifyCallbackToken(token)) throw new ApiError(401, 'invalid_callback_token', 'Token callback tidak valid');
    const data = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, unknown>;
    const id = typeof data.id === 'string' ? data.id : typeof data.user_id === 'string' ? data.user_id : null;
    if (!id) return;
    const { rows } = await this.pool.query('SELECT 1 FROM market_seller_accounts WHERE xendit_account_id = $1', [id]);
    if (rows[0]) await this.syncAccount(id);
  }

  // ---------- Laporan dan panel super admin ----------

  /** Untuk laporan: listing yang terlihat pelapor. */
  async reportable(userId: string, listingId: string): Promise<{ sellerId: string }> {
    const l = await this.visibleListing(this.pool, userId, listingId);
    return { sellerId: l.seller_id };
  }

  /** Pengguna boleh dilaporkan bila ia penjual listing yang tayang, atau terhubung lewat "Hubungi penjual". */
  async canReportUser(reporterId: string, targetId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM market_contacts WHERE (buyer_id = $1 AND seller_id = $2) OR (buyer_id = $2 AND seller_id = $1)
       UNION ALL
       SELECT 1 FROM market_listings l JOIN users u ON u.id = l.seller_id WHERE l.seller_id = $2 AND ${VISIBLE}
       LIMIT 1`,
      [reporterId, targetId],
    );
    return Boolean(rows[0]);
  }

  async adminOrders(status: OrderRow['status'] | 'open') {
    const { rows } = await this.pool.query<OrderRow & { dispute_reason_enc: Buffer | null }>(
      `SELECT o.*, b.display_name AS buyer_name, s.display_name AS seller_name FROM market_orders o
         LEFT JOIN users b ON b.id = o.buyer_id LEFT JOIN users s ON s.id = o.seller_id
        WHERE ${status === 'open' ? `o.status IN ('paid', 'shipped', 'disputed')` : 'o.status = $1'}
        ORDER BY o.created_at DESC LIMIT 200`,
      status === 'open' ? [] : [status],
    );
    return { items: rows.map((r) => ({ ...this.orderJson(r, null), buyer: r.buyer_name, seller: r.seller_name, buyerId: r.buyer_id, sellerId: r.seller_id })) };
  }

  /** Alasan sengketa (terenkripsi) dibuka per pesanan; tercatat `market.view_dispute`. */
  async adminDispute(adminId: string, orderId: string) {
    const { rows } = await this.pool.query<{ dispute_reason_enc: Buffer | null }>('SELECT dispute_reason_enc FROM market_orders WHERE id = $1', [orderId]);
    if (!rows[0]) throw orderNotFound();
    await audit(this.pool, adminId, 'market.view_dispute', { type: 'market_order', id: orderId });
    return { reason: rows[0].dispute_reason_enc ? this.crypto.decryptString(rows[0].dispute_reason_enc, `market_orders.dispute:${orderId}`) : null };
  }

  /**
   * Putuskan sengketa: `completed` (dana tetap di penjual) atau `refunded`. Refund dieksekusi admin di dasbor Xendit
   * dari akun penjual (PaceTara tidak memegang dana); status di sini mencatat keputusannya.
   */
  async resolve(adminId: string, orderId: string, outcome: 'completed' | 'refunded', note: string) {
    const o = await withTx(this.pool, async (db) => {
      const { rows } = await db.query<OrderRow>('SELECT * FROM market_orders WHERE id = $1 FOR UPDATE', [orderId]);
      const o = rows[0];
      if (!o) throw orderNotFound();
      if (!['disputed', 'paid', 'shipped'].includes(o.status)) throw new ApiError(409, 'invalid_order_state', 'Pesanan ini tidak sedang berjalan/sengketa');
      await db.query(
        `UPDATE market_orders SET status = $2, resolution_note = $3, resolved_by = $4,
                completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END,
                closed_at = CASE WHEN $2 = 'refunded' THEN now() ELSE closed_at END WHERE id = $1`,
        [orderId, outcome, note, adminId],
      );
      await audit(db, adminId, `market.resolve_${outcome}`, { type: 'market_order', id: orderId }, { amount: Number(o.amount), note });
      return o;
    });
    const to = [o.buyer_id, o.seller_id].filter((x): x is string => Boolean(x));
    await this.notifications.notify(to, {
      category: 'market',
      inbox: { type: 'market_order_resolved', data: { orderId } },
      push: { title: 'Sengketa diputuskan', body: `Keputusan untuk pesanan ${o.title} sudah keluar`, data: { type: 'market_order_resolved', orderId } },
    });
  }

  async adminSellers() {
    const { rows } = await this.pool.query<{ user_id: string | null; display_name: string | null; status: string; xendit_account_id: string; suspended_reason: string | null; created_at: Date; orders: string }>(
      `SELECT sa.user_id, u.display_name, sa.status, sa.xendit_account_id, sa.suspended_reason, sa.created_at,
              (SELECT count(*) FROM market_orders o WHERE o.xendit_account_id = sa.xendit_account_id AND o.status IN ('paid', 'shipped', 'completed')) AS orders
         FROM market_seller_accounts sa LEFT JOIN users u ON u.id = sa.user_id ORDER BY sa.created_at DESC LIMIT 200`,
    );
    return {
      items: rows.map((r) => ({
        userId: r.user_id,
        user: r.display_name,
        status: r.status,
        xenditAccountId: r.xendit_account_id,
        suspendedReason: r.suspended_reason,
        orders: Number(r.orders),
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  /** Sanksi penjual: akun pembayaran ditangguhkan (listing split hilang, tidak bisa dibeli). Pulihkan = sinkron ulang dari Xendit. */
  async setSellerSuspended(adminId: string, userId: string, suspended: boolean, reason: string) {
    const { rows } = await this.pool.query<{ xendit_account_id: string }>(
      suspended
        ? `UPDATE market_seller_accounts SET status = 'suspended', suspended_reason = $2 WHERE user_id = $1 RETURNING xendit_account_id`
        : `UPDATE market_seller_accounts SET status = 'invited', suspended_reason = NULL WHERE user_id = $1 AND status = 'suspended' RETURNING xendit_account_id`,
      suspended ? [userId, reason] : [userId],
    );
    if (!rows[0]) throw new ApiError(404, 'seller_not_found', 'Akun penjual tidak ditemukan');
    await audit(this.pool, adminId, suspended ? 'market.suspend_seller' : 'market.restore_seller', { type: 'user', id: userId }, { reason });
    if (!suspended && this.xendit.enabled) await this.syncAccount(rows[0].xendit_account_id).catch(() => undefined);
  }

  /**
   * Hapus akun: ditolak bila masih ada pesanan berjalan sebagai pembeli/penjual. Listing beserta foto dan kontak
   * dihapus; pesanan dan akun penjual tetap untuk akuntansi/sengketa tanpa tautan ke akun (alasan sengketa dihapus).
   */
  async onAccountDeletion(db: Queryable, userId: string): Promise<string[]> {
    const { rows: open } = await db.query(
      `SELECT 1 FROM market_orders WHERE (buyer_id = $1 OR seller_id = $1) AND status IN ('paid', 'shipped', 'disputed') LIMIT 1`,
      [userId],
    );
    if (open[0]) throw new ApiError(409, 'open_orders', 'Masih ada pesanan marketplace yang berjalan. Selesaikan dulu sebelum menghapus akun');
    const { rows: pending } = await db.query<OrderRow>(`SELECT * FROM market_orders WHERE (buyer_id = $1 OR seller_id = $1) AND status = 'pending' FOR UPDATE`, [userId]);
    for (const o of pending) {
      await this.orderSync.restoreStock(db, o);
      await db.query(`UPDATE market_orders SET status = 'cancelled', closed_at = now() WHERE id = $1`, [o.id]);
    }
    await db.query('UPDATE market_orders SET dispute_reason_enc = NULL WHERE buyer_id = $1', [userId]);
    await db.query('UPDATE market_orders SET buyer_id = NULL WHERE buyer_id = $1', [userId]);
    await db.query('UPDATE market_orders SET seller_id = NULL WHERE seller_id = $1', [userId]);
    await db.query('UPDATE market_orders SET resolved_by = NULL WHERE resolved_by = $1', [userId]);
    await db.query('UPDATE market_seller_accounts SET user_id = NULL WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM market_contacts WHERE buyer_id = $1 OR seller_id = $1', [userId]);
    const { rows } = await db.query<{ storage_key: string }>(
      'SELECT p.storage_key FROM market_listing_photos p JOIN market_listings l ON l.id = p.listing_id WHERE l.seller_id = $1',
      [userId],
    );
    await db.query('DELETE FROM market_listings WHERE seller_id = $1', [userId]);
    return rows.map((r) => r.storage_key);
  }

  // ---------- Bantuan ----------

  private async visibleListing(db: Queryable, userId: string, listingId: string): Promise<ListingRow> {
    const { rows } = await db.query<ListingRow>(
      `SELECT ${LISTING_COLS} FROM market_listings l JOIN users u ON u.id = l.seller_id
        WHERE l.id = $1 AND l.removed_at IS NULL AND (l.seller_id = $2 OR (${VISIBLE}))`,
      [listingId, userId],
    );
    if (!rows[0]) throw listingNotFound();
    return rows[0];
  }

  private async ownListingForUpdate(db: Queryable, userId: string, listingId: string) {
    const { rows } = await db.query<{ model: ListingModel; status: string; held_at: Date | null }>(
      'SELECT model, status, held_at FROM market_listings WHERE id = $1 AND seller_id = $2 AND removed_at IS NULL FOR UPDATE',
      [listingId, userId],
    );
    if (!rows[0]) throw listingNotFound();
    return rows[0];
  }

  private async orderForUpdate(db: Queryable, orderId: string, userId: string, role: 'buyer' | 'seller') {
    const { rows } = await db.query<OrderRow>(`SELECT * FROM market_orders WHERE id = $1 AND ${role === 'buyer' ? 'buyer_id' : 'seller_id'} = $2 FOR UPDATE`, [orderId, userId]);
    if (!rows[0]) throw orderNotFound();
    return rows[0];
  }

  private listingJson(r: ListingRow) {
    return {
      id: r.id,
      model: r.model,
      title: r.title,
      category: r.category,
      condition: r.condition,
      price: Number(r.price),
      city: r.city,
      stock: r.stock,
      status: r.status,
      activeUntil: r.active_until?.toISOString() ?? null,
      boosted: Boolean(r.boosted_until && r.boosted_until > new Date()),
      photos: (r.photo_ids ?? []).map((id) => `/v1/market/listings/${r.id}/photos/${id}`),
      seller: { id: r.seller_id, displayName: r.seller_name, verified: r.seller_level >= 2 },
      createdAt: r.created_at.toISOString(),
    };
  }

  private orderJson(r: OrderRow, viewerId: string | null) {
    return {
      id: r.id,
      listingId: r.listing_id,
      title: r.title,
      qty: r.qty,
      unitPrice: Number(r.unit_price),
      amount: Number(r.amount),
      // Komisi hanya untuk penjual (dan panel).
      ...(viewerId === null || viewerId === r.seller_id ? { fee: Number(r.fee_amount), sellerReceives: Number(r.amount) - Number(r.fee_amount) } : {}),
      status: r.status,
      role: viewerId === null ? null : viewerId === r.buyer_id ? 'buyer' : 'seller',
      counterpart: viewerId === r.buyer_id ? { id: r.seller_id, displayName: r.seller_name ?? 'Pengguna dihapus' } : { id: r.buyer_id, displayName: r.buyer_name ?? 'Pengguna dihapus' },
      invoiceUrl: r.status === 'pending' && viewerId === r.buyer_id ? r.invoice_url : null,
      trackingNote: r.tracking_note,
      disputeOpenedAt: r.dispute_opened_at?.toISOString() ?? null,
      resolutionNote: r.resolution_note,
      paidAt: r.paid_at?.toISOString() ?? null,
      shippedAt: r.shipped_at?.toISOString() ?? null,
      completedAt: r.completed_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
    };
  }
}

function listingNotFound() {
  return new ApiError(404, 'listing_not_found', 'Listing tidak ditemukan');
}
function orderNotFound() {
  return new ApiError(404, 'order_not_found', 'Pesanan tidak ditemukan');
}
