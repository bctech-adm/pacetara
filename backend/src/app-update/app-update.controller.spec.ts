import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.js';
import { AppUpdateController } from './app-update.controller.js';

const env = {
  APP_UPDATE_MANIFEST_URL: 'https://github.com/bctech-adm/pacetara/releases/latest/download/latest.json',
  APP_UPDATE_APK_URL_PREFIX: 'https://github.com/bctech-adm/pacetara/releases/download/',
} as Env;

const manifest = (apkUrl = 'https://github.com/bctech-adm/pacetara/releases/download/android-12/pacetara-12.apk') => ({
  versionCode: 12,
  versionName: '0.1.12',
  apkUrl,
  sha256: 'a'.repeat(64),
  notes: 'Perbaikan',
});

const mockFetch = (body: unknown, ok = true) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok, status: ok ? 200 : 404, json: async () => body } as Response);

describe('AppUpdateController', () => {
  afterEach(() => vi.restoreAllMocks());

  it('mengembalikan manifest yang valid dan menyimpannya di cache', async () => {
    const f = mockFetch(manifest());
    const c = new AppUpdateController(env);
    await expect(c.latest()).resolves.toMatchObject({ versionCode: 12, versionName: '0.1.12' });
    await c.latest();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('menolak APK dari luar sumber resmi', async () => {
    mockFetch(manifest('https://evil.example/pacetara.apk'));
    await expect(new AppUpdateController(env).latest()).rejects.toMatchObject({ status: 503 });
  });

  it('menolak manifest dengan hash tidak valid', async () => {
    mockFetch({ ...manifest(), sha256: 'bukan-hash' });
    await expect(new AppUpdateController(env).latest()).rejects.toMatchObject({ status: 503 });
  });

  it('503 jika belum ada rilis', async () => {
    mockFetch({}, false);
    await expect(new AppUpdateController(env).latest()).rejects.toMatchObject({ status: 503 });
  });
});
