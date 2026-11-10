import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateTotpSecret, totpCode, totpUri, verifyTotp } from './totp.js';

// Vektor uji RFC 6238 (SHA1, kunci "12345678901234567890"), 8 digit dipotong ke 6 digit terakhir.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP', () => {
  it('sesuai vektor uji RFC 6238', () => {
    expect(totpCode(RFC_SECRET, Math.floor(59 / 30))).toBe('287082');
    expect(totpCode(RFC_SECRET, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totpCode(RFC_SECRET, Math.floor(1234567890 / 30))).toBe('005924');
  });

  it('menerima ±1 langkah, menolak yang lebih jauh dan format salah', () => {
    const secret = generateTotpSecret();
    const now = 1_800_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(secret, totpCode(secret, step), now)).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(secret, step - 3), now)).toBeNull();
    expect(verifyTotp(secret, '12345', now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });

  it('base32 bolak-balik dan URI otpauth', () => {
    const buf = Buffer.from([0, 1, 2, 250, 251, 252, 253]);
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
    expect(totpUri('ABC', 'admin')).toBe('otpauth://totp/PaceTara%20Admin%3Aadmin?secret=ABC&issuer=PaceTara%20Admin&algorithm=SHA1&digits=6&period=30');
  });
});
