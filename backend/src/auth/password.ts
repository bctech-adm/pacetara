import { Algorithm, hash, verify } from '@node-rs/argon2';

// Parameter Argon2id sesuai rekomendasi OWASP (m=19 MiB, t=2, p=1).
const OPTIONS = { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  try {
    return await verify(hashed, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Dipanggil saat email tidak ditemukan agar waktu respons login sama dengan email yang ada
 * (mencegah enumerasi akun lewat perbedaan waktu).
 */
export async function burnPasswordCheck(password: string): Promise<false> {
  dummyHash ??= hashPassword('pacetara-dummy-password');
  await verifyPassword(await dummyHash, password);
  return false;
}
