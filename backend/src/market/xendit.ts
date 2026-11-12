import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';

/**
 * Alamat dan header Xendit xenPlatform yang dipakai, dikumpulkan di satu tempat. Mengikuti dokumentasi Xendit yang
 * kami ketahui (Accounts v2, Split Rules, Invoices v2 dengan header `for-user-id` + `with-split-rule`); **wajib dicek
 * ulang di dokumentasi/dasbor Xendit saat akun xenPlatform PT aktif** (KEPUTUSAN #262).
 */
export const XENDIT = {
  base: 'https://api.xendit.co',
  accounts: '/v2/accounts',
  splitRules: '/split_rules',
  invoices: '/v2/invoices',
  forUserHeader: 'for-user-id',
  splitRuleHeader: 'with-split-rule',
  callbackTokenHeader: 'x-callback-token',
} as const;

export interface XenditAccount {
  id: string;
  status?: string; // INVITED | REGISTERED | AWAITING_DOCS | LIVE | SUSPENDED
}
export interface XenditInvoice {
  id: string;
  external_id?: string;
  status?: string; // PENDING | PAID | SETTLED | EXPIRED
  amount?: number;
  invoice_url?: string;
  paid_at?: string;
}

export class XenditError extends Error {
  constructor(readonly status: number) {
    super(`Xendit menjawab ${status}`);
  }
}

/** Antarmuka yang dipalsukan di tes. */
export interface XenditClient {
  readonly enabled: boolean;
  createManagedAccount(email: string, businessName: string): Promise<XenditAccount>;
  getAccount(accountId: string): Promise<XenditAccount>;
  createSplitRule(input: { name: string; percent: number; flat: number; destinationAccountId: string; reference: string }): Promise<{ id: string }>;
  createInvoice(
    forUserId: string,
    splitRuleId: string | null,
    body: { externalId: string; amount: number; description: string; successUrl: string; failureUrl: string },
  ): Promise<XenditInvoice>;
  getInvoice(forUserId: string, invoiceId: string): Promise<XenditInvoice>;
  expireInvoice(forUserId: string, invoiceId: string): Promise<void>;
  /** Token header x-callback-token dari webhook, dibandingkan waktu-konstan. */
  verifyCallbackToken(token: unknown): boolean;
}

const TIMEOUT_MS = 15_000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Status akun Xendit → status akun penjual PaceTara. */
export function mapAccountStatus(s: string | undefined): 'invited' | 'registered' | 'awaiting_docs' | 'live' | 'suspended' {
  switch ((s ?? '').toUpperCase()) {
    case 'LIVE':
      return 'live';
    case 'REGISTERED':
      return 'registered';
    case 'AWAITING_DOCS':
      return 'awaiting_docs';
    case 'SUSPENDED':
      return 'suspended';
    default:
      return 'invited';
  }
}

/**
 * Klien Xendit (Basic auth `secret_key:`). Hanya ke api.xendit.co, tanpa redirect, batas waktu 15 detik, id divalidasi
 * sebelum disusun ke path. Pesan galat hanya status HTTP. Email penjual dikirim ke Xendit HANYA saat penjual sendiri
 * mengaktifkan pembayaran di aplikasi (Xendit mengirim undangan verifikasi ke email itu).
 */
@Injectable()
export class XenditApi implements XenditClient {
  constructor(@Inject(ENV) private readonly env: Env) {}

  get enabled(): boolean {
    return Boolean(this.env.XENDIT_SECRET_KEY && this.env.XENDIT_CALLBACK_TOKEN && this.env.XENDIT_MASTER_ACCOUNT_ID);
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    const res = await fetch(`${XENDIT.base}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        Authorization: `Basic ${Buffer.from(`${this.env.XENDIT_SECRET_KEY}:`).toString('base64')}`,
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new XenditError(res.status);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  createManagedAccount(email: string, businessName: string) {
    return this.call<XenditAccount>('POST', XENDIT.accounts, { email, type: 'MANAGED', public_profile: { business_name: businessName.slice(0, 100) } });
  }

  getAccount(accountId: string) {
    if (!ID_RE.test(accountId)) throw new XenditError(0);
    return this.call<XenditAccount>('GET', `${XENDIT.accounts}/${accountId}`);
  }

  createSplitRule(input: { name: string; percent: number; flat: number; destinationAccountId: string; reference: string }) {
    const route = input.percent > 0
      ? { percent_amount: input.percent, currency: 'IDR', destination_account_id: input.destinationAccountId, reference_id: input.reference }
      : { flat_amount: input.flat, currency: 'IDR', destination_account_id: input.destinationAccountId, reference_id: input.reference };
    return this.call<{ id: string }>('POST', XENDIT.splitRules, { name: input.name, description: 'Komisi PaceTara', routes: [route] });
  }

  createInvoice(forUserId: string, splitRuleId: string | null, body: { externalId: string; amount: number; description: string; successUrl: string; failureUrl: string }) {
    if (!ID_RE.test(forUserId)) throw new XenditError(0);
    const headers: Record<string, string> = { [XENDIT.forUserHeader]: forUserId };
    if (splitRuleId) headers[XENDIT.splitRuleHeader] = splitRuleId;
    return this.call<XenditInvoice>(
      'POST',
      XENDIT.invoices,
      {
        external_id: body.externalId,
        amount: body.amount,
        description: body.description.slice(0, 250),
        currency: 'IDR',
        invoice_duration: 3600,
        success_redirect_url: body.successUrl,
        failure_redirect_url: body.failureUrl,
      },
      headers,
    );
  }

  getInvoice(forUserId: string, invoiceId: string) {
    if (!ID_RE.test(forUserId) || !ID_RE.test(invoiceId)) throw new XenditError(0);
    return this.call<XenditInvoice>('GET', `${XENDIT.invoices}/${invoiceId}`, undefined, { [XENDIT.forUserHeader]: forUserId });
  }

  async expireInvoice(forUserId: string, invoiceId: string) {
    if (!ID_RE.test(forUserId) || !ID_RE.test(invoiceId)) throw new XenditError(0);
    await this.call('POST', `/invoices/${invoiceId}/expire!`, undefined, { [XENDIT.forUserHeader]: forUserId });
  }

  verifyCallbackToken(token: unknown): boolean {
    const expected = this.env.XENDIT_CALLBACK_TOKEN;
    if (!expected || typeof token !== 'string') return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
