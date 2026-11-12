import { API_BASE_URL } from '../config';

/**
 * Klien API dasbor penjual & sponsor (modul 3.2/3.3) di /dasbor. Login dengan akun PaceTara biasa (email + kata
 * sandi), terpisah dari sesi panel super admin: token akses hanya di memori, token penyegar di sessionStorage dengan
 * kunci sendiri. Refresh dijalankan satu per satu (server mencabut sesi bila token penyegar lama dipakai ulang).
 */
const REFRESH_KEY = 'pacetara.dash.refresh';

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onLogout: () => void = () => {};

export class DashError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function setDashLogoutHandler(fn: () => void) {
  onLogout = fn;
}

export function hasDashSession(): boolean {
  return Boolean(safe(() => sessionStorage.getItem(REFRESH_KEY)));
}

export async function dashLogin(email: string, password: string): Promise<{ displayName: string; verificationLevel: number }> {
  const res = await raw('POST', '/v1/auth/login', { email, password, device: 'Dasbor web' }, false);
  accessToken = res.accessToken as string;
  safe(() => sessionStorage.setItem(REFRESH_KEY, res.refreshToken as string));
  return res.user as { displayName: string; verificationLevel: number };
}

export async function dashLogout(): Promise<void> {
  const refreshToken = safe(() => sessionStorage.getItem(REFRESH_KEY));
  try {
    if (refreshToken && accessToken) await raw('POST', '/v1/auth/logout', { refreshToken }, true);
  } catch {
    // tetap keluar di sisi dasbor
  }
  accessToken = null;
  safe(() => sessionStorage.removeItem(REFRESH_KEY));
}

async function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    const refreshToken = safe(() => sessionStorage.getItem(REFRESH_KEY));
    if (!refreshToken) return false;
    try {
      const res = await raw('POST', '/v1/auth/refresh', { refreshToken }, false);
      accessToken = res.accessToken as string;
      safe(() => sessionStorage.setItem(REFRESH_KEY, res.refreshToken as string));
      return true;
    } catch {
      accessToken = null;
      safe(() => sessionStorage.removeItem(REFRESH_KEY));
      return false;
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** Permintaan ber-token. `body` FormData dikirim multipart (unggah foto/banner), selain itu JSON. */
export async function dash<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  if (!accessToken && !(await refresh())) {
    onLogout();
    throw new DashError(401, 'unauthorized', 'Sesi berakhir, silakan masuk lagi');
  }
  try {
    return (await raw(method, path, body, true)) as T;
  } catch (err) {
    if (err instanceof DashError && err.status === 401) {
      if (await refresh()) return (await raw(method, path, body, true)) as T;
      onLogout();
    }
    throw err;
  }
}

/** Gambar ber-token (foto listing, banner) sebagai object URL; pemanggil wajib revoke. */
export async function dashImage(path: string): Promise<string> {
  if (!accessToken && !(await refresh())) throw new DashError(401, 'unauthorized', 'Sesi berakhir');
  const get = () => fetch(`${API_BASE_URL}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  let res = await get();
  if (res.status === 401 && (await refresh())) res = await get();
  if (!res.ok) throw new DashError(res.status, 'error', `Galat ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

async function raw(method: string, path: string, body: unknown, auth: boolean): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
  if (res.status === 204) return {};
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const fields = data.fields as { message: string }[] | undefined;
    const message = typeof data.message === 'string' ? data.message : (fields?.[0]?.message ?? `Galat ${res.status}`);
    throw new DashError(res.status, typeof data.error === 'string' ? data.error : 'error', message);
  }
  return data;
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
