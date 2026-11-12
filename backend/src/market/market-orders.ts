import { Inject, Injectable, Logger } from '@nestjs/common';
import type pg from 'pg';
import { type Queryable, withTx } from '../common/db.js';
import { PG_POOL } from '../core.module.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { XenditApi, type XenditClient } from './xendit.js';

/** Pesanan menunggu bayar kedaluwarsa (invoice Xendit berlaku 1 jam + jeda). */
export const ORDER_PENDING_HOURS = 2;
/** Pesanan dikirim otomatis selesai jika pembeli tidak mengonfirmasi/membuka sengketa. */
export const AUTO_COMPLETE_DAYS = 7;

export interface OrderRow {
  id: string;
  external_id: string;
  listing_id: string | null;
  buyer_id: string | null;
  seller_id: string | null;
  xendit_account_id: string;
  title: string;
  qty: number;
  unit_price: string;
  amount: string;
  fee_amount: string;
  status: 'pending' | 'paid' | 'shipped' | 'completed' | 'cancelled' | 'expired' | 'disputed' | 'refunded';
  xendit_invoice_id: string | null;
  invoice_url: string | null;
  tracking_note: string | null;
  dispute_opened_at: Date | null;
  resolution_note: string | null;
  paid_at: Date | null;
  shipped_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  buyer_name?: string | null;
  seller_name?: string | null;
}

/**
 * Sinkron status pesanan split payment dengan invoice Xendit, dan pemeliharaan berkala. Dipisah dari MarketService
 * agar worker bisa menjalankannya tanpa memuat modul chat/komunitas.
 */
@Injectable()
export class MarketOrderSync {
  private readonly logger = new Logger('MarketOrders');

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(XenditApi) private readonly xendit: XenditClient,
    private readonly notifications: NotificationsService,
  ) {}

  /** Ambil invoice dari Xendit (akun penjual tercatat) dan terapkan: lunas → `paid`, kedaluwarsa → stok kembali. */
  async applyInvoice(accountId: string, invoiceId: string): Promise<void> {
    const inv = await this.xendit.getInvoice(accountId, invoiceId);
    const status = (inv.status ?? '').toUpperCase();
    const paid = await withTx(this.pool, async (db) => {
      const { rows } = await db.query<OrderRow>('SELECT * FROM market_orders WHERE xendit_invoice_id = $1 AND xendit_account_id = $2 FOR UPDATE', [invoiceId, accountId]);
      const o = rows[0];
      if (!o) return null;
      if ((status === 'PAID' || status === 'SETTLED') && ['pending', 'cancelled', 'expired'].includes(o.status)) {
        if (inv.amount !== undefined && Math.round(inv.amount) !== Number(o.amount)) {
          this.logger.warn(`Nominal invoice pesanan ${o.id} tidak cocok; diabaikan`);
          return null;
        }
        // Dibayar setelah dibatalkan/kedaluwarsa (stok sudah dikembalikan): stok dipesan lagi semampunya; sisanya
        // diselesaikan penjual/admin (dana sudah di akun Xendit penjual).
        if (o.status !== 'pending' && o.listing_id) {
          await db.query('UPDATE market_listings SET stock = GREATEST(0, stock - $2) WHERE id = $1', [o.listing_id, o.qty]);
        }
        await db.query(`UPDATE market_orders SET status = 'paid', paid_at = now(), closed_at = NULL WHERE id = $1`, [o.id]);
        return o;
      }
      if (status === 'EXPIRED' && o.status === 'pending') {
        await this.restoreStock(db, o);
        await db.query(`UPDATE market_orders SET status = 'expired', closed_at = now() WHERE id = $1`, [o.id]);
      }
      return null;
    });
    if (paid?.seller_id) {
      await this.notifications.notify([paid.seller_id], {
        category: 'market',
        actorId: paid.buyer_id ?? undefined,
        inbox: { type: 'market_order_paid', data: { orderId: paid.id } },
        push: { title: 'Pesanan baru dibayar', body: `${paid.title} x${paid.qty} sudah dibayar. Kirim barangnya`, data: { type: 'market_order_paid', orderId: paid.id } },
      });
    }
  }

  async closeOrder(orderId: string, status: 'cancelled' | 'expired'): Promise<void> {
    await withTx(this.pool, async (db) => {
      const { rows } = await db.query<OrderRow>('SELECT * FROM market_orders WHERE id = $1 FOR UPDATE', [orderId]);
      const o = rows[0];
      if (!o || o.status !== 'pending') return;
      await this.restoreStock(db, o);
      await db.query('UPDATE market_orders SET status = $2, closed_at = now() WHERE id = $1', [orderId, status]);
    });
  }

  async restoreStock(db: Queryable, o: Pick<OrderRow, 'listing_id' | 'qty'>): Promise<void> {
    if (o.listing_id) await db.query(`UPDATE market_listings SET stock = LEAST(999, stock + $2) WHERE id = $1 AND model = 'split'`, [o.listing_id, o.qty]);
  }

  async notifyCompleted(o: Pick<OrderRow, 'id' | 'seller_id' | 'title'>): Promise<void> {
    if (!o.seller_id) return;
    await this.notifications.notify([o.seller_id], {
      category: 'market',
      inbox: { type: 'market_order_completed', data: { orderId: o.id } },
      push: { title: 'Pesanan selesai', body: `${o.title} sudah diterima pembeli`, data: { type: 'market_order_completed', orderId: o.id } },
    });
  }

  /**
   * Job worker (tiap 15 menit): pesanan menunggu > 2 jam kedaluwarsa (invoice dicek dulu ke Xendit, stok kembali),
   * pesanan dikirim > 7 hari selesai otomatis, listing lewat masa tayang menjadi `expired`.
   */
  async maintenance() {
    const { rows: stale } = await this.pool.query<{ id: string; xendit_account_id: string; xendit_invoice_id: string | null }>(
      `SELECT id, xendit_account_id, xendit_invoice_id FROM market_orders WHERE status = 'pending' AND created_at < now() - make_interval(hours => $1) LIMIT 100`,
      [ORDER_PENDING_HOURS],
    );
    let expired = 0;
    for (const o of stale) {
      try {
        if (o.xendit_invoice_id && this.xendit.enabled) await this.applyInvoice(o.xendit_account_id, o.xendit_invoice_id);
      } catch {
        // Xendit tidak terjangkau: tetap kedaluwarsakan; pembayaran terlambat masih diterapkan lewat callback.
      }
      await this.closeOrder(o.id, 'expired');
      expired++;
    }
    const { rows: done } = await this.pool.query<OrderRow>(
      `UPDATE market_orders SET status = 'completed', completed_at = now()
        WHERE status = 'shipped' AND shipped_at < now() - make_interval(days => $1) RETURNING *`,
      [AUTO_COMPLETE_DAYS],
    );
    for (const o of done) await this.notifyCompleted(o);
    const { rowCount: listings } = await this.pool.query(`UPDATE market_listings SET status = 'expired' WHERE status = 'active' AND active_until < now()`);
    return { expiredOrders: expired, autoCompleted: done.length, expiredListings: listings ?? 0 };
  }
}
