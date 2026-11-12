import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isEntitled, kindOfProduct, shortState } from './config.js';
import { PubSubOidcVerifier, verifyGoogleOidc } from './oidc.js';
import { PlayApiError } from './play-api.js';
import type { Env } from '../config/env.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const CERTS = { k1: PEM };
const AUD = 'https://api.test/v1/subscriptions/play/rtdn';
const EMAIL = 'rtdn-push@proj.iam.gserviceaccount.com';
const NOW = 1_800_000_000;

function jwt(claims: Record<string, unknown>, opts: { kid?: string; alg?: string; key?: typeof privateKey } = {}) {
  const h = Buffer.from(JSON.stringify({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const s = sign('RSA-SHA256', Buffer.from(`${h}.${p}`), opts.key ?? privateKey).toString('base64url');
  return `${h}.${p}.${s}`;
}

const good = { iss: 'https://accounts.google.com', aud: AUD, email: EMAIL, email_verified: true, iat: NOW - 10, exp: NOW + 3590, sub: '123' };
const expect_ = { audience: AUD, email: EMAIL, nowSec: NOW };

describe('verifyGoogleOidc (token Pub/Sub push)', () => {
  it('menerima token bertanda tangan kunci Google dengan aud dan email yang benar', () => {
    expect(verifyGoogleOidc(jwt(good), CERTS, expect_).email).toBe(EMAIL);
    expect(verifyGoogleOidc(jwt({ ...good, iss: 'accounts.google.com' }), CERTS, expect_).aud).toBe(AUD);
  });

  it('menolak tanda tangan kunci lain, kid tak dikenal, dan alg selain RS256', () => {
    expect(() => verifyGoogleOidc(jwt(good, { key: other.privateKey }), CERTS, expect_)).toThrow(/tanda tangan/);
    expect(() => verifyGoogleOidc(jwt(good, { kid: 'k2' }), CERTS, expect_)).toThrow(/kid/);
    expect(() => verifyGoogleOidc(jwt(good, { alg: 'none' }), CERTS, expect_)).toThrow(/algoritma/);
    // Isi diubah setelah ditandatangani.
    const [h, , s] = jwt(good).split('.');
    const forged = Buffer.from(JSON.stringify({ ...good, email: 'attacker@evil.test' })).toString('base64url');
    expect(() => verifyGoogleOidc(`${h}.${forged}.${s}`, CERTS, expect_)).toThrow(/tanda tangan/);
  });

  it('menolak aud, iss, email, email_verified yang salah', () => {
    expect(() => verifyGoogleOidc(jwt({ ...good, aud: 'https://lain.test' }), CERTS, expect_)).toThrow(/aud/);
    expect(() => verifyGoogleOidc(jwt({ ...good, iss: 'https://evil.test' }), CERTS, expect_)).toThrow(/iss/);
    expect(() => verifyGoogleOidc(jwt({ ...good, email: 'lain@proj.iam.gserviceaccount.com' }), CERTS, expect_)).toThrow(/email/);
    expect(() => verifyGoogleOidc(jwt({ ...good, email_verified: false }), CERTS, expect_)).toThrow(/email/);
  });

  it('menolak token kedaluwarsa, dari masa depan, atau berumur terlalu panjang', () => {
    expect(() => verifyGoogleOidc(jwt({ ...good, iat: NOW - 7200, exp: NOW - 3600 }), CERTS, expect_)).toThrow(/kedaluwarsa/);
    expect(() => verifyGoogleOidc(jwt({ ...good, iat: NOW + 3600, exp: NOW + 7000 }), CERTS, expect_)).toThrow(/iat/);
    expect(() => verifyGoogleOidc(jwt({ ...good, exp: NOW + 86_400 }), CERTS, expect_)).toThrow(/umur/);
  });

  it('menolak format rusak', () => {
    expect(() => verifyGoogleOidc('abc', CERTS, expect_)).toThrow(/format/);
    expect(() => verifyGoogleOidc('a.b.c!', CERTS, expect_)).toThrow(/format/);
  });
});

describe('konfigurasi langganan', () => {
  const env = { PLAY_PRODUCT_PREMIUM: 'p_premium', PLAY_PRODUCT_PRO: 'p_pro', PLAY_PRODUCT_PRO_UNLIMITED: 'p_unl' } as Env;

  it('memetakan productId ke jenis paket', () => {
    expect(kindOfProduct(env, 'p_premium')).toBe('premium');
    expect(kindOfProduct(env, 'p_unl')).toBe('pro_unlimited');
    expect(kindOfProduct(env, 'lain')).toBeUndefined();
  });

  it('status Google: hanya aktif/dibatalkan-berjalan/masa tenggang yang memberi hak sebelum kedaluwarsa', () => {
    const future = new Date(Date.now() + 86_400_000);
    const past = new Date(Date.now() - 1000);
    const e = (state: string, expiresAt: Date | null, revoked = false, replaced = false) => isEntitled({ state, expiresAt, revoked, replaced });
    expect(shortState('SUBSCRIPTION_STATE_IN_GRACE_PERIOD')).toBe('IN_GRACE_PERIOD');
    expect(shortState(undefined)).toBe('UNSPECIFIED');
    expect(e('ACTIVE', future)).toBe(true);
    expect(e('CANCELED', future)).toBe(true);
    expect(e('IN_GRACE_PERIOD', future)).toBe(true);
    expect(e('CANCELED', past)).toBe(false);
    for (const s of ['ON_HOLD', 'PAUSED', 'EXPIRED', 'PENDING']) expect(e(s, future)).toBe(false);
    expect(e('ACTIVE', future, true)).toBe(false);
    expect(e('ACTIVE', future, false, true)).toBe(false);
  });

  it('galat API Google: 400/404/410 = token tidak sah', () => {
    expect(new PlayApiError(410).invalidToken).toBe(true);
    expect(new PlayApiError(500).invalidToken).toBe(false);
  });
});

describe('PubSubOidcVerifier', () => {
  it('kid tak dikenal memuat ulang sertifikat paling sering sekali per menit', async () => {
    const calls: boolean[] = [];
    class Counting extends PubSubOidcVerifier {
      protected override async loadCerts(force: boolean) {
        calls.push(force);
        return CERTS;
      }
    }
    const v = new Counting({ PLAY_RTDN_AUDIENCE: AUD, PLAY_RTDN_SERVICE_ACCOUNT_EMAIL: EMAIL } as unknown as Env);
    const fake = (kid: string) =>
      `Bearer ${Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url')}.${Buffer.from('{}').toString('base64url')}.${'a'.repeat(40)}`;
    for (let i = 0; i < 5; i++) await expect(v.verify(fake(`acak-${i}`))).rejects.toThrow();
    expect(calls.filter(Boolean)).toHaveLength(1);
  });
});
