import { Controller, Get, Inject, Logger } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ApiError, Public } from '../common/http.js';
import { ENV, type Env } from '../config/env.js';

/**
 * Info versi APK terbaru untuk pembaruan di dalam aplikasi (distribusi uji di luar Play Store).
 *
 * Aplikasi memanggil endpoint ini lewat koneksi ber-pinning, mendapat SHA-256 APK, lalu mengunduh
 * APK dari GitHub Releases dan memverifikasi hash-nya sebelum memasang. Android sendiri juga menolak
 * APK yang ditandatangani kunci lain, jadi APK palsu tidak bisa menimpa aplikasi.
 */
const Manifest = z.object({
  versionCode: z.number().int().positive(),
  versionName: z.string().min(1).max(40),
  apkUrl: z.string().url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().positive().optional(),
  notes: z.string().max(2000).default(''),
  publishedAt: z.string().max(40).optional(),
});
type Manifest = z.infer<typeof Manifest>;

const CACHE_MS = 5 * 60_000;

@Controller('app')
export class AppUpdateController {
  private readonly logger = new Logger('AppUpdate');
  private cache?: { at: number; value: Manifest };

  constructor(@Inject(ENV) private readonly env: Env) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('android/latest')
  async latest(): Promise<Manifest> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value;
    try {
      const res = await fetch(this.env.APP_UPDATE_MANIFEST_URL, {
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const manifest = Manifest.parse(await res.json());
      if (!manifest.apkUrl.startsWith(this.env.APP_UPDATE_APK_URL_PREFIX)) throw new Error('apkUrl di luar sumber resmi');
      this.cache = { at: Date.now(), value: manifest };
      return manifest;
    } catch (err) {
      this.logger.warn(`Manifest pembaruan tidak bisa dibaca: ${err instanceof Error ? err.message : 'unknown'}`);
      if (this.cache) return this.cache.value; // sajikan versi lama daripada gagal
      throw new ApiError(503, 'update_unavailable', 'Info pembaruan belum tersedia');
    }
  }
}
