import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type pg from 'pg';
import { type Queryable, withTx } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { ENV, type Env } from '../config/env.js';
import { PG_POOL } from '../core.module.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { mapMidtransStatus, MidtransApi, type MidtransClient } from './midtrans.js';

export type PaymentPurpose = 'listing_fee' | 'listing_boost' | 'banner';
const PURPOSE_CODE: Record<PaymentPurpose, string> = { listing_fee: 'LF', listing_boost: 'LB', banner: 'BN' };

interface PaymentRow {
  id: string;
  order_id: string;
  user_id: string | null;
  purpose: PaymentPurpose;
  ref_id: string;
  amount: string;
  status: 'pending' | 'paid' | 'failed' | 'expired' | 'refunded';
  redirect_url: string | null;
  paid_at: Date | null;
  applied_at: Date | null;
  created_at: Date;
}

/**
 * Efek pembayaran lunas, dijalankan sekali per pembayaran (applied_at) di transaksi yang sama dengan perubahan status.
 * Fungsi lepas (bukan method service marketplace/banner) agar worker rekonsiliasi bisa menerapkannya tanpa memuat
 * modul lain. Mengembalikan false jika sasaran sudah tidak ada/tidak memenuhi syarat (pembayaran tetap tercatat lunas;
 * super admin menindaklanjuti refund dari panel).
 */
export async function applyPaymentEffect(db: Queryable, env: Env, p: Pick<PaymentRow, 'purpose' | 'ref_id'>): Promise<boolean> {
  switch (p.purpose) {
    case 'listing_fee': {
      const { rowCount } = await db.query(
        `UPDATE market_listings SET status = 'active',
                active_until = GREATEST(now(), COALESCE(active_until, now())) + make_interval(days => $2)
          WHERE id = $1 AND model = 'listing_fee' AND removed_at IS NULL AND status IN ('pending_payment', 'expired', 'active')`,
        [p.ref_id, env.MARKET_LISTING_DAYS],
      );
      return Boolean(rowCount);
    }
    case 'listing_boost': {
      const { rowCount } = await db.query(
        `UPDATE market_listings SET boosted_until = GREATEST(now(), COALESCE(boosted_until, now())) + make_interval(days => $2)
          WHERE id = $1 AND removed_at IS NULL AND status = 'active'`,
        [p.ref_id, env.MARKET_BOOST_DAYS],
      );
      return Boolean(rowCount);
    }
    case 'banner': {
      // Modul 3.3: banner yang sudah dibayar masuk antrean persetujuan super admin.
      const { rowCount } = await db.query(
        `UPDATE sponsor_banners SET status = 'pending_review', paid_at = now() WHERE id = $1 AND status = 'pending_payment'`,
        [p.ref_id],
      );
      return Boolean(rowCount);
    }
  }
}

