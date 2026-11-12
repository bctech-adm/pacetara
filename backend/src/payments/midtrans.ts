import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';

/**
 * Alamat Midtrans Snap + Core API. Dikumpulkan di satu tempat agar mudah dicek ulang saat akun produksi aktif.
 * Sandbox dan produksi memakai server key yang berbeda (MIDTRANS_PRODUCTION).
 */
export const MIDTRANS = {
  snap: { sandbox: 'https://app.sandbox.midtrans.com/snap/v1/transactions', production: 'https://app.midtrans.com/snap/v1/transactions' },
  api: { sandbox: 'https://api.sandbox.midtrans.com/v2', production: 'https://api.midtrans.com/v2' },
} as const;

/** Status transaksi dari GET /v2/{order_id}/status (bagian yang dipakai). */
export interface MidtransStatus {
  order_id?: string;
  status_code?: string;
  transaction_status?: string;
  fraud_status?: string;
  gross_amount?: string;
  payment_type?: string;
  settlement_time?: string;
}

export class MidtransError extends Error {
  constructor(readonly status: number) {
    super(`Midtrans menjawab ${status}`);
  }
}

/** Antarmuka yang dipalsukan di tes. */
export interface MidtransClient {
  readonly enabled: boolean;
  createSnap(input: { orderId: string; amount: number; itemName: string; finishUrl: string }): Promise<{ token: string; redirectUrl: string }>;
  status(orderId: string): Promise<MidtransStatus>;
  /** Kunci server untuk memeriksa signature_key notifikasi. */
  verifyNotification(body: { order_id?: unknown; status_code?: unknown; gross_amount?: unknown; signature_key?: unknown }): boolean;
}

/** signature_key = SHA512(order_id + status_code + gross_amount + server_key), dibandingkan waktu-konstan. */
export function midtransSignatureOk(
  serverKey: string,
  body: { order_id?: unknown; status_code?: unknown; gross_amount?: unknown; signature_key?: unknown },
): boolean {
  if (!serverKey) return false;
  const { order_id, status_code, gross_amount, signature_key } = body;
  if (typeof order_id !== 'string' || typeof status_code !== 'string' || typeof gross_amount !== 'string' || typeof signature_key !== 'string') return false;
  const expected = createHash('sha512').update(`${order_id}${status_code}${gross_amount}${serverKey}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature_key.toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Status Midtrans → status pembayaran PaceTara. `capture` kartu hanya dianggap lunas jika fraud_status `accept`.
 * Status lain/tidak dikenal = tetap menunggu.
 */
export function mapMidtransStatus(s: MidtransStatus): 'pending' | 'paid' | 'failed' | 'expired' | 'refunded' {
  switch (s.transaction_status) {
    case 'settlement':
      return 'paid';
    case 'capture':
      return s.fraud_status === 'accept' || s.fraud_status === undefined ? 'paid' : 'pending';
    case 'deny':
    case 'cancel':
    case 'failure':
      return 'failed';
    case 'expire':
      return 'expired';
    case 'refund':
    case 'partial_refund':
    case 'chargeback':
    case 'partial_chargeback':
      return 'refunded';
    default:
      return 'pending';
  }
}

const TIMEOUT_MS = 15_000;
const ORDER_ID_RE = /^[A-Za-z0-9._~-]{1,50}$/;

/**
 * Klien Midtrans (Snap untuk membuat transaksi, Core API untuk status). Basic auth `server_key:`. Hanya ke host
 * Midtrans, tanpa mengikuti redirect, batas waktu 15 detik. Tidak ada data pelanggan (nama/email/HP) yang dikirim:
 * Snap meminta datanya sendiri di halaman pembayaran bila perlu.
 */
@Injectable()
export class MidtransApi implements MidtransClient {
  constructor(@Inject(ENV) private readonly env: Env) {}

  get enabled(): boolean {
    return Boolean(this.env.MIDTRANS_SERVER_KEY);
  }

  private get mode(): 'sandbox' | 'production' {
    return this.env.MIDTRANS_PRODUCTION ? 'production' : 'sandbox';
  }

  private headers(): Record<string, string> {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${this.env.MIDTRANS_SERVER_KEY}:`).toString('base64')}`,
    };
  }

  async createSnap(input: { orderId: string; amount: number; itemName: string; finishUrl: string }) {
    if (!ORDER_ID_RE.test(input.orderId)) throw new MidtransError(0);
    const res = await fetch(MIDTRANS.snap[this.mode], {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        transaction_details: { order_id: input.orderId, gross_amount: input.amount },
        item_details: [{ id: input.orderId.slice(0, 50), price: input.amount, quantity: 1, name: input.itemName.slice(0, 50) }],
        callbacks: { finish: input.finishUrl },
        expiry: { unit: 'hours', duration: 24 },
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new MidtransError(res.status);
    const j = (await res.json()) as { token?: string; redirect_url?: string };
    if (!j.token || !j.redirect_url?.startsWith('https://')) throw new MidtransError(res.status);
    return { token: j.token, redirectUrl: j.redirect_url };
  }

  async status(orderId: string): Promise<MidtransStatus> {
    if (!ORDER_ID_RE.test(orderId)) throw new MidtransError(0);
    const res = await fetch(`${MIDTRANS.api[this.mode]}/${encodeURIComponent(orderId)}/status`, {
      headers: this.headers(),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new MidtransError(res.status);
    return (await res.json()) as MidtransStatus;
  }

  verifyNotification(body: { order_id?: unknown; status_code?: unknown; gross_amount?: unknown; signature_key?: unknown }): boolean {
    return midtransSignatureOk(this.env.MIDTRANS_SERVER_KEY, body);
  }
}
