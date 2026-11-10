import sharp, { type Metadata } from 'sharp';
import { ApiError } from '../common/http.js';

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED = new Set(['jpeg', 'png', 'webp', 'heif']);

/**
 * Memproses unggahan gambar:
 * - jenis dicek dari isi berkas (bukan nama/Content-Type kiriman klien),
 * - dimensi dibatasi (mencegah bom dekompresi),
 * - di-encode ulang ke WebP sehingga SEMUA metadata (EXIF, GPS, XMP) terbuang,
 * - orientasi EXIF diterapkan sebelum metadata dibuang.
 */
export async function processImage(input: Buffer, opts: { size: number; square?: boolean }): Promise<Buffer> {
  if (input.length === 0 || input.length > MAX_UPLOAD_BYTES) {
    throw new ApiError(413, 'file_too_large', 'Ukuran gambar maksimal 8 MB');
  }
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: 50_000_000 }).metadata();
  } catch {
    throw new ApiError(415, 'unsupported_image', 'Berkas bukan gambar yang didukung (JPG, PNG, WebP, HEIC)');
  }
  if (!meta.format || !ALLOWED.has(meta.format)) {
    throw new ApiError(415, 'unsupported_image', 'Berkas bukan gambar yang didukung (JPG, PNG, WebP, HEIC)');
  }
  const pipeline = sharp(input, { limitInputPixels: 50_000_000 })
    .rotate()
    .resize(opts.size, opts.size, { fit: opts.square ? 'cover' : 'inside', withoutEnlargement: true });
  // sharp tidak menyalin metadata ke output kecuali diminta dengan withMetadata(); jangan pernah memanggilnya.
  return pipeline.webp({ quality: 82 }).toBuffer();
}
