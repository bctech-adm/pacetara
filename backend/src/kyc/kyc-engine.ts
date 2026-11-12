import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { ApiError } from '../common/http.js';
import { ENV, type Env } from '../config/env.js';
import type { KycAnalysis } from './ktp.js';

/** Maks. verifikasi yang menunggu di antrean memori (selebihnya 503 kyc_busy, aplikasi meminta coba lagi). */
const MAX_PENDING = 3;
/** Batas waktu satu analisis; analisis pertama ikut memuat model (±2–5 detik). */
const TIMEOUT_MS = 90_000;
/** Thread dihentikan setelah menganggur agar memori model (±200 MB) dilepas. */
const IDLE_MS = 10 * 60_000;

type Pending = { resolve: (v: KycAnalysis) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout };

/**
 * Mesin verifikasi Level 2 self-hosted (keputusan pemilik, REVIEW-PRD C3). Menjalankan `engine-thread.js` di worker
 * thread agar OCR + jaringan saraf (CPU berat) tidak memblokir event loop API. Satu thread, antrean serial.
 * Gambar dikirim lewat transfer ArrayBuffer (tidak lewat Redis/antrean BullMQ yang tersimpan di disk).
 */
@Injectable()
export class KycEngine implements OnModuleDestroy {
  private readonly logger = new Logger('KycEngine');
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  get enabled(): boolean {
    return this.env.KYC_ENGINE === 'local';
  }

  async analyze(ktp: Buffer, selfie: Buffer): Promise<KycAnalysis> {
    if (!this.enabled) throw new ApiError(503, 'not_configured', 'Verifikasi KTP belum tersedia');
    if (this.pending.size >= MAX_PENDING) throw new ApiError(503, 'kyc_busy', 'Sedang banyak verifikasi. Coba lagi beberapa menit lagi');
    const worker = this.ensureWorker();
    const id = ++this.seq;
    // Salinan ke ArrayBuffer baru yang ditransfer (thread utama tidak memegangnya lagi).
    const k = new Uint8Array(ktp).slice().buffer;
    const s = new Uint8Array(selfie).slice().buffer;
    return new Promise<KycAnalysis>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ApiError(503, 'kyc_timeout', 'Verifikasi terlalu lama. Coba lagi'));
        // Thread yang macet dihentikan; antrean lain ikut gagal dan bisa dicoba ulang.
        this.stop('timeout');
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, type: 'analyze', ktp: k, selfie: s }, [k, s]);
    });
  }

  onModuleDestroy(): void {
    this.stop('shutdown');
  }

  private ensureWorker(): Worker {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./engine-thread.js', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 1024 } });
    worker.on('message', (msg: { id: number; ok: boolean; result?: KycAnalysis; error?: string }) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.ok && msg.result) p.resolve(msg.result);
      else if (msg.error === 'unsupported_image') p.reject(new ApiError(415, 'unsupported_image', 'Berkas bukan gambar yang didukung (JPG, PNG, WebP, HEIC)'));
      else p.reject(new ApiError(503, 'kyc_engine_error', 'Verifikasi gagal diproses. Coba lagi'));
      this.scheduleIdle();
    });
    worker.on('error', () => {
      // Pesan galat tidak dicetak: bisa memuat potongan data dari pustaka.
      this.logger.error('Thread mesin verifikasi berhenti karena galat');
      this.failAll();
      this.worker = null;
    });
    worker.on('exit', () => {
      this.failAll();
      if (this.worker === worker) this.worker = null;
    });
    this.worker = worker;
    return worker;
  }

  private scheduleIdle() {
    if (this.pending.size || this.idleTimer) return;
    this.idleTimer = setTimeout(() => this.stop('idle'), IDLE_MS);
    this.idleTimer.unref();
  }

  private failAll() {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new ApiError(503, 'kyc_engine_error', 'Verifikasi gagal diproses. Coba lagi'));
      this.pending.delete(id);
    }
  }

  private stop(reason: string) {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const w = this.worker;
    this.worker = null;
    if (w) {
      if (reason !== 'idle' && reason !== 'shutdown') this.logger.warn(`Thread mesin verifikasi dihentikan (${reason})`);
      void w.terminate();
    }
    this.failAll();
  }
}
