import type { Point } from '../runs/geo.js';
import type { ProviderHttp } from './provider-http.js';
import { type ImportedRun, isGarminRun } from './types.js';

/**
 * Garmin Connect Developer Program (Health/Activity API), OAuth 2.0 + PKCE.
 * Alamat di bawah mengikuti dokumentasi migrasi OAuth2 Garmin (2024–2025); WAJIB dicek ulang di portal
 * developer setelah akun PT disetujui (lihat KEPUTUSAN.md modul 2.3).
 */
export const GARMIN = {
  authorizeUrl: 'https://connect.garmin.com/oauth2Confirm',
  tokenUrl: 'https://diauth.garmin.com/di-oauth2-service/oauth/token',
  userIdUrl: 'https://apis.garmin.com/wellness-api/rest/user/id',
  registrationUrl: 'https://apis.garmin.com/wellness-api/rest/user/registration',
} as const;

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string;
}

/**
 * callbackURL dari notifikasi ping Garmin hanya boleh menuju API Garmin. Apa pun selain
 * https://apis.garmin.com/wellness-api/rest/... ditolak (SSRF). Permintaannya tetap membawa token
 * pengguna, jadi data yang diterima pasti berasal dari Garmin untuk pengguna itu.
 */
export function validGarminCallbackUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'apis.garmin.com' || url.port || url.username || url.password) return null;
  if (!url.pathname.startsWith('/wellness-api/rest/') || url.pathname.includes('..')) return null;
  return url.toString();
}

export class GarminClient {
  constructor(
    private readonly http: ProviderHttp,
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  authorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      code_challenge: p.codeChallenge,
      code_challenge_method: 'S256',
      redirect_uri: p.redirectUri,
      state: p.state,
    });
    return `${GARMIN.authorizeUrl}?${q}`;
  }

  async exchangeCode(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<OAuthTokens> {
    return toTokens(
      await this.http.request(GARMIN.tokenUrl, {
        form: {
          grant_type: 'authorization_code',
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code: p.code,
          code_verifier: p.codeVerifier,
          redirect_uri: p.redirectUri,
        },
      }),
    );
  }

  async refresh(refreshToken: string): Promise<OAuthTokens> {
    return toTokens(
      await this.http.request(GARMIN.tokenUrl, {
        form: { grant_type: 'refresh_token', client_id: this.clientId, client_secret: this.clientSecret, refresh_token: refreshToken },
      }),
    );
  }

  async userId(accessToken: string): Promise<string> {
    const r = await this.http.request<{ userId?: unknown }>(GARMIN.userIdUrl, { bearer: accessToken });
    if (typeof r?.userId !== 'string' || !r.userId) throw new Error('Garmin tidak mengembalikan userId');
    return r.userId;
  }

  /** Cabut izin di Garmin (putuskan sambungan). */
  async deregister(accessToken: string): Promise<void> {
    await this.http.request(GARMIN.registrationUrl, { method: 'DELETE', bearer: accessToken });
  }

  /** Tarik data dari callbackURL notifikasi ping (sudah divalidasi validGarminCallbackUrl). */
  async pull(callbackUrl: string, accessToken: string): Promise<unknown[]> {
    const url = validGarminCallbackUrl(callbackUrl);
    if (!url) throw new Error('callbackURL Garmin ditolak');
    const r = await this.http.request<unknown>(url, { bearer: accessToken });
    return Array.isArray(r) ? r : [];
  }
}

function toTokens(r: unknown): OAuthTokens {
  const o = (r ?? {}) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown };
  if (typeof o.access_token !== 'string' || !o.access_token) throw new Error('Respons token tidak berisi access_token');
  return {
    accessToken: o.access_token,
    refreshToken: typeof o.refresh_token === 'string' ? o.refresh_token : null,
    expiresAt: typeof o.expires_in === 'number' ? new Date(Date.now() + o.expires_in * 1000) : null,
    scope: typeof o.scope === 'string' ? o.scope.slice(0, 500) : '',
  };
}

interface GarminSummary {
  activityId?: unknown;
  summaryId?: unknown;
  activityName?: unknown;
  activityType?: unknown;
  startTimeInSeconds?: unknown;
  durationInSeconds?: unknown;
  movingDurationInSeconds?: unknown;
  distanceInMeters?: unknown;
  totalElevationGainInMeters?: unknown;
}

interface GarminSample {
  startTimeInSeconds?: unknown;
  latitudeInDegree?: unknown;
  longitudeInDegree?: unknown;
  elevationInMeters?: unknown;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Satu aktivitas Garmin (Activity Summary, atau Activity Details yang membawa `summary` + `samples`)
 * menjadi ImportedRun. Mengembalikan null untuk aktivitas bukan lari atau data yang tidak lengkap.
 */
export function garminToImported(raw: unknown): ImportedRun | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as GarminSummary & { summary?: GarminSummary; samples?: unknown };
  const s: GarminSummary = item.summary && typeof item.summary === 'object' ? { ...item.summary, activityId: item.activityId ?? item.summary.activityId, summaryId: item.summaryId ?? item.summary.summaryId } : item;
  if (!isGarminRun(s.activityType)) return null;
  const start = num(s.startTimeInSeconds);
  const duration = num(s.durationInSeconds);
  if (start === null || duration === null || duration <= 0) return null;
  const idRaw = s.activityId ?? (typeof s.summaryId === 'string' ? s.summaryId.replace(/-detail$/, '') : undefined);
  if ((typeof idRaw !== 'string' && typeof idRaw !== 'number') || String(idRaw).length === 0 || String(idRaw).length > 128) return null;

  const points: Point[] = [];
  if (Array.isArray(item.samples)) {
    for (const p of item.samples as GarminSample[]) {
      const t = num(p?.startTimeInSeconds);
      const lat = num(p?.latitudeInDegree);
      const lng = num(p?.longitudeInDegree);
      if (t === null || lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      const rel = t - start;
      if (rel < 0 || rel > 86_400) continue;
      points.push([lat, lng, rel, num(p.elevationInMeters)]);
    }
    points.sort((a, b) => a[2] - b[2]);
  }
  const name = typeof s.activityName === 'string' ? s.activityName.trim().slice(0, 80) : '';
  return {
    source: 'garmin',
    externalId: String(idRaw),
    title: name || 'Lari dari Garmin',
    startedAt: new Date(start * 1000),
    endedAt: new Date((start + duration) * 1000),
    segments: points.length >= 2 ? [points] : [],
    reported: {
      distanceM: num(s.distanceInMeters),
      movingTimeS: num(s.movingDurationInSeconds) ?? duration,
      elevationGainM: num(s.totalElevationGainInMeters),
    },
    visibility: 'private',
  };
}
