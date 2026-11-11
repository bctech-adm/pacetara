import { API_BASE_URL } from './config';

/**
 * Klien API panel. Token akses hanya di memori; token penyegar di sessionStorage (hilang saat tab
 * ditutup, sesi panel maks. 12 jam di server). Refresh dijalankan satu per satu karena server
 * mencabut sesi jika token penyegar lama dipakai ulang.
 */
const REFRESH_KEY = 'pacetara.admin.refresh';

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onLogout: () => void = () => {};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function setLogoutHandler(fn: () => void) {
  onLogout = fn;
}

export function hasStoredSession(): boolean {
  return Boolean(safeGet(REFRESH_KEY));
}

export async function login(email: string, password: string, code: string): Promise<void> {
  const res = await raw('POST', '/v1/admin/auth/login', { email, password, code }, false);
  accessToken = res.accessToken as string;
  safeSet(REFRESH_KEY, res.refreshToken as string);
}

export async function logout(): Promise<void> {
  const refreshToken = safeGet(REFRESH_KEY);
  try {
    if (refreshToken && accessToken) await raw('POST', '/v1/auth/logout', { refreshToken }, true);
  } catch {
    // tetap keluar di sisi panel
  }
  clearSession();
}

function clearSession() {
  accessToken = null;
  safeRemove(REFRESH_KEY);
}

async function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    const refreshToken = safeGet(REFRESH_KEY);
    if (!refreshToken) return false;
    try {
      const res = await raw('POST', '/v1/auth/refresh', { refreshToken }, false);
      accessToken = res.accessToken as string;
      safeSet(REFRESH_KEY, res.refreshToken as string);
      return true;
    } catch {
      clearSession();
      return false;
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  if (!accessToken && !(await refresh())) {
    onLogout();
    throw new ApiError(401, 'unauthorized', 'Sesi berakhir, silakan masuk lagi');
  }
  try {
    return (await raw(method, path, body, true)) as T;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      if (await refresh()) return (await raw(method, path, body, true)) as T;
      onLogout();
    }
    throw err;
  }
}

/** Ambil gambar ber-token (mis. foto postingan yang dilaporkan) sebagai object URL; pemanggil wajib revoke. */
export async function apiImage(path: string): Promise<string> {
  if (!accessToken && !(await refresh())) {
    onLogout();
    throw new ApiError(401, 'unauthorized', 'Sesi berakhir, silakan masuk lagi');
  }
  const get = () => fetch(`${API_BASE_URL}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  let res = await get();
  if (res.status === 401 && (await refresh())) res = await get();
  if (!res.ok) throw new ApiError(res.status, 'error', `Galat ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

async function raw(method: string, path: string, body: unknown, auth: boolean): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(`${API_BASE_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return {};
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const fields = data.fields as { message: string }[] | undefined;
    const message = typeof data.message === 'string' ? data.message : (fields?.[0]?.message ?? `Galat ${res.status}`);
    throw new ApiError(res.status, typeof data.error === 'string' ? data.error : 'error', message);
  }
  return data;
}

function safeGet(k: string): string | null {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string) {
  try {
    sessionStorage.setItem(k, v);
  } catch {
    /* mode privat: sesi hanya selama halaman terbuka */
  }
}
function safeRemove(k: string) {
  try {
    sessionStorage.removeItem(k);
  } catch {
    /* abaikan */
  }
}
