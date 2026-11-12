import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { type CommunityAccess, communityAccess, requirePro, requireStaff } from '../communities/access.js';
import { type Queryable, withTx } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { PG_POOL } from '../core.module.js';
import { hasProFeature } from '../plans/plans.js';

export const CASH_CATEGORIES = ['iuran', 'sponsor', 'donasi', 'jersey', 'event', 'perlengkapan', 'konsumsi', 'operasional', 'lainnya'] as const;
export type CashCategory = (typeof CASH_CATEGORIES)[number];
export const RECORD_ONLY_NOTICE = 'Pencatatan saja. Pembayaran dilakukan di luar aplikasi; PaceTara tidak menerima atau menyalurkan dana.';
const CASH_PAGE = 50;
/** Batas wajar (bukan batas paket). */
export const MAX_OPEN_JERSEY_ITEMS = 20;

export interface CashInput {
  kind: 'in' | 'out';
  amount: number;
  category: CashCategory;
  occurredOn: string;
  description?: string;
}

export interface JerseyItemInput {
  name: string;
  description?: string;
  price: number;
  sizes: string[];
  orderDeadline: Date;
}

/**
 * Kas komunitas dan pre-order jersey (Komunitas Pro), pencatatan saja: tidak ada aliran dana lewat aplikasi.
 * Kas: semua anggota aktif bisa membaca (transparansi), hanya admin/pemilik yang menulis. Jersey: admin membuat item
 * dan menandai lunas; anggota mencatat pesanannya sendiri; anggota lain hanya melihat jumlah per ukuran.
 * Pro berakhir: catatan tetap bisa dibaca, semua penulisan dikunci (403 limit_reached).
 */
@Injectable()
export class TreasuryService {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  // ---------- Kas ----------

  async cash(userId: string, communityId: string, page: number) {
    const access = await communityAccess(this.pool, communityId, userId);
    const { rows: sum } = await this.pool.query<{ total_in: string; total_out: string; n: string }>(
      `SELECT COALESCE(sum(amount) FILTER (WHERE kind = 'in'), 0) AS total_in, COALESCE(sum(amount) FILTER (WHERE kind = 'out'), 0) AS total_out,
              count(*) AS n
         FROM community_cash_entries WHERE community_id = $1`,
      [communityId],
    );
    const { rows } = await this.pool.query<{
      id: string;
      kind: 'in' | 'out';
      amount: string;
      category: CashCategory;
      occurred_on: string;
      description: string;
      created_by_name: string | null;
      created_at: Date;
    }>(
      `SELECT e.id, e.kind, e.amount, e.category, to_char(e.occurred_on, 'YYYY-MM-DD') AS occurred_on, e.description,
              u.display_name AS created_by_name, e.created_at
         FROM community_cash_entries e LEFT JOIN users u ON u.id = e.created_by
        WHERE e.community_id = $1 ORDER BY e.occurred_on DESC, e.created_at DESC, e.id DESC LIMIT $2 OFFSET $3`,
      [communityId, CASH_PAGE + 1, (page - 1) * CASH_PAGE],
    );
    const totalIn = Number(sum[0]!.total_in);
    const totalOut = Number(sum[0]!.total_out);
    return {
      notice: RECORD_ONLY_NOTICE,
      proActive: hasProFeature(access.plan, 'community_cash'),
      canWrite: access.isStaff && hasProFeature(access.plan, 'community_cash'),
      balance: totalIn - totalOut,
      totalIn,
      totalOut,
      count: Number(sum[0]!.n),
      items: rows.slice(0, CASH_PAGE).map((r) => ({
        id: r.id,
        kind: r.kind,
        amount: Number(r.amount),
        category: r.category,
        occurredOn: r.occurred_on,
        description: r.description,
        recordedBy: r.created_by_name,
        createdAt: r.created_at.toISOString(),
      })),
      hasMore: rows.length > CASH_PAGE,
    };
  }

