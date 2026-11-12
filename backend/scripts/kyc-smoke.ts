/**
 * Uji dan kalibrasi mesin verifikasi Level 2 (modul 3.1), dijalankan operator secara lokal:
 *   node dist/scripts/kyc-smoke.js <foto-ktp> <foto-selfie> [nik-diketik] [nama-diketik]
 *
 * Mencetak skor (kemiripan wajah, anti-spoof/liveness, keyakinan OCR) dan keputusan dengan ambang dari env
 * (KYC_FACE_PASS, KYC_FACE_REJECT, KYC_LIVENESS_MIN). NIK hasil OCR dicetak tersamar (4 digit terakhir) dan nama
 * hanya panjangnya. Tidak ada berkas yang ditulis. Pakai hanya foto milik sendiri atau sukarelawan yang setuju.
 */
import { readFile } from 'node:fs/promises';
import { loadEnv } from '../src/config/env.js';
import { decide, DEFAULT_THRESHOLDS, nikDistance } from '../src/kyc/ktp.js';
import { KycEngine } from '../src/kyc/kyc-engine.js';

const [ktpPath, selfiePath, nik, name] = process.argv.slice(2);
if (!ktpPath || !selfiePath) {
  console.error('Pakai: kyc-smoke.js <foto-ktp> <foto-selfie> [nik] [nama]');
  process.exit(2);
}

const env = {
  ...loadEnvLoose(),
  KYC_ENGINE: 'local',
} as ReturnType<typeof loadEnv>;
const engine = new KycEngine(env);
const t0 = Date.now();
try {
  const a = await engine.analyze(await readFile(ktpPath), await readFile(selfiePath));
  const ms = Date.now() - t0;
  console.log(`Waktu: ${ms} ms (termasuk memuat model jika pertama)`);
  console.log(`OCR: NIK ${a.ocr.nik ? `…${a.ocr.nik.slice(-4)}` : 'tidak terbaca'}, nama ${a.ocr.name ? `${a.ocr.name.length} huruf` : 'tidak terbaca'}, keyakinan ${a.ocr.confidence}`);
  console.log(`Wajah: KTP ${a.ktpFaces}, selfie ${a.selfieFaces}, kemiripan ${a.faceSimilarity ?? '-'}`);
  console.log(`Selfie: anti-spoof ${a.selfieReal?.toFixed(2) ?? '-'}, liveness ${a.selfieLive?.toFixed(2) ?? '-'}`);
  if (nik && name) {
    if (a.ocr.nik) console.log(`Selisih digit NIK diketik vs OCR: ${nikDistance(a.ocr.nik, nik)}`);
    const thresholds = { ...DEFAULT_THRESHOLDS, facePass: env.KYC_FACE_PASS, faceReject: env.KYC_FACE_REJECT, livenessMin: env.KYC_LIVENESS_MIN };
    const d = decide({ nik, name }, a, thresholds);
    console.log(`Keputusan: ${d.outcome}${d.reasons.length ? ` (${d.reasons.join(', ')})` : ''}, kemiripan nama ${d.nameScore?.toFixed(2) ?? '-'}`);
  }
} finally {
  engine.onModuleDestroy();
}

/** Hanya variabel KYC_* yang dibutuhkan; variabel lain (database, kunci) tidak wajib untuk skrip ini. */
function loadEnvLoose() {
  const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));
  return {
    KYC_FACE_PASS: num(process.env.KYC_FACE_PASS, DEFAULT_THRESHOLDS.facePass),
    KYC_FACE_REJECT: num(process.env.KYC_FACE_REJECT, DEFAULT_THRESHOLDS.faceReject),
    KYC_LIVENESS_MIN: num(process.env.KYC_LIVENESS_MIN, DEFAULT_THRESHOLDS.livenessMin),
  };
}
