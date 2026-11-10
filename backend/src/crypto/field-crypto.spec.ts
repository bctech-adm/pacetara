import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FieldCrypto, normalizePhoneId } from './field-crypto.js';

const key = () => randomBytes(32).toString('base64');

describe('FieldCrypto', () => {
  const fc = new FieldCrypto(key(), key());

  it('mengenkripsi dan mendekripsi kembali', () => {
    const ct = fc.encrypt('budi@example.com', 'users.email:1');
    expect(ct.includes(Buffer.from('budi'))).toBe(false);
    expect(fc.decryptString(ct, 'users.email:1')).toBe('budi@example.com');
  });

  it('memakai IV acak sehingga ciphertext selalu berbeda', () => {
    expect(fc.encrypt('sama').equals(fc.encrypt('sama'))).toBe(false);
  });

  it('menolak ciphertext yang diubah', () => {
    const ct = fc.encrypt('rahasia');
    ct[ct.length - 1]! ^= 0xff;
    expect(() => fc.decrypt(ct)).toThrow();
  });

  it('menolak ciphertext yang dipindah ke baris lain (AAD berbeda)', () => {
    const ct = fc.encrypt('+6281234567890', 'users.phone:A');
    expect(() => fc.decrypt(ct, 'users.phone:B')).toThrow();
  });

  it('menolak kunci lain', () => {
    const other = new FieldCrypto(key(), key());
    expect(() => other.decrypt(fc.encrypt('x'))).toThrow();
  });

  it('blind index deterministik dan dinormalisasi', () => {
    expect(fc.blindIndex('email', ' Budi@Example.COM ')).toEqual(fc.blindIndex('email', 'budi@example.com'));
    expect(fc.blindIndex('phone', '0812-3456-7890')).toEqual(fc.blindIndex('phone', '+62 812 3456 7890'));
  });

  it('blind index bergantung pada kunci (tidak bisa dihitung ulang tanpa kunci)', () => {
    expect(fc.blindIndex('email', 'a@b.co')).not.toEqual(
      new FieldCrypto(key(), key()).blindIndex('email', 'a@b.co'),
    );
  });

  it('menolak kunci yang sama untuk enkripsi dan index', () => {
    const k = key();
    expect(() => new FieldCrypto(k, k)).toThrow();
  });

  it('NIK harus 16 digit', () => {
    expect(() => fc.blindIndex('nik', '123')).toThrow();
    expect(fc.blindIndex('nik', '3201 0101 0101 0001')).toHaveLength(32);
  });
});

describe('normalizePhoneId', () => {
  it.each([
    ['081234567890', '+6281234567890'],
    ['+62 812-3456-7890', '+6281234567890'],
    ['6281234567890', '+6281234567890'],
    ['81234567890', '+6281234567890'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePhoneId(input)).toBe(expected);
  });

  it('menolak nomor yang bukan Indonesia atau terlalu pendek', () => {
    expect(() => normalizePhoneId('+1 555 1234')).toThrow();
    expect(() => normalizePhoneId('0812')).toThrow();
  });
});