  async addCash(userId: string, communityId: string, input: CashInput) {
    await withTx(this.pool, async (db) => {
      await this.writer(db, communityId, userId, 'community_cash');
      await db.query(
        `INSERT INTO community_cash_entries (community_id, kind, amount, category, occurred_on, description, created_by)
         VALUES ($1, $2, $3, $4, $5::date, $6, $7)`,
        [communityId, input.kind, input.amount, input.category, input.occurredOn, input.description ?? '', userId],
      );
    });
    return this.cash(userId, communityId, 1);
  }

  async updateCash(userId: string, communityId: string, entryId: string, patch: Partial<CashInput>) {
    await withTx(this.pool, async (db) => {
      await this.writer(db, communityId, userId, 'community_cash');
      const sets: string[] = [];
      const values: unknown[] = [entryId, communityId];
      const add = (col: string, v: unknown, cast = '') => {
        values.push(v);
        sets.push(`${col} = $${values.length}${cast}`);
      };
      if (patch.kind !== undefined) add('kind', patch.kind);
      if (patch.amount !== undefined) add('amount', patch.amount);
      if (patch.category !== undefined) add('category', patch.category);
      if (patch.occurredOn !== undefined) add('occurred_on', patch.occurredOn, '::date');
      if (patch.description !== undefined) add('description', patch.description);
      const { rowCount } = sets.length
        ? await db.query(`UPDATE community_cash_entries SET ${sets.join(', ')} WHERE id = $1 AND community_id = $2`, values)
        : await db.query('SELECT 1 FROM community_cash_entries WHERE id = $1 AND community_id = $2', values);
      if (!rowCount) throw new ApiError(404, 'entry_not_found', 'Catatan kas tidak ditemukan');
    });
    return this.cash(userId, communityId, 1);
  }

  async deleteCash(userId: string, communityId: string, entryId: string): Promise<void> {
    await withTx(this.pool, async (db) => {
      await this.writer(db, communityId, userId, 'community_cash');
      const { rowCount } = await db.query('DELETE FROM community_cash_entries WHERE id = $1 AND community_id = $2', [entryId, communityId]);
      if (!rowCount) throw new ApiError(404, 'entry_not_found', 'Catatan kas tidak ditemukan');
    });
  }

  // ---------- Jersey ----------

