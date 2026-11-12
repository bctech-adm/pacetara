import type { Env } from '../config/env.js';

/** URL publik API untuk alamat callback OAuth. Kosong = OAuth impor mati. */
export function publicApiUrl(env: Pick<Env, 'API_PUBLIC_URL' | 'API_DOMAIN'>): string {
  const raw = env.API_PUBLIC_URL || (env.API_DOMAIN ? `https://${env.API_DOMAIN}` : '');
  return raw.replace(/\/+$/, '');
}

/** Garmin aktif hanya jika client id, secret, kunci push, dan URL publik tersedia (pola #117). */
export function garminEnabled(env: Env): boolean {
  return Boolean(env.GARMIN_CLIENT_ID && env.GARMIN_CLIENT_SECRET && env.GARMIN_PUSH_KEY && publicApiUrl(env));
}

export function stravaEnabled(env: Env): boolean {
  return Boolean(env.STRAVA_CLIENT_ID && env.STRAVA_CLIENT_SECRET && publicApiUrl(env));
}

export const redirectUri = (env: Env, provider: 'garmin' | 'strava') => `${publicApiUrl(env)}/v1/imports/${provider}/callback`;
