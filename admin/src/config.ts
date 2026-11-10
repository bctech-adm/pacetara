declare global {
  interface Window {
    __PACETARA__?: { apiBaseUrl?: string };
  }
}

const raw = window.__PACETARA__?.apiBaseUrl ?? '';
// Saat `npm run dev`, template Caddy tidak dirender; pakai VITE_API_BASE_URL.
export const API_BASE_URL = raw && !raw.includes('{{') ? raw : (import.meta.env.VITE_API_BASE_URL ?? '');