  async jerseyItems(userId: string, communityId: string) {
    const access = await communityAccess(this.pool, communityId, userId);
    const { rows } = await this.pool.query<{
      id: string;
      name: string;
      description: string;
      price: string;
      sizes: string[];
      order_deadline: Date;
      closed_at: Date | null;
      created_at: Date;
    }>(
      `SELECT id, name, description, price, sizes, order_deadline, closed_at, created_at FROM jersey_items
        WHERE community_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [communityId],
    );
    const ids = rows.map((r) => r.id);
    const { rows: counts } = ids.length
      ? await this.pool.query<{ item_id: string; size: string; qty: string; paid_qty: string }>(
          `SELECT item_id, size, sum(quantity) AS qty, COALESCE(sum(quantity) FILTER (WHERE paid), 0) AS paid_qty
             FROM jersey_orders WHERE item_id = ANY($1::uuid[]) GROUP BY item_id, size`,
          [ids],
        )
      : { rows: [] };
    const { rows: mine } = ids.length
      ? await this.pool.query<{ id: string; item_id: string; size: string; quantity: number; note: string; paid: boolean }>(
          `SELECT id, item_id, size, quantity, note, paid FROM jersey_orders WHERE item_id = ANY($1::uuid[]) AND user_id = $2 ORDER BY created_at`,
          [ids, userId],
        )
      : { rows: [] };
    const pro = hasProFeature(access.plan, 'jersey');
    return {
      notice: RECORD_ONLY_NOTICE,
      proActive: pro,
      canManage: access.isStaff && pro,
      items: rows.map((r) => {
        const c = counts.filter((x) => x.item_id === r.id);
        const open = !r.closed_at && r.order_deadline.getTime() > Date.now();
        return {
          id: r.id,
          name: r.name,
          description: r.description,
          price: Number(r.price),
          sizes: r.sizes,
          orderDeadline: r.order_deadline.toISOString(),
          closed: Boolean(r.closed_at),
          open: open && pro,
          // Anggota lain hanya melihat jumlah per ukuran (tanpa nama).
          totals: r.sizes.map((s) => ({ size: s, quantity: Number(c.find((x) => x.size === s)?.qty ?? 0) })),
          totalQuantity: c.reduce((a, x) => a + Number(x.qty), 0),
          ...(access.isStaff ? { paidQuantity: c.reduce((a, x) => a + Number(x.paid_qty), 0) } : {}),
          myOrders: mine.filter((m) => m.item_id === r.id).map((m) => ({ id: m.id, size: m.size, quantity: m.quantity, note: m.note, paid: m.paid })),
        };
      }),
    };
  }

  async createItem(userId: string, communityId: string, input: JerseyItemInput) {
    if (input.orderDeadline.getTime() <= Date.now()) throw new ApiError(400, 'deadline_in_past', 'Batas waktu pesan harus di masa depan');
    await withTx(this.pool, async (db) => {
      await this.writer(db, communityId, userId, 'jersey');
      // FOR SHARE di communityAccess tidak saling menghalangi: kunci per komunitas agar hitungan batas tidak bisa didahului.
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`jersey-items:${communityId}`]);
      const { rows } = await db.query<{ n: string }>(
        'SELECT count(*) AS n FROM jersey_items WHERE community_id = $1 AND closed_at IS NULL AND order_deadline > now()',
        [communityId],
      );
      if (Number(rows[0]!.n) >= MAX_OPEN_JERSEY_ITEMS) throw new ApiError(409, 'too_many_items', `Maksimal ${MAX_OPEN_JERSEY_ITEMS} item pre-order yang masih dibuka`);
      await db.query(
        `INSERT INTO jersey_items (community_id, name, description, price, sizes, order_deadline, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [communityId, input.name, input.description ?? '', input.price, input.sizes, input.orderDeadline, userId],
      );
    });
    return this.jerseyItems(userId, communityId);
  }

  async updateItem(userId: string, itemId: string, patch: Partial<JerseyItemInput> & { closed?: boolean }) {
    const communityId = await withTx(this.pool, async (db) => {
      const item = await this.item(db, itemId, userId);
      await this.writer(db, item.community_id, userId, 'jersey');
      const sets: string[] = [];
      const values: unknown[] = [itemId];
      const add = (col: string, v: unknown) => {
        values.push(v);
        sets.push(`${col} = $${values.length}`);
      };
      if (patch.name !== undefined) add('name', patch.name);
      if (patch.description !== undefined) add('description', patch.description);
      if (patch.price !== undefined) add('price', patch.price);
      if (patch.sizes !== undefined) {
        // Ukuran yang sudah dipesan tidak boleh dihapus.
        const { rows } = await db.query<{ size: string }>('SELECT DISTINCT size FROM jersey_orders WHERE item_id = $1', [itemId]);
        const missing = rows.map((r) => r.size).filter((s) => !patch.sizes!.includes(s));
        if (missing.length) throw new ApiError(409, 'size_in_use', `Ukuran ${missing.join(', ')} sudah dipesan dan tidak bisa dihapus`);
        add('sizes', patch.sizes);
      }
      if (patch.orderDeadline !== undefined) add('order_deadline', patch.orderDeadline);
      if (patch.closed !== undefined) sets.push(patch.closed ? 'closed_at = COALESCE(closed_at, now())' : 'closed_at = NULL');
      if (sets.length) await db.query(`UPDATE jersey_items SET ${sets.join(', ')} WHERE id = $1`, values);
      return item.community_id;
    });
    return this.jerseyItems(userId, communityId);
  }

  async deleteItem(userId: string, itemId: string): Promise<void> {
    await withTx(this.pool, async (db) => {
      const item = await this.item(db, itemId, userId);
      await this.writer(db, item.community_id, userId, 'jersey');
      await db.query('DELETE FROM jersey_items WHERE id = $1', [itemId]);
    });
  }

  /** Semua pesanan satu item (admin). Tetap bisa dibaca setelah Pro berakhir. */
  async orders(userId: string, itemId: string) {
    const item = await this.item(this.pool, itemId, userId);
    const access = requireStaff(await communityAccess(this.pool, item.community_id, userId));
    const { rows } = await this.pool.query<{
      id: string;
      user_id: string | null;
      display_name: string | null;
      size: string;
      quantity: number;
      note: string;
      paid: boolean;
      paid_at: Date | null;
      created_at: Date;
    }>(
      `SELECT o.id, o.user_id, u.display_name, o.size, o.quantity, o.note, o.paid, o.paid_at, o.created_at
         FROM jersey_orders o LEFT JOIN users u ON u.id = o.user_id
        WHERE o.item_id = $1 ORDER BY o.created_at`,
      [itemId],
    );
    const price = Number(item.price);
    return {
      notice: RECORD_ONLY_NOTICE,
      canManage: hasProFeature(access.plan, 'jersey'),
      item: { id: item.id, name: item.name, price },
      totalQuantity: rows.reduce((a, r) => a + r.quantity, 0),
      paidQuantity: rows.filter((r) => r.paid).reduce((a, r) => a + r.quantity, 0),
      paidAmount: rows.filter((r) => r.paid).reduce((a, r) => a + r.quantity * price, 0),
      orders: rows.map((r) => ({
        id: r.id,
        user: r.user_id ? { id: r.user_id, displayName: r.display_name } : null,
        size: r.size,
        quantity: r.quantity,
        note: r.note,
        paid: r.paid,
        paidAt: r.paid_at?.toISOString() ?? null,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  /** Anggota mencatat pesanannya (satu baris per ukuran; mengirim ulang ukuran yang sama mengganti jumlahnya). */
  async placeOrder(userId: string, itemId: string, input: { size: string; quantity: number; note?: string }) {
    const communityId = await withTx(this.pool, async (db) => {
      const item = await this.item(db, itemId, userId, true);
      requirePro(await communityAccess(db, item.community_id, userId, true), 'jersey');
      if (item.closed_at || item.order_deadline.getTime() <= Date.now()) throw new ApiError(409, 'orders_closed', 'Pre-order sudah ditutup');
      if (!item.sizes.includes(input.size)) throw new ApiError(400, 'invalid_size', 'Ukuran tidak tersedia');
      const { rows } = await db.query<{ paid: boolean }>('SELECT paid FROM jersey_orders WHERE item_id = $1 AND user_id = $2 AND size = $3 FOR UPDATE', [
        itemId,
        userId,
        input.size,
      ]);
      if (rows[0]?.paid) throw new ApiError(409, 'order_paid', 'Pesanan ini sudah ditandai lunas. Hubungi admin untuk mengubahnya');
      await db.query(
        `INSERT INTO jersey_orders (item_id, user_id, size, quantity, note) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (item_id, user_id, size) WHERE user_id IS NOT NULL DO UPDATE SET quantity = EXCLUDED.quantity, note = EXCLUDED.note`,
        [itemId, userId, input.size, input.quantity, input.note ?? ''],
      );
      return item.community_id;
    });
    return this.jerseyItems(userId, communityId);
  }

  /** Batalkan pesanan: pemesan (belum lunas, sebelum ditutup) atau admin (Pro). */
  async deleteOrder(userId: string, orderId: string): Promise<void> {
    await withTx(this.pool, async (db) => {
      const order = await this.order(db, orderId, userId);
      const access = await communityAccess(db, order.community_id, userId, true);
      if (order.user_id === userId && !access.isStaff) {
        requirePro(access, 'jersey');
        if (order.paid) throw new ApiError(409, 'order_paid', 'Pesanan yang sudah lunas hanya bisa dibatalkan admin');
        if (order.closed_at || order.order_deadline.getTime() <= Date.now()) throw new ApiError(409, 'orders_closed', 'Pre-order sudah ditutup');
      } else {
        requirePro(requireStaff(access), 'jersey');
      }
      await db.query('DELETE FROM jersey_orders WHERE id = $1', [orderId]);
    });
  }

  async markPaid(userId: string, orderId: string, paid: boolean) {
    const itemId = await withTx(this.pool, async (db) => {
      const order = await this.order(db, orderId, userId);
      requirePro(requireStaff(await communityAccess(db, order.community_id, userId, true)), 'jersey');
      await db.query(
        `UPDATE jersey_orders SET paid = $2, paid_at = CASE WHEN $2 THEN now() END, paid_marked_by = CASE WHEN $2 THEN $3::uuid END WHERE id = $1`,
        [orderId, paid, userId],
      );
      return order.item_id;
    });
    return this.orders(userId, itemId);
  }

  // ---------- Hapus akun ----------

  /**
   * Catatan kas yang ia tulis tetap (kas milik komunitas) tanpa nama pencatat. Pesanan jersey belum lunas dihapus;
   * yang sudah lunas dianonimkan (catatan admin bahwa ada pesanan yang sudah dibayar tetap utuh).
   */
  async onAccountDeletion(db: Queryable, userId: string): Promise<void> {
    await db.query('UPDATE community_cash_entries SET created_by = NULL WHERE created_by = $1', [userId]);
    await db.query('UPDATE jersey_items SET created_by = NULL WHERE created_by = $1', [userId]);
    await db.query('DELETE FROM jersey_orders WHERE user_id = $1 AND NOT paid', [userId]);
    await db.query(`UPDATE jersey_orders SET user_id = NULL, note = '' WHERE user_id = $1`, [userId]);
    await db.query('UPDATE jersey_orders SET paid_marked_by = NULL WHERE paid_marked_by = $1', [userId]);
  }

  // ---------- Bantuan ----------

  private async writer(db: Queryable, communityId: string, userId: string, feature: 'community_cash' | 'jersey'): Promise<CommunityAccess> {
    return requirePro(requireStaff(await communityAccess(db, communityId, userId, true)), feature);
  }

  /** Item jersey milik komunitas tempat pengguna anggota aktif; selain itu 404. */
  private async item(db: Queryable, itemId: string, userId: string, lock = false) {
    const { rows } = await db.query<{
      id: string;
      community_id: string;
      name: string;
      price: string;
      sizes: string[];
      order_deadline: Date;
      closed_at: Date | null;
    }>(`SELECT id, community_id, name, price, sizes, order_deadline, closed_at FROM jersey_items WHERE id = $1 ${lock ? 'FOR SHARE' : ''}`, [itemId]);
    const item = rows[0];
    if (!item) throw itemNotFound();
    try {
      await communityAccess(db, item.community_id, userId);
    } catch {
      throw itemNotFound();
    }
    return item;
  }

  private async order(db: Queryable, orderId: string, userId: string) {
    const { rows } = await db.query<{
      id: string;
      item_id: string;
      user_id: string | null;
      paid: boolean;
      community_id: string;
      order_deadline: Date;
      closed_at: Date | null;
    }>(
      `SELECT o.id, o.item_id, o.user_id, o.paid, i.community_id, i.order_deadline, i.closed_at
         FROM jersey_orders o JOIN jersey_items i ON i.id = o.item_id WHERE o.id = $1 FOR UPDATE OF o`,
      [orderId],
    );
    const o = rows[0];
    if (!o) throw orderNotFound();
    try {
      const a = await communityAccess(db, o.community_id, userId);
      if (!a.isStaff && o.user_id !== userId) throw orderNotFound();
    } catch {
      throw orderNotFound();
    }
    return o;
  }
}

function itemNotFound() {
  return new ApiError(404, 'item_not_found', 'Item pre-order tidak ditemukan');
}

function orderNotFound() {
  return new ApiError(404, 'order_not_found', 'Pesanan tidak ditemukan');
}