/**
 * Pembayaran Midtrans milik PaceTara (biaya listing, boost, banner sponsor). Dibuat dari dasbor web (REVIEW-PRD C1:
 * layanan digital tidak dibayar di dalam aplikasi Android). Status hanya berubah setelah dipastikan ke API status
 * Midtrans (notifikasi dengan signature sah sebagai pemicu, rekonsiliasi worker sebagai cadangan).
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger('Payments');

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(ENV) private readonly env: Env,
    @Inject(MidtransApi) private readonly midtrans: MidtransClient,
    private readonly notifications: NotificationsService,
  ) {}

  get enabled(): boolean {
    return this.midtrans.enabled;
  }

  /**
   * Buat (atau pakai ulang) pembayaran menunggu untuk satu sasaran. Mengembalikan URL halaman bayar Snap.
   * Pemanggil sudah memeriksa hak pengguna atas sasaran dan nominalnya.
   */
  async create(userId: string, purpose: PaymentPurpose, refId: string, amount: number, itemName: string, finishPath: string) {
    if (!this.midtrans.enabled) throw new ApiError(503, 'not_configured', 'Pembayaran belum tersedia');
    const { rows: existing } = await this.pool.query<PaymentRow>(
      `SELECT * FROM payments WHERE user_id = $1 AND purpose = $2 AND ref_id = $3 AND status = 'pending' AND amount = $4
          AND redirect_url IS NOT NULL AND created_at > now() - interval '23 hours'
        ORDER BY created_at DESC LIMIT 1`,
      [userId, purpose, refId, amount],
    );
    if (existing[0]) return { paymentId: existing[0].id, redirectUrl: existing[0].redirect_url! };
    const orderId = `PT-${PURPOSE_CODE[purpose]}-${randomBytes(9).toString('base64url')}`;
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO payments (order_id, user_id, purpose, ref_id, amount) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [orderId, userId, purpose, refId, amount],
    );
    const id = rows[0]!.id;
    try {
      const snap = await this.midtrans.createSnap({ orderId, amount, itemName, finishUrl: `${this.env.DASHBOARD_URL}${finishPath}` });
      await this.pool.query('UPDATE payments SET redirect_url = $2 WHERE id = $1', [id, snap.redirectUrl]);
      return { paymentId: id, redirectUrl: snap.redirectUrl };
    } catch (err) {
      await this.pool.query(`UPDATE payments SET status = 'failed', provider_status = 'create_failed' WHERE id = $1`, [id]);
      this.logger.warn(`Gagal membuat transaksi Midtrans: ${err instanceof Error ? err.message : 'unknown'}`);
      throw new ApiError(502, 'payment_unavailable', 'Gagal membuat pembayaran. Coba lagi');
    }
  }

  /** Notifikasi HTTP Midtrans. Signature diperiksa dulu; isi tidak dipercaya, status diambil ulang dari API. */
  async handleNotification(body: Record<string, unknown>): Promise<void> {
    if (!this.midtrans.enabled) throw new ApiError(503, 'not_configured', 'Pembayaran belum tersedia');
    if (!this.midtrans.verifyNotification(body)) throw new ApiError(401, 'invalid_signature', 'Signature tidak valid');
    const orderId = body.order_id as string;
    const { rows } = await this.pool.query<{ id: string }>('SELECT id FROM payments WHERE order_id = $1', [orderId]);
    // Order milik sistem lain di akun Midtrans yang sama: diakui (200) tanpa diproses.
    if (!rows[0]) return;
    await this.sync(orderId);
  }

  /** Samakan satu pembayaran dengan status di Midtrans dan terapkan efeknya sekali. */
  async sync(orderId: string): Promise<PaymentRow['status'] | null> {
    const s = await this.midtrans.status(orderId);
    if (s.order_id !== orderId) return null;
    const next = mapMidtransStatus(s);
    const applied = await withTx(this.pool, async (db) => {
      const { rows } = await db.query<PaymentRow>('SELECT * FROM payments WHERE order_id = $1 FOR UPDATE', [orderId]);
      const p = rows[0];
      if (!p) return null;
      // Nominal harus sama persis dengan yang kita buat; selain itu jangan terapkan apa pun.
      if (s.gross_amount !== undefined && Math.round(Number(s.gross_amount)) !== Number(p.amount)) {
        this.logger.warn(`Nominal pembayaran ${p.id} tidak cocok; diabaikan`);
        return null;
      }
      // Lunas tidak turun ke menunggu/gagal karena notifikasi yang datang terlambat; hanya refund yang mengubahnya.
      const status = p.status === 'paid' && next !== 'refunded' ? 'paid' : p.status === 'refunded' ? 'refunded' : next;
      await db.query(
        `UPDATE payments SET status = $2, provider_status = $3, payment_type = $4,
                paid_at = CASE WHEN $2 = 'paid' THEN COALESCE(paid_at, now()) ELSE paid_at END WHERE id = $1`,
        [p.id, status, s.transaction_status ?? null, s.payment_type ?? null],
      );
      if (status === 'paid' && !p.applied_at) {
        const ok = await applyPaymentEffect(db, this.env, p);
        // applied_at hanya diisi jika efek berhasil; yang gagal tampil "belum diterapkan" di panel untuk ditindaklanjuti.
        if (ok) await db.query('UPDATE payments SET applied_at = now() WHERE id = $1', [p.id]);
        else this.logger.warn(`Pembayaran ${p.id} lunas tetapi sasarannya tidak memenuhi syarat; perlu tindak lanjut admin`);
        return { p, ok };
      }
      return null;
    });
    if (applied?.ok && applied.p.user_id && applied.p.purpose !== 'banner') {
      await this.notifications.notify([applied.p.user_id], {
        category: 'market',
        inbox: { type: 'market_listing_paid', data: { listingId: applied.p.ref_id } },
        push: {
          title: applied.p.purpose === 'listing_fee' ? 'Listing tayang' : 'Listing dinaikkan',
          body: applied.p.purpose === 'listing_fee' ? 'Pembayaran diterima, listingmu sudah tampil di marketplace' : 'Pembayaran diterima, listingmu tampil di urutan atas',
          data: { type: 'market_listing_paid', listingId: applied.p.ref_id },
        },
      });
    }
    return next;
  }

  /**
   * Rekonsiliasi worker: pembayaran menunggu 10 menit–2 hari disinkronkan (maks. 50 per putaran, cadangan bila
   * notifikasi hilang); yang lebih dari 2 hari ditandai kedaluwarsa.
   */
  async reconcile(): Promise<{ synced: number; expired: number }> {
    if (!this.midtrans.enabled) return { synced: 0, expired: 0 };
    const { rowCount } = await this.pool.query(
      `UPDATE payments SET status = 'expired', provider_status = 'stale' WHERE status = 'pending' AND created_at < now() - interval '2 days'`,
    );
    const { rows } = await this.pool.query<{ order_id: string }>(
      `SELECT order_id FROM payments WHERE status = 'pending' AND redirect_url IS NOT NULL
          AND created_at < now() - interval '10 minutes' ORDER BY updated_at ASC LIMIT 50`,
    );
    let synced = 0;
    for (const r of rows) {
      try {
        await this.sync(r.order_id);
        synced++;
      } catch (err) {
        this.logger.warn(`Sinkron pembayaran gagal: ${err instanceof Error ? err.message : 'unknown'}`);
      }
      await this.pool.query('UPDATE payments SET updated_at = now() WHERE order_id = $1', [r.order_id]);
    }
    return { synced, expired: rowCount ?? 0 };
  }

  async mine(userId: string) {
    const { rows } = await this.pool.query<PaymentRow>(
      `SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [userId],
    );
    return { items: rows.map(paymentJson) };
  }

  async adminList(status: PaymentRow['status'] | 'all') {
    const { rows } = await this.pool.query<PaymentRow & { display_name: string | null }>(
      `SELECT p.*, u.display_name FROM payments p LEFT JOIN users u ON u.id = p.user_id
        WHERE ($1 = 'all' OR p.status = $1) ORDER BY p.created_at DESC LIMIT 200`,
      [status],
    );
    return { items: rows.map((r) => ({ ...paymentJson(r), user: r.display_name, userId: r.user_id })) };
  }

  /** Hapus akun: catatan pembayaran disimpan untuk akuntansi tanpa tautan ke akun. */
  async onAccountDeletion(db: Queryable, userId: string): Promise<void> {
    await db.query('UPDATE payments SET user_id = NULL WHERE user_id = $1', [userId]);
  }
}

function paymentJson(r: PaymentRow) {
  return {
    id: r.id,
    orderId: r.order_id,
    purpose: r.purpose,
    refId: r.ref_id,
    amount: Number(r.amount),
    status: r.status,
    redirectUrl: r.status === 'pending' ? r.redirect_url : null,
    paidAt: r.paid_at?.toISOString() ?? null,
    applied: Boolean(r.applied_at),
    createdAt: r.created_at.toISOString(),
  };
}
