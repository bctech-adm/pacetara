import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

/** Konteks blind index. Konteks berbeda menghasilkan index berbeda untuk nilai yang sama. */
/** garmin_user / strava_athlete: id pengguna di penyedia impor (modul 2.3), untuk mencocokkan webhook. */
export type BlindIndexContext = 'email' | 'phone' | 'nik' | 'garmin_user' | 'strava_athlete';

/**
 * Enkripsi kolom sensitif di level aplikasi (AES-256-GCM) dan blind index (HMAC-SHA256)
 * untuk kolom yang perlu dicari. Format ciphertext: [versi(1) | iv(12) | tag(16) | data].
 */
export class FieldCrypto {
  private readonly encKey: Buffer;
  private readonly indexKey: Buffer;

  constructor(encryptionKeyB64: string, blindIndexKeyB64: string) {
    this.encKey = Buffer.from(encryptionKeyB64, 'base64');
    this.indexKey = Buffer.from(blindIndexKeyB64, 'base64');
    if (this.encKey.length !== 32 || this.indexKey.length !== 32) {
      throw new Error('Kunci enkripsi dan blind index harus 32 byte');
    }
    if (this.encKey.equals(this.indexKey)) {
      throw new Error('Kunci enkripsi dan blind index harus berbeda');
    }
  }

  /**
   * @param aad data terkait (mis. `users.email:<userId>`) agar ciphertext tidak bisa
   *            dipindah ke baris atau kolom lain tanpa terdeteksi.
   */
  encrypt(plaintext: string | Buffer, aad?: string): Buffer {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
    const data = Buffer.concat([
      cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext),
      cipher.final(),
    ]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), data]);
  }

  decrypt(payload: Buffer, aad?: string): Buffer {
    if (payload.length < 1 + IV_LEN + TAG_LEN || payload[0] !== VERSION) {
      throw new Error('Ciphertext tidak dikenali');
    }
    const iv = payload.subarray(1, 1 + IV_LEN);
    const tag = payload.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
    const data = payload.subarray(1 + IV_LEN + TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, iv);
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }

  decryptString(payload: Buffer, aad?: string): string {
    return this.decrypt(payload, aad).toString('utf8');
  }

  /** HMAC berkunci atas nilai yang sudah dinormalisasi. Deterministik, untuk kolom UNIQUE dan pencarian. */
  blindIndex(context: BlindIndexContext, value: string): Buffer {
    const normalized = normalizers[context](value);
    return createHmac('sha256', this.indexKey).update(`${context}:${normalized}`, 'utf8').digest();
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Normalisasi nomor HP Indonesia ke E.164 (+62…). Melempar galat jika formatnya tidak masuk akal. */
export function normalizePhoneId(phone: string): string {
  let digits = phone.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('0')) digits = `62${digits.slice(1)}`;
  else if (digits.startsWith('8')) digits = `62${digits}`;
  if (!/^62\d{8,13}$/.test(digits)) throw new Error('Nomor HP tidak valid');
  return `+${digits}`;
}

export function normalizeNik(nik: string): string {
  const digits = nik.replace(/\D/g, '');
  if (digits.length !== 16) throw new Error('NIK harus 16 digit');
  return digits;
}

const normalizers: Record<BlindIndexContext, (v: string) => string> = {
  email: normalizeEmail,
  phone: normalizePhoneId,
  nik: normalizeNik,
  garmin_user: (v) => v.trim(),
  strava_athlete: (v) => v.trim(),
};
