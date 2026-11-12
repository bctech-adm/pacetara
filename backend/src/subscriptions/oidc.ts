import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../common/http.js';
import { ENV, type Env } from '../config/env.js';

/** Sertifikat penanda tangan token OIDC Google (PEM, per `kid`). */
export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v1/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const SKEW_SEC = 300;

export interface OidcExpectation {
  audience: string;
  email: string;
  nowSec?: number;
}

export interface OidcClaims {
  iss: string;
  aud: string;
  email: string;
  email_verified: boolean;
  exp: number;
  iat: number;
  sub?: string;
}

/**
 * Verifikasi token OIDC yang dikirim Pub/Sub push (header Authorization): tanda tangan RS256 dengan kunci Google
 * (berdasarkan `kid`), `iss` Google, `aud` sama persis dengan yang dikonfigurasi, belum kedaluwarsa, dan `email`
 * = akun layanan push yang dikonfigurasi dengan `email_verified`. Fungsi murni (sertifikat diberikan), diuji
 * dengan kunci uji tanpa internet. Melempar Error berpesan singkat (tanpa isi token).
 */
export function verifyGoogleOidc(jwt: string, certs: Record<string, string>, expect: OidcExpectation): OidcClaims {
  const parts = jwt.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error('format token');
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; kid?: string; typ?: string };
  let claims: Partial<OidcClaims>;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    throw new Error('format token');
  }
  if (header.alg !== 'RS256') throw new Error('algoritma');
  const pem = header.kid ? certs[header.kid] : undefined;
  if (!pem) throw new Error('kid tidak dikenal');
  const ok = verifySignature('RSA-SHA256', Buffer.from(`${h}.${p}`, 'ascii'), createPublicKey(pem), Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('tanda tangan');

  const now = expect.nowSec ?? Math.floor(Date.now() / 1000);
  if (typeof claims.iss !== 'string' || !ISSUERS.has(claims.iss)) throw new Error('iss');
  if (claims.aud !== expect.audience) throw new Error('aud');
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_SEC < now) throw new Error('kedaluwarsa');
  if (typeof claims.iat !== 'number' || claims.iat - SKEW_SEC > now) throw new Error('iat');
  if (claims.exp - claims.iat > 2 * 3600) throw new Error('umur token');
  if (claims.email !== expect.email || claims.email_verified !== true) throw new Error('email');
  return claims as OidcClaims;
}

export interface OidcVerifier {
  /** Melempar ApiError 401 jika header Authorization tidak memuat token OIDC Pub/Sub yang sah. */
  verify(authorization: string | undefined): Promise<void>;
}

/** Verifier produksi: sertifikat Google diambil lewat HTTPS dan disimpan sesuai Cache-Control (maks. 6 jam). */
@Injectable()
export class PubSubOidcVerifier implements OidcVerifier {
  private certs?: { keys: Record<string, string>; until: number };

  constructor(@Inject(ENV) private readonly env: Env) {}

  async verify(authorization: string | undefined): Promise<void> {
    const m = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(authorization ?? '');
    if (!m) throw unauthorized();
    try {
      let certs = await this.loadCerts(false);
      const kid = kidOf(m[1]!);
      // Kunci Google berotasi: kid baru → muat ulang sertifikat sekali.
      if (kid && !certs[kid]) certs = await this.loadCerts(true);
      verifyGoogleOidc(m[1]!, certs, { audience: this.env.PLAY_RTDN_AUDIENCE, email: this.env.PLAY_RTDN_SERVICE_ACCOUNT_EMAIL });
    } catch {
      throw unauthorized();
    }
  }

  protected async loadCerts(force: boolean): Promise<Record<string, string>> {
    if (!force && this.certs && this.certs.until > Date.now()) return this.certs.keys;
    const res = await fetch(GOOGLE_CERTS_URL, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error('sertifikat');
    const keys = (await res.json()) as Record<string, string>;
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 3600);
    this.certs = { keys, until: Date.now() + Math.min(maxAge, 6 * 3600) * 1000 };
    return keys;
  }
}

function kidOf(jwt: string): string | undefined {
  try {
    return (JSON.parse(Buffer.from(jwt.split('.')[0]!, 'base64url').toString('utf8')) as { kid?: string }).kid;
  } catch {
    return undefined;
  }
}

const unauthorized = () => new ApiError(401, 'unauthorized', 'Token Pub/Sub tidak sah');
