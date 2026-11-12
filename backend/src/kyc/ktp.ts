/**
 * Fungsi murni verifikasi Level 2 (modul 3.1): validasi struktur NIK, membaca NIK + nama dari teks OCR KTP,
 * kemiripan nama, dan aturan keputusan. Tidak ada I/O di sini agar mudah diuji dan tidak ada data yang di-log.
 */

/** Kode provinsi dua digit pertama NIK (termasuk provinsi Papua hasil pemekaran 2022). */
const PROVINCES = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 31, 32, 33, 34, 35, 36, 51, 52, 53, 61, 62, 63, 64, 65, 71, 72, 73, 74, 75, 76, 81, 82, 91, 92, 93,
  94, 95, 96, 97,
]);

export interface NikInfo {
  /** Tahun lahir empat digit (perkiraan abad dari umur yang masuk akal). */
  birthYear: number;
  birthMonth: number;
  birthDay: number;
}

/**
 * Memeriksa struktur NIK 16 digit: kode wilayah (provinsi dikenal, kabupaten/kota dan kecamatan bukan 00), tanggal
 * lahir (perempuan: hari + 40), dan nomor urut bukan 0000. Mengembalikan null jika tidak valid. Ini bukan pengecekan
 * ke Dukcapil; hanya menyaring salah ketik dan angka karangan yang jelas.
 */
export function parseNik(nik: string, now = new Date()): NikInfo | null {
  if (!/^\d{16}$/.test(nik)) return null;
  const n = (from: number, len: number) => Number(nik.slice(from, from + len));
  if (!PROVINCES.has(n(0, 2)) || n(2, 2) === 0 || n(4, 2) === 0) return null;
  let day = n(6, 2);
  if (day > 40) day -= 40;
  const month = n(8, 2);
  const yy = n(10, 2);
  if (n(12, 4) === 0 || month < 1 || month > 12 || day < 1) return null;
  const currentYear = now.getUTCFullYear();
  const birthYear = 2000 + yy > currentYear ? 1900 + yy : 2000 + yy;
  const daysInMonth = new Date(Date.UTC(birthYear, month, 0)).getUTCDate();
  if (day > daysInMonth) return null;
  return { birthYear, birthMonth: month, birthDay: day };
}

/** Umur (tahun penuh) dari tanggal lahir di NIK. */
export function ageFromNik(info: NikInfo, now = new Date()): number {
  let age = now.getUTCFullYear() - info.birthYear;
  const m = now.getUTCMonth() + 1;
  if (m < info.birthMonth || (m === info.birthMonth && now.getUTCDate() < info.birthDay)) age -= 1;
  return age;
}

/** Huruf yang sering tertukar dengan angka oleh OCR pada baris NIK. */
const DIGIT_LOOKALIKE: Record<string, string> = {
  O: '0', o: '0', D: '0', Q: '0', U: '0',
  I: '1', l: '1', i: '1', '|': '1', '!': '1', L: '1', J: '1',
  Z: '2', z: '2',
  E: '3',
  A: '4', h: '4',
  S: '5', s: '5',
  G: '6', b: '6',
  T: '7', '?': '7',
  B: '8',
  g: '9', q: '9',
};

function toDigits(s: string): string {
  return [...s].map((c) => (/\d/.test(c) ? c : (DIGIT_LOOKALIKE[c] ?? ''))).join('');
}

/** Rapikan nama: huruf besar, hanya huruf/spasi/titik/koma/apostrof/tanda hubung, spasi tunggal. */
export function cleanName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z .,'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Membaca NIK dan nama dari teks OCR KTP. NIK dicari di baris berlabel "NIK" (dengan perbaikan huruf mirip angka),
 * lalu di seluruh teks sebagai deret 16 angka. Nama dari baris berlabel "Nama" (atau baris sesudahnya jika kosong).
 */
