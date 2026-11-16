/**
 * Worker thread mesin verifikasi Level 2 (modul 3.1): OCR KTP (tesseract.js, bahasa Indonesia) dan pencocokan wajah
 * KTP vs selfie (Human: BlazeFace + FaceRes + anti-spoof + liveness), semuanya WASM di dalam proses API.
 *
 * Privasi:
 * - Gambar hanya ada di memori thread ini. Tidak ada yang ditulis ke disk (tesseract tanpa cache, model dibaca
 *   dari node_modules) dan tidak ada yang di-log. Buffer diisi nol setelah dipakai (upaya terbaik; GC JavaScript
 *   bisa saja sudah menyalinnya).
 * - fetch di thread ini hanya bisa membaca berkas model/WASM lokal; semua URL lain ditolak, jadi gambar tidak
 *   mungkin terkirim ke luar.
 * - Hasil ke thread utama hanya angka + NIK/nama hasil OCR, tanpa gambar.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parentPort } from 'node:worker_threads';
import sharp from 'sharp';
import { type KycAnalysis, parseKtpText } from './ktp.js';

const require = createRequire(import.meta.url);
const HUMAN_DIST = path.dirname(require.resolve('@vladmandic/human'));
const MODELS_DIR = path.resolve(HUMAN_DIST, '..', 'models');
const WASM_DIR = path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm'));
const IND = require('@tesseract.js-data/ind') as { code: string; langPath: string; gzip: boolean };

// fetch hanya untuk berkas lokal di folder model/WASM. Node tidak mendukung file:// di fetch, dan Human/tfjs
// memuat model lewat fetch; sekaligus memastikan thread ini tidak bisa membuat koneksi jaringan.
const ALLOWED_DIRS = [MODELS_DIR, WASM_DIR].map((d) => path.resolve(d) + path.sep);
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('file://')) throw new Error('kyc-thread: jaringan tidak diizinkan');
  const file = path.resolve(fileURLToPath(url));
  if (!ALLOWED_DIRS.some((d) => file.startsWith(d))) throw new Error('kyc-thread: berkas di luar folder model');
  const body = await readFile(file);
  const type = file.endsWith('.json') ? 'application/json' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
  return new Response(body, { status: 200, headers: { 'content-type': type } });
}) as typeof fetch;

interface HumanFace {
  box: [number, number, number, number];
  score: number;
  embedding?: number[];
  real?: number;
  live?: number;
}
interface HumanLike {
  load(): Promise<void>;
  detect(input: unknown): Promise<{ face: HumanFace[] }>;
  tf: { tensor4d(values: Int32Array, shape: [number, number, number, number], dtype: 'int32'): { dispose(): void } };
}
interface TesseractWorker {
  recognize(image: Buffer): Promise<{ data: { text: string; confidence: number } }>;
  setParameters(params: Record<string, string>): Promise<unknown>;
}

/** Mode tata letak Tesseract: 3 = otomatis (blok teks), 11 = teks tersebar (cocok untuk kartu berlabel). */
type Psm = '3' | '11';

/**
 * Varian gambar untuk OCR, dicoba berurutan sampai NIK terbaca. Foto KTP sungguhan sering gagal di satu varian saja:
 * latar guilloche biru, pantulan laminasi, foto dari layar (moiré), atau foto landscape tanpa tag orientasi EXIF.
 * - red: kanal merah lalu ambang biner, mode teks tersebar; latar biru muda KTP jadi putih, tulisan hitam tetap
 *   hitam. Pada KTP sintetis berlatar guilloche: keyakinan 94 dan semua baris bersih, varian abu-abu hanya 60.
 * - red90/red270: varian merah diputar untuk foto KTP yang tersimpan menyamping tanpa tag orientasi EXIF.
 * - gray: abu-abu dinormalkan dan dipertajam, cadangan terakhir untuk foto gelap/kontras rendah yang rusak oleh
 *   ambang (paling lemah, jadi dicoba terakhir agar tidak mendahului varian merah yang diputar).
 */
