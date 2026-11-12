import { Injectable } from '@nestjs/common';

/**
 * Satu-satunya jalan keluar HTTP ke penyedia impor. Mencegah SSRF:
 * - hanya https ke host yang ada di ALLOWED_HOSTS (tanpa port, user, atau password di URL);
 * - redirect tidak diikuti (`redirect: 'error'`), jadi host yang sah tidak bisa membelokkan ke alamat internal;
 * - batas waktu dan batas ukuran respons.
 * URL dari isi webhook tidak pernah dipakai langsung; pemanggil memvalidasinya dulu (lihat garmin.ts).
 */
export const ALLOWED_HOSTS = new Set(['apis.garmin.com', 'diauth.garmin.com', 'www.strava.com']);

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 20 * 1024 * 1024;

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ProviderRequest {
  method?: 'GET' | 'POST' | 'DELETE';
  /** Bearer token pengguna. Tidak pernah di-log. */
  bearer?: string;
  /** Body form (application/x-www-form-urlencoded). */
  form?: Record<string, string>;
}

export function assertAllowedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderHttpError(0, 'URL tidak valid');
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '' || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new ProviderHttpError(0, 'Host tidak diizinkan');
  }
  return url;
}

@Injectable()
export class ProviderHttp {
  protected fetchFn: typeof fetch = (input, init) => fetch(input, init);

  /** @returns body JSON (atau null untuk 204). Melempar ProviderHttpError untuk status selain 2xx. */
  async request<T = unknown>(rawUrl: string, req: ProviderRequest = {}): Promise<T> {
    const url = assertAllowedUrl(rawUrl);
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'PaceTara-Import/1.0' };
    if (req.bearer) headers.Authorization = `Bearer ${req.bearer}`;
    let body: string | undefined;
    if (req.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(req.form).toString();
    }
    const res = await this.fetchFn(url, {
      method: req.method ?? (body ? 'POST' : 'GET'),
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_BYTES) throw new ProviderHttpError(res.status, 'Respons terlalu besar');
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new ProviderHttpError(res.status, 'Respons terlalu besar');
    // Pesan galat hanya status + host; isi respons (bisa memuat token) tidak pernah dimasukkan.
    if (!res.ok) throw new ProviderHttpError(res.status, `${url.hostname} menjawab ${res.status}`);
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ProviderHttpError(res.status, `${url.hostname} mengirim JSON tidak valid`);
    }
  }
}