export function parseKtpText(text: string): { nik: string | null; name: string | null } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let nik: string | null = null;
  for (const line of lines) {
    const m = /\bN\s*[I1l|]\s*K\b\s*[:;.]?\s*(.*)$/i.exec(line);
    if (!m) continue;
    const digits = toDigits(m[1]!.replace(/\s+/g, ''));
    const run = /\d{16}/.exec(digits);
    if (run) {
      nik = run[0];
      break;
    }
  }
  if (!nik) {
    for (const token of text.split(/\s+/)) {
      const digits = toDigits(token);
      // Token panjang yang sebagian besar angka (bukan kata biasa yang kebetulan dipetakan ke angka).
      if (digits.length === 16 && (token.match(/\d/g)?.length ?? 0) >= 12) {
        nik = digits;
        break;
      }
    }
  }

  let name: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*N\s*a\s*m\s*a\b\s*[:;.]?\s*(.*)$/i.exec(lines[i]!);
    if (!m) continue;
    let candidate = upperPrefix(m[1]!.replace(/^[:;.\s]+/, ''));
    if (candidate.length < 2 && lines[i + 1]) candidate = upperPrefix(lines[i + 1]!);
    if (candidate.length >= 2) name = candidate;
    break;
  }
  return { nik, name };
}

/**
 * Nama di KTP selalu huruf kapital. Derau OCR dari area foto/hologram di baris yang sama biasanya berhuruf kecil
 * atau bertanda baca aneh ("BUDI SANTOSO ae!"), jadi yang diambil hanya token kapital berurutan dari awal.
 */
