import { Inject, Injectable, Logger } from '@nestjs/common';
import { JWT } from 'google-auth-library';
import { ENV, type Env } from '../config/env.js';
import { PURCHASE_TOKEN_RE } from './config.js';

/** Bagian SubscriptionPurchaseV2 (purchases.subscriptionsv2.get) yang dipakai server. */
export interface SubscriptionPurchaseV2 {
  subscriptionState?: string;
  acknowledgementState?: string;
  linkedPurchaseToken?: string;
  latestOrderId?: string;
  testPurchase?: Record<string, unknown>;
  startTime?: string;
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string; obfuscatedExternalProfileId?: string };
  lineItems?: {
    productId?: string;
    expiryTime?: string;
    latestSuccessfulOrderId?: string;
    autoRenewingPlan?: { autoRenewEnabled?: boolean };
    offerDetails?: { basePlanId?: string; offerId?: string };
  }[];
}

export interface VoidedPurchase {
  purchaseToken: string;
  orderId?: string;
  voidedTimeMillis?: string;
}

/** Galat API Google: hanya status HTTP (token dan isi tidak pernah masuk pesan/log). */
export class PlayApiError extends Error {
  constructor(readonly status: number) {
    super(`Google Play API menjawab ${status}`);
  }
  /** Token tidak dikenal/kedaluwarsa/bukan milik paket ini. */
  get invalidToken(): boolean {
    return this.status === 400 || this.status === 404 || this.status === 410;
  }
}

/** Antarmuka yang dipalsukan di tes (override provider PlayApi). */
export interface PlayClient {
  getSubscription(purchaseToken: string): Promise<SubscriptionPurchaseV2>;
  acknowledge(productId: string, purchaseToken: string): Promise<void>;
  /** Hentikan perpanjangan otomatis (pengguna tetap punya hak sampai masa berlaku habis). Tanpa refund. */
  cancel(productId: string, purchaseToken: string): Promise<void>;
  /** Pembelian langganan yang dibatalkan/di-refund sejak [startTimeMs]. */
  listVoided(startTimeMs: number): Promise<VoidedPurchase[]>;
}

const BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';

/**
 * Klien Google Play Developer API (scope androidpublisher) dengan akun layanan dari PLAY_SERVICE_ACCOUNT_B64,
 * pola sama dengan FcmSender (#117). Hanya ke host androidpublisher.googleapis.com, tanpa mengikuti redirect,
 * batas waktu 15 detik. Semua bagian path divalidasi/di-encode.
 */
@Injectable()
export class PlayApi implements PlayClient {
  private readonly logger = new Logger('PlayApi');
  private readonly client?: JWT;
  private readonly pkg: string;

  constructor(@Inject(ENV) env: Env) {
    this.pkg = env.GOOGLE_PLAY_PACKAGE_NAME;
    if (!env.PLAY_SERVICE_ACCOUNT_B64) return;
    try {
      const sa = JSON.parse(Buffer.from(env.PLAY_SERVICE_ACCOUNT_B64, 'base64').toString('utf8')) as { client_email?: string; private_key?: string };
      if (!sa.client_email || !sa.private_key) throw new Error('field kurang');
      this.client = new JWT({ email: sa.client_email, key: sa.private_key, scopes: ['https://www.googleapis.com/auth/androidpublisher'] });
    } catch {
      this.logger.error('PLAY_SERVICE_ACCOUNT_B64 tidak valid; verifikasi langganan dimatikan');
    }
  }

  get ready(): boolean {
    return Boolean(this.client && this.pkg);
  }

  getSubscription(purchaseToken: string) {
    return this.call<SubscriptionPurchaseV2>('GET', `/purchases/subscriptionsv2/tokens/${token(purchaseToken)}`);
  }

  async acknowledge(productId: string, purchaseToken: string) {
    await this.call('POST', `/purchases/subscriptions/${product(productId)}/tokens/${token(purchaseToken)}:acknowledge`, {});
  }

  async cancel(productId: string, purchaseToken: string) {
    await this.call('POST', `/purchases/subscriptions/${product(productId)}/tokens/${token(purchaseToken)}:cancel`, {});
  }

  async listVoided(startTimeMs: number): Promise<VoidedPurchase[]> {
    const out: VoidedPurchase[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page++) {
      const q = new URLSearchParams({ startTime: String(Math.floor(startTimeMs)), type: '1', maxResults: '1000' });
      if (pageToken) q.set('token', pageToken);
      const res = await this.call<{ voidedPurchases?: VoidedPurchase[]; tokenPagination?: { nextPageToken?: string } }>('GET', `/purchases/voidedpurchases?${q}`);
      out.push(...(res.voidedPurchases ?? []).filter((v) => typeof v.purchaseToken === 'string' && PURCHASE_TOKEN_RE.test(v.purchaseToken)));
      pageToken = res.tokenPagination?.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!this.client || !this.pkg) throw new PlayApiError(503);
    const { token: accessToken } = await this.client.getAccessToken();
    const res = await fetch(`${BASE}/${encodeURIComponent(this.pkg)}${path}`, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new PlayApiError(res.status);
    const text = await res.text();
    if (text.length > 1_000_000) throw new PlayApiError(502);
    return (text ? JSON.parse(text) : {}) as T;
  }
}

function token(t: string): string {
  if (!PURCHASE_TOKEN_RE.test(t)) throw new PlayApiError(400);
  return encodeURIComponent(t);
}

function product(p: string): string {
  if (!/^[a-z0-9][a-z0-9._]{0,98}$/.test(p)) throw new PlayApiError(400);
  return encodeURIComponent(p);
}
