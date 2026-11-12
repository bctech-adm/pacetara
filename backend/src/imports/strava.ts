import type { Point } from '../runs/geo.js';
import type { OAuthTokens } from './garmin.js';
import type { ProviderHttp } from './provider-http.js';
import { type ImportedRun, isStravaRun } from './types.js';

/** Strava API v3, OAuth 2.0 authorization code. */
export const STRAVA = {
  authorizeUrl: 'https://www.strava.com/oauth/authorize',
  tokenUrl: 'https://www.strava.com/api/v3/oauth/token',
  deauthorizeUrl: 'https://www.strava.com/oauth/deauthorize',
  api: 'https://www.strava.com/api/v3',
  /** activity:read_all agar lari "Hanya Saya" ikut; semua lari Strava disimpan privat di PaceTara. */
  scope: 'activity:read_all',
} as const;

export interface StravaActivity {
  id?: unknown;
  name?: unknown;
  sport_type?: unknown;
  type?: unknown;
  start_date?: unknown;
  elapsed_time?: unknown;
  moving_time?: unknown;
  distance?: unknown;
  total_elevation_gain?: unknown;
}

type Streams = Partial<Record<'latlng' | 'time' | 'altitude', { data?: unknown }>>;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** Id aktivitas/atlet Strava: bilangan bulat positif (dipakai di path URL yang kita susun sendiri). */
export const validStravaId = (v: unknown): string | null => {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '';
  return /^[1-9][0-9]{0,19}$/.test(s) ? s : null;
};

export class StravaClient {
  constructor(
    private readonly http: ProviderHttp,
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  authorizeUrl(p: { state: string; redirectUri: string }): string {
    const q = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: p.redirectUri,
      response_type: 'code',
      // Selalu tampilkan layar persetujuan Strava (tanpa redirect diam-diam).
      approval_prompt: 'force',
      scope: STRAVA.scope,
      state: p.state,
    });
    return `${STRAVA.authorizeUrl}?${q}`;
  }

  async exchangeCode(code: string): Promise<OAuthTokens & { athleteId: string }> {
    const r = await this.http.request<{ athlete?: { id?: unknown } }>(STRAVA.tokenUrl, {
      form: { client_id: this.clientId, client_secret: this.clientSecret, code, grant_type: 'authorization_code' },
    });
    const athleteId = validStravaId(r?.athlete?.id);
    if (!athleteId) throw new Error('Strava tidak mengembalikan id atlet');
    return { ...toTokens(r), athleteId };
  }

  async refresh(refreshToken: string): Promise<OAuthTokens> {
    return toTokens(
      await this.http.request(STRAVA.tokenUrl, {
        form: { client_id: this.clientId, client_secret: this.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' },
      }),
    );
  }

  async deauthorize(accessToken: string): Promise<void> {
    await this.http.request(STRAVA.deauthorizeUrl, { method: 'POST', bearer: accessToken, form: {} });
  }

  /** Dipakai untuk memastikan event "deauthorize" dari webhook benar (token memang sudah dicabut). */
  async athlete(accessToken: string): Promise<unknown> {
    return this.http.request(`${STRAVA.api}/athlete`, { bearer: accessToken });
  }

  async listActivities(accessToken: string, afterEpochS: number, perPage = 30): Promise<StravaActivity[]> {
    const q = new URLSearchParams({ after: String(Math.floor(afterEpochS)), per_page: String(perPage), page: '1' });
    const r = await this.http.request<unknown>(`${STRAVA.api}/athlete/activities?${q}`, { bearer: accessToken });
    return Array.isArray(r) ? (r as StravaActivity[]) : [];
  }

  async activity(accessToken: string, id: string): Promise<StravaActivity> {
    const safe = validStravaId(id);
    if (!safe) throw new Error('Id aktivitas tidak valid');
    return (await this.http.request<StravaActivity>(`${STRAVA.api}/activities/${safe}`, { bearer: accessToken })) ?? {};
  }

  async streams(accessToken: string, id: string): Promise<Streams> {
    const safe = validStravaId(id);
    if (!safe) throw new Error('Id aktivitas tidak valid');
    const q = new URLSearchParams({ keys: 'latlng,time,altitude', key_by_type: 'true' });
    try {
      return (await this.http.request<Streams>(`${STRAVA.api}/activities/${safe}/streams?${q}`, { bearer: accessToken })) ?? {};
    } catch {
      // Aktivitas tanpa GPS (treadmill, manual) tidak punya stream: pakai statistik yang dilaporkan.
      return {};
    }
  }
}

function toTokens(r: unknown): OAuthTokens {
  const o = (r ?? {}) as { access_token?: unknown; refresh_token?: unknown; expires_at?: unknown };
  if (typeof o.access_token !== 'string' || !o.access_token) throw new Error('Respons token tidak berisi access_token');
  return {
    accessToken: o.access_token,
    refreshToken: typeof o.refresh_token === 'string' ? o.refresh_token : null,
    expiresAt: typeof o.expires_at === 'number' ? new Date(o.expires_at * 1000) : null,
    scope: STRAVA.scope,
  };
}

/** Aktivitas Strava (+ stream GPS opsional) menjadi ImportedRun. Null jika bukan lari atau tidak lengkap. */
export function stravaToImported(a: StravaActivity, streams: Streams = {}): ImportedRun | null {
  if (!isStravaRun(a.sport_type ?? a.type)) return null;
  const id = validStravaId(a.id);
  const start = typeof a.start_date === 'string' ? new Date(a.start_date) : null;
  const elapsed = num(a.elapsed_time);
  if (!id || !start || Number.isNaN(start.getTime()) || elapsed === null || elapsed <= 0) return null;

  const latlng = Array.isArray(streams.latlng?.data) ? (streams.latlng!.data as unknown[]) : [];
  const time = Array.isArray(streams.time?.data) ? (streams.time!.data as unknown[]) : [];
  const alt = Array.isArray(streams.altitude?.data) ? (streams.altitude!.data as unknown[]) : [];
  const points: Point[] = [];
  if (latlng.length === time.length) {
    for (let i = 0; i < latlng.length; i++) {
      const ll = latlng[i];
      const t = num(time[i]);
      if (!Array.isArray(ll) || t === null || t < 0 || t > 86_400) continue;
      const lat = num(ll[0]);
      const lng = num(ll[1]);
      if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      points.push([lat, lng, t, num(alt[i])]);
    }
  }
  const name = typeof a.name === 'string' ? a.name.trim().slice(0, 80) : '';
  return {
    source: 'strava',
    externalId: id,
    title: name || 'Lari dari Strava',
    startedAt: start,
    endedAt: new Date(start.getTime() + elapsed * 1000),
    segments: points.length >= 2 ? [points] : [],
    reported: { distanceM: num(a.distance), movingTimeS: num(a.moving_time), elevationGainM: num(a.total_elevation_gain) },
    // Selalu privat (PRD 2.3, keputusan #63); ditegakkan lagi di ImportWriter dan constraint database.
    visibility: 'private',
  };
}