function upperPrefix(raw: string): string {
  const kept: string[] = [];
  for (const token of raw.trim().split(/\s+/)) {
    if (!/^[A-Z][A-Z.,'-]*$/.test(token)) break;
    kept.push(token);
  }
  return cleanName(kept.join(' '));
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

const ratio = (a: string, b: string) => (a.length || b.length ? 1 - levenshtein(a, b) / Math.max(a.length, b.length) : 1);

/**
 * Kemiripan dua nama 0..1: tanpa tanda baca, huruf besar; nilai terbaik dari urutan asli dan urutan kata disortir
 * (KTP kadang menulis urutan berbeda dari yang diketik pengguna).
 */
export function nameSimilarity(a: string, b: string): number {
  const norm = (s: string) => cleanName(s).replace(/[.,'-]/g, ' ').replace(/\s+/g, ' ').trim();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  const sorted = (s: string) => s.split(' ').sort().join(' ');
  return Math.max(ratio(x, y), ratio(sorted(x), sorted(y)));
}

/** Jumlah posisi berbeda antara dua NIK 16 digit. */
export function nikDistance(a: string, b: string): number {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/** Hasil analisis mesin (OCR + wajah). Tidak berisi gambar. */
export interface KycAnalysis {
  ocr: { nik: string | null; name: string | null; confidence: number };
  /** Jumlah wajah terdeteksi di foto KTP dan selfie. */
  ktpFaces: number;
  selfieFaces: number;
  /** Kemiripan kosinus embedding wajah KTP vs selfie (null jika salah satu tanpa wajah). */
  faceSimilarity: number | null;
  /** Skor model anti-spoof dan liveness pada selfie, 0..1. */
  selfieReal: number | null;
  selfieLive: number | null;
}

export interface KycThresholds {
  /** Kemiripan wajah minimum untuk lolos otomatis. */
  facePass: number;
  /** Di bawah ini wajah dianggap berbeda (tetap ke tinjauan manual, bukan langsung lolos/ulang). */
  faceReject: number;
  /** Skor anti-spoof dan liveness minimum pada selfie untuk lolos otomatis. */
  livenessMin: number;
  /** Kemiripan nama minimum. */
  nameMin: number;
  /** Keyakinan OCR minimum (0..100) untuk lolos otomatis. */
  ocrMin: number;
}

export const DEFAULT_THRESHOLDS: KycThresholds = { facePass: 0.6, faceReject: 0.45, livenessMin: 0.5, nameMin: 0.85, ocrMin: 55 };

/** Alasan "ulangi": masalah kualitas foto atau salah ketik; tidak masuk antrean, pengguna mengunggah ulang. */
export type RetryReason = 'selfie_no_face' | 'selfie_multiple_faces' | 'ktp_no_face' | 'ktp_unreadable' | 'nik_mismatch';
/** Alasan tinjauan manual: verifikasi otomatis tidak yakin. */
export type ReviewReason = 'name_mismatch' | 'face_uncertain' | 'face_mismatch' | 'liveness_low' | 'ocr_low_confidence';

export type KycDecision =
  | { outcome: 'approved'; reasons: []; nameScore: number }
  | { outcome: 'review'; reasons: ReviewReason[]; nameScore: number }
  | { outcome: 'retry'; reasons: RetryReason[]; nameScore: number | null };

/**
 * Aturan keputusan. Masalah kualitas foto dan NIK yang tidak cocok = ulangi (pengguna memperbaiki sendiri).
 * Selebihnya: semua syarat terpenuhi = lolos otomatis; ada yang meragukan = antrean tinjauan manual (PRD 3.1).
 */
export function decide(entered: { nik: string; name: string }, a: KycAnalysis, t: KycThresholds = DEFAULT_THRESHOLDS): KycDecision {
  const retry: RetryReason[] = [];
  if (a.selfieFaces === 0) retry.push('selfie_no_face');
  if (a.selfieFaces > 1) retry.push('selfie_multiple_faces');
  if (a.ktpFaces === 0) retry.push('ktp_no_face');
  if (!a.ocr.nik) retry.push('ktp_unreadable');
  else if (nikDistance(a.ocr.nik, entered.nik) > 1) retry.push('nik_mismatch');
  const nameScore = a.ocr.name ? nameSimilarity(a.ocr.name, entered.name) : 0;
  if (retry.length) return { outcome: 'retry', reasons: retry, nameScore: a.ocr.name ? nameScore : null };

  const review: ReviewReason[] = [];
  if (nameScore < t.nameMin) review.push('name_mismatch');
  const sim = a.faceSimilarity ?? 0;
  if (sim < t.faceReject) review.push('face_mismatch');
  else if (sim < t.facePass) review.push('face_uncertain');
  if ((a.selfieReal ?? 0) < t.livenessMin || (a.selfieLive ?? 0) < t.livenessMin) review.push('liveness_low');
  if (a.ocr.confidence < t.ocrMin) review.push('ocr_low_confidence');
  if (review.length) return { outcome: 'review', reasons: review, nameScore };
  return { outcome: 'approved', reasons: [], nameScore };
}

/** Pesan untuk pengguna per alasan (aplikasi juga punya terjemahannya sendiri). */
export const REASON_TEXT: Record<RetryReason | ReviewReason | 'nik_in_use' | 'underage', string> = {
  selfie_no_face: 'Wajah tidak terlihat di selfie. Ambil ulang dengan wajah menghadap kamera dan cahaya cukup.',
  selfie_multiple_faces: 'Ada lebih dari satu wajah di selfie. Pastikan hanya kamu yang terlihat.',
  ktp_no_face: 'Foto wajah di KTP tidak terbaca. Foto ulang KTP dari dekat, tanpa pantulan cahaya.',
  ktp_unreadable: 'NIK di foto KTP tidak terbaca. Foto ulang KTP utuh, tegak, dan fokus.',
  nik_mismatch: 'NIK yang kamu ketik tidak sama dengan NIK di foto KTP. Periksa lagi ketikanmu.',
  name_mismatch: 'Nama yang kamu ketik berbeda dengan nama di KTP.',
  face_uncertain: 'Kemiripan wajah selfie dan foto KTP belum meyakinkan.',
  face_mismatch: 'Wajah selfie tidak cocok dengan foto KTP.',
  liveness_low: 'Selfie terlihat seperti foto dari layar atau cetakan.',
  ocr_low_confidence: 'Tulisan di foto KTP kurang jelas.',
  nik_in_use: 'NIK ini sudah dipakai akun lain. Hubungi tim PaceTara jika ini keliru.',
  underage: 'Verifikasi Level 2 hanya untuk pemilik KTP berusia 17 tahun ke atas.',
};