const OCR_VARIANTS: { name: string; rotate: number; mode: 'gray' | 'red'; psm: Psm }[] = [
  { name: 'red', rotate: 0, mode: 'red', psm: '11' },
  { name: 'red90', rotate: 90, mode: 'red', psm: '11' },
  { name: 'red270', rotate: 270, mode: 'red', psm: '11' },
  { name: 'gray', rotate: 0, mode: 'gray', psm: '3' },
];

async function ocrImage(ktp: Buffer, v: (typeof OCR_VARIANTS)[number]): Promise<Buffer> {
  // rotate() tanpa argumen = ikuti EXIF; lalu putaran tambahan varian.
  let img = sharp(ktp, { limitInputPixels: 50_000_000 }).rotate();
  if (v.rotate) img = sharp(await img.toBuffer()).rotate(v.rotate);
  img = img.resize({ width: 1800, height: 1800, fit: 'inside' });
  if (v.mode === 'gray') return img.grayscale().normalize().sharpen().png().toBuffer();
  return img.extractChannel('red').normalize().sharpen().threshold(150).png().toBuffer();
}

let ready: Promise<{ human: HumanLike; ocr: TesseractWorker }> | null = null;

function init() {
  ready ??= (async () => {
    const { Human } = require(path.join(HUMAN_DIST, 'human.node-wasm.js')) as { Human: new (cfg: unknown) => HumanLike };
    const human = new Human({
      backend: 'wasm',
      wasmPath: pathToFileURL(WASM_DIR).href + '/',
      modelBasePath: pathToFileURL(MODELS_DIR).href + '/',
      debug: false,
      // Gambar diam: tanpa cache antar-"frame" agar hasil KTP tidak terbawa ke selfie.
      cacheSensitivity: 0,
      filter: { enabled: false },
      face: {
        enabled: true,
        detector: { rotation: true, maxDetected: 5, minConfidence: 0.3, skipFrames: 0, skipTime: 0 },
        mesh: { enabled: true },
        iris: { enabled: false },
        description: { enabled: true, skipFrames: 0, skipTime: 0 },
        emotion: { enabled: false },
        antispoof: { enabled: true, skipFrames: 0, skipTime: 0 },
        liveness: { enabled: true, skipFrames: 0, skipTime: 0 },
      },
      body: { enabled: false },
      hand: { enabled: false },
      object: { enabled: false },
      gesture: { enabled: false },
      segmentation: { enabled: false },
    });
    await human.load();
    const { createWorker } = (await import('tesseract.js')) as unknown as {
      createWorker(lang: string, oem: number, opts: Record<string, unknown>): Promise<TesseractWorker>;
    };
    const ocr = await createWorker(IND.code, 1, { langPath: IND.langPath, gzip: IND.gzip, cacheMethod: 'none' });
    return { human, ocr };
  })();
  ready.catch(() => {
    ready = null;
  });
  return ready;
}

/** Piksel mentah sharp (1–4 kanal) → tensor RGB int32 [1, h, w, 3]. */
function toTensor(human: HumanLike, data: Buffer, info: { width: number; height: number; channels: number }) {
  const px = info.width * info.height;
  const out = new Int32Array(px * 3);
  const c = info.channels;
  for (let i = 0; i < px; i++) {
    const r = data[i * c]!;
    out[i * 3] = r;
    out[i * 3 + 1] = c >= 3 ? data[i * c + 1]! : r;
    out[i * 3 + 2] = c >= 3 ? data[i * c + 2]! : r;
  }
  return human.tf.tensor4d(out, [1, info.height, info.width, 3], 'int32');
}

