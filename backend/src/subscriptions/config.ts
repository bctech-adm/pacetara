import type { Env } from '../config/env.js';

export type SubscriptionKind = 'premium' | 'pro' | 'pro_unlimited';

/** Langganan Play aktif hanya jika nama paket dan akun layanan diisi (pola #117). */
export function playEnabled(env: Pick<Env, 'GOOGLE_PLAY_PACKAGE_NAME' | 'PLAY_SERVICE_ACCOUNT_B64'>): boolean {
  return Boolean(env.GOOGLE_PLAY_PACKAGE_NAME && env.PLAY_SERVICE_ACCOUNT_B64);
}

/** RTDN butuh Play aktif + audience + email akun layanan push Pub/Sub. */
export function rtdnEnabled(env: Env): boolean {
  return playEnabled(env) && Boolean(env.PLAY_RTDN_AUDIENCE && env.PLAY_RTDN_SERVICE_ACCOUNT_EMAIL);
}

export function productIds(env: Env): Record<SubscriptionKind, string> {
  return { premium: env.PLAY_PRODUCT_PREMIUM, pro: env.PLAY_PRODUCT_PRO, pro_unlimited: env.PLAY_PRODUCT_PRO_UNLIMITED };
}

export function kindOfProduct(env: Env, productId: string): SubscriptionKind | undefined {
  const ids = productIds(env);
  return (Object.keys(ids) as SubscriptionKind[]).find((k) => ids[k] === productId);
}

/** purchaseToken Google: huruf, angka, titik, minus, garis bawah. Divalidasi sebelum disusun ke path URL. */
export const PURCHASE_TOKEN_RE = /^[A-Za-z0-9._-]{10,1000}$/;

/** Status Google tanpa awalan, mis. SUBSCRIPTION_STATE_ACTIVE → ACTIVE. */
export function shortState(state: string | undefined): string {
  const s = (state ?? 'SUBSCRIPTION_STATE_UNSPECIFIED').replace(/^SUBSCRIPTION_STATE_/, '');
  return /^[A-Z_]{1,40}$/.test(s) ? s : 'UNSPECIFIED';
}

/** Status yang memberi hak selama masa berlaku belum lewat (sama dengan play_subscription_entitled di SQL). */
export const ENTITLED_STATES = new Set(['ACTIVE', 'CANCELED', 'IN_GRACE_PERIOD']);

export function isEntitled(s: { state: string; expiresAt: Date | null; revoked: boolean; replaced: boolean }, now = new Date()): boolean {
  return !s.revoked && !s.replaced && ENTITLED_STATES.has(s.state) && s.expiresAt !== null && s.expiresAt > now;
}
