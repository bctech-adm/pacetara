import { describe, expect, it } from 'vitest';
import { midtransSignatureOk, mapMidtransStatus } from '../payments/midtrans.js';
import { computeFee, outboundUrl, parseAffiliateTemplates, validateAffiliateUrl } from './rules.js';
import { createHash } from 'node:crypto';

describe('komisi split payment', () => {
  it('persen dibulatkan + flat, tidak melebihi total', () => {
    expect(computeFee(100_000, 5, 0)).toBe(5000);
    expect(computeFee(99_999, 5, 0)).toBe(5000);
    expect(computeFee(100_000, 2.5, 1000)).toBe(3500);
    expect(computeFee(1000, 30, 1_000_000)).toBe(1000);
    expect(computeFee(50_000, 0, 0)).toBe(0);
  });
});

describe('tautan afiliasi', () => {
  it('hanya https ke marketplace yang dikenal', () => {
    expect(validateAffiliateUrl('https://www.tokopedia.com/toko/sepatu-lari#ulasan')).toBe('https://www.tokopedia.com/toko/sepatu-lari');
    expect(validateAffiliateUrl('https://shopee.co.id/product/1/2')).toBe('https://shopee.co.id/product/1/2');
    expect(validateAffiliateUrl('http://shopee.co.id/product/1/2')).toBeNull();
    expect(validateAffiliateUrl('https://shopee.co.id.evil.com/x')).toBeNull();
    expect(validateAffiliateUrl('https://evilshopee.co.id/x')).toBeNull();
    expect(validateAffiliateUrl('https://user:pw@shopee.co.id/x')).toBeNull();
    expect(validateAffiliateUrl('https://shopee.co.id:8443/x')).toBeNull();
    expect(validateAffiliateUrl('bukan url')).toBeNull();
  });

  it('template afiliasi diterapkan per host, selain itu tautan asli', () => {
    const t = parseAffiliateTemplates('{"shopee.co.id":"https://aff.example.shopee.co.id/r?u={url}&id=PT"}');
    expect(outboundUrl('https://shopee.co.id/p/1', t)).toBe('https://aff.example.shopee.co.id/r?u=https%3A%2F%2Fshopee.co.id%2Fp%2F1&id=PT');
    expect(outboundUrl('https://www.tokopedia.com/p', t)).toBe('https://www.tokopedia.com/p');
    expect(parseAffiliateTemplates('').size).toBe(0);
    expect(() => parseAffiliateTemplates('{"evil.com":"https://x/{url}"}')).toThrow();
    expect(() => parseAffiliateTemplates('{"shopee.co.id":"http://x/{url}"}')).toThrow();
  });
});

describe('Midtrans', () => {
  const key = 'SB-Mid-server-uji';
  const sig = (o: string, c: string, g: string) => createHash('sha512').update(`${o}${c}${g}${key}`).digest('hex');

  it('signature notifikasi diperiksa', () => {
    const body = { order_id: 'PT-LF-abc', status_code: '200', gross_amount: '15000.00' };
    expect(midtransSignatureOk(key, { ...body, signature_key: sig('PT-LF-abc', '200', '15000.00') })).toBe(true);
    expect(midtransSignatureOk(key, { ...body, signature_key: sig('PT-LF-abc', '200', '1.00') })).toBe(false);
    expect(midtransSignatureOk(key, { ...body })).toBe(false);
    expect(midtransSignatureOk('', { ...body, signature_key: sig('PT-LF-abc', '200', '15000.00') })).toBe(false);
  });

  it('pemetaan status', () => {
    expect(mapMidtransStatus({ transaction_status: 'settlement' })).toBe('paid');
    expect(mapMidtransStatus({ transaction_status: 'capture', fraud_status: 'accept' })).toBe('paid');
    expect(mapMidtransStatus({ transaction_status: 'capture', fraud_status: 'challenge' })).toBe('pending');
    // Gagal-tertutup: capture tanpa fraud_status tidak dianggap lunas.
    expect(mapMidtransStatus({ transaction_status: 'capture' })).toBe('pending');
    expect(mapMidtransStatus({ transaction_status: 'pending' })).toBe('pending');
    expect(mapMidtransStatus({ transaction_status: 'expire' })).toBe('expired');
    expect(mapMidtransStatus({ transaction_status: 'deny' })).toBe('failed');
    expect(mapMidtransStatus({ transaction_status: 'refund' })).toBe('refunded');
    expect(mapMidtransStatus({})).toBe('pending');
  });
});