async function faces(human: HumanLike, input: Buffer, maxSide: number, extraRotate = 0) {
  let img = sharp(input, { limitInputPixels: 50_000_000 }).rotate();
  if (extraRotate) img = sharp(await img.toBuffer()).rotate(extraRotate);
  const { data, info } = await img
    .resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const tensor = toTensor(human, data, info);
  try {
    const res = await human.detect(tensor);
    return res.face.filter((f) => f.score >= 0.5).sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3]);
  } finally {
    tensor.dispose();
    data.fill(0);
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Tahap analisis yang sedang berjalan; hanya nama tahap yang dilaporkan saat galat (untuk log, tanpa data). */
let stage = 'idle';

async function analyze(ktp: Buffer, selfie: Buffer): Promise<KycAnalysis> {
  stage = 'init';
  const { human, ocr } = await init();
  stage = 'ocr';
  let parsed: { nik: string | null; name: string | null } = { nik: null, name: null };
  let confidence = 0;
  let psm: Psm | null = null;
  // Putaran tambahan yang membuat NIK terbaca; dipakai juga untuk mendeteksi wajah KTP.
  let ktpRotate = 0;
  for (const v of OCR_VARIANTS) {
    stage = `ocr_${v.name}`;
    if (psm !== v.psm) {
      await ocr.setParameters({ tessedit_pageseg_mode: v.psm });
      psm = v.psm;
    }
    const input = await ocrImage(ktp, v);
    try {
      const { data } = await ocr.recognize(input);
      const p = parseKtpText(data.text);
      // Nama diambil dari varian mana pun yang membacanya; NIK menentukan kapan berhenti.
      parsed = { nik: parsed.nik ?? p.nik, name: parsed.name ?? p.name };
      if (p.nik) {
        confidence = data.confidence;
        ktpRotate = v.rotate;
        break;
      }
      confidence = Math.max(confidence, data.confidence);
    } finally {
      input.fill(0);
    }
  }

  stage = 'face_ktp';
  const ktpFaces = await faces(human, ktp, 1600, ktpRotate);
  stage = 'face_selfie';
  const selfieFaces = await faces(human, selfie, 1024);
  stage = 'done';
  // Wajah lain di latar selfie yang jauh lebih kecil (orang lewat) tidak dihitung.
  const mainSelfie = selfieFaces[0];
  const selfieCount = mainSelfie ? selfieFaces.filter((f) => f.box[2] * f.box[3] >= 0.3 * mainSelfie.box[2] * mainSelfie.box[3]).length : 0;
  const ktpFace = ktpFaces[0];
  const similarity = ktpFace?.embedding && mainSelfie?.embedding ? cosine(ktpFace.embedding, mainSelfie.embedding) : null;
  return {
    ocr: { nik: parsed.nik, name: parsed.name, confidence },
    ktpFaces: ktpFaces.length,
    selfieFaces: selfieCount,
    faceSimilarity: similarity === null ? null : Math.round(similarity * 1000) / 1000,
    selfieReal: mainSelfie?.real ?? null,
    selfieLive: mainSelfie?.live ?? null,
  };
}

parentPort?.on('message', async (msg: { id: number; type: 'warmup' } | { id: number; type: 'analyze'; ktp: ArrayBuffer; selfie: ArrayBuffer }) => {
  if (msg.type === 'warmup') {
    try {
      await init();
      parentPort!.postMessage({ id: msg.id, ok: true });
    } catch {
      parentPort!.postMessage({ id: msg.id, ok: false, error: 'engine_error' });
    }
    return;
  }
  const ktp = Buffer.from(msg.ktp);
  const selfie = Buffer.from(msg.selfie);
  try {
    parentPort!.postMessage({ id: msg.id, ok: true, result: await analyze(ktp, selfie) });
  } catch (err) {
    // Hanya kode galat; pesan pustaka bisa memuat potongan data.
    const unsupported = err instanceof Error && /unsupported image|Input buffer|corrupt|VipsJpeg|heif/i.test(err.message);
    const kind = err instanceof Error ? err.constructor.name : typeof err;
    parentPort!.postMessage({ id: msg.id, ok: false, error: unsupported ? 'unsupported_image' : 'engine_error', stage, kind });
  } finally {
    ktp.fill(0);
    selfie.fill(0);
  }
});
