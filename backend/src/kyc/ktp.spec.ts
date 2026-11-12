import { describe, expect, it } from 'vitest';
import { ageFromNik, decide, DEFAULT_THRESHOLDS, type KycAnalysis, nameSimilarity, nikDistance, parseKtpText, parseNik } from './ktp.js';

const NOW = new Date('2026-11-12T00:00:00Z');
// NIK contoh karangan: Jakarta Selatan (3174), kecamatan 01, lahir 12-05-1990, urut 0001.
const NIK = '3174011205900001';

describe('parseNik', () => {
  it('menerima NIK dengan struktur benar dan membaca tanggal lahir', () => {
    expect(parseNik(NIK, NOW)).toEqual({ birthYear: 1990, birthMonth: 5, birthDay: 12 });
  });

  it('perempuan: hari + 40', () => {
    expect(parseNik('3174015205900001', NOW)).toEqual({ birthYear: 1990, birthMonth: 5, birthDay: 12 });
  });

  it('abad dipilih agar tahun lahir tidak di masa depan', () => {
    expect(parseNik('3174011205080001', NOW)?.birthYear).toBe(2008);
    expect(parseNik('3174011205300001', NOW)?.birthYear).toBe(1930);
  });

  it.each([
    ['bukan 16 digit', '317401120590001'],
    ['huruf', '31740112059000A1'],
    ['provinsi tidak dikenal', '9974011205900001'],
    ['kabupaten 00', '3100011205900001'],
    ['kecamatan 00', '3174001205900001'],
    ['bulan 13', '3174011213900001'],
    ['hari 0', '3174010005900001'],
    ['31 Februari', '3174013102900001'],
    ['nomor urut 0000', '3174011205900000'],
  ])('menolak: %s', (_label, nik) => {
    expect(parseNik(nik, NOW)).toBeNull();
  });

  it('umur dari NIK', () => {
    expect(ageFromNik(parseNik(NIK, NOW)!, NOW)).toBe(36);
    expect(ageFromNik(parseNik('3174011311090001', NOW)!, NOW)).toBe(16); // ulang tahun ke-17 besok
    expect(ageFromNik(parseNik('3174011211090001', NOW)!, NOW)).toBe(17);
  });
});

describe('parseKtpText', () => {
  it('membaca NIK dan nama dari tata letak KTP', () => {
    const text = `PROVINSI DKI JAKARTA\nJAKARTA SELATAN\nNIK : ${NIK}\nNama : BUDI SANTOSO\nTempat/Tgl Lahir : JAKARTA, 12-05-1990`;
    expect(parseKtpText(text)).toEqual({ nik: NIK, name: 'BUDI SANTOSO' });
  });

  it('memperbaiki huruf yang mirip angka di baris NIK', () => {
    const text = 'NlK : 3I74O112O59OOOOl\nNama: SITI   AMINAH';
    expect(parseKtpText(text)).toEqual({ nik: '3174011205900001', name: 'SITI AMINAH' });
  });

  it('NIK bersepasi dan nama di baris berikutnya', () => {
    const text = 'NIK  3174 0112 0590 0001\nNama :\nRATNA DEWI\nTempat';
    expect(parseKtpText(text)).toEqual({ nik: NIK, name: 'RATNA DEWI' });
  });

  it('membuang derau OCR dari area foto di baris nama', () => {
    expect(parseKtpText(`NIK : ${NIK}\nNama : BUDI SANTOSO ae!\nTempat`).name).toBe('BUDI SANTOSO');
    expect(parseKtpText(`NIK : ${NIK}\nNama : M. RIZKY O'NEIL 5 NY Vu`).name).toBe("M. RIZKY O'NEIL");
  });

  it('cadangan: deret 16 angka tanpa label', () => {
    expect(parseKtpText(`PROVINSI JAWA BARAT\n${NIK}\nNama : A`).nik).toBe(NIK);
  });

  it('tanpa NIK dan nama', () => {
    expect(parseKtpText('foto buram\ntidak ada apa-apa')).toEqual({ nik: null, name: null });
  });
});

describe('nameSimilarity', () => {
  it('sama persis tanpa beda huruf besar dan tanda baca', () => {
    expect(nameSimilarity('Budi Santoso', 'BUDI SANTOSO')).toBe(1);
    expect(nameSimilarity("M. Rizky O'Neil", 'M RIZKY O NEIL')).toBe(1);
  });

  it('urutan kata berbeda', () => {
    expect(nameSimilarity('Santoso Budi', 'BUDI SANTOSO')).toBe(1);
  });

  it('satu huruf salah baca OCR masih tinggi; nama lain rendah', () => {
    expect(nameSimilarity('MUHAMAD RIZKI', 'MUHAMMAD RIZKI')).toBeGreaterThan(0.9);
    expect(nameSimilarity('ANI LESTARI', 'BUDI SANTOSO')).toBeLessThan(0.5);
  });

  it('kosong = 0', () => {
    expect(nameSimilarity('', 'BUDI')).toBe(0);
  });
});

describe('nikDistance', () => {
  it('menghitung posisi berbeda', () => {
    expect(nikDistance(NIK, NIK)).toBe(0);
    expect(nikDistance(NIK, '3174011205900002')).toBe(1);
    expect(nikDistance(NIK, '317401120590000')).toBe(16);
  });
});

describe('decide', () => {
  const good: KycAnalysis = {
    ocr: { nik: NIK, name: 'BUDI SANTOSO', confidence: 85 },
    ktpFaces: 1,
    selfieFaces: 1,
    faceSimilarity: 0.7,
    selfieReal: 0.9,
    selfieLive: 0.95,
  };
  const entered = { nik: NIK, name: 'Budi Santoso' };

  it('semua syarat terpenuhi = lolos otomatis', () => {
    expect(decide(entered, good)).toMatchObject({ outcome: 'approved', reasons: [] });
  });

  it('satu digit NIK salah baca OCR tetap lolos', () => {
    expect(decide(entered, { ...good, ocr: { ...good.ocr, nik: '3174011205900007' } }).outcome).toBe('approved');
  });

  it('masalah kualitas foto = ulangi, tidak masuk antrean', () => {
    expect(decide(entered, { ...good, selfieFaces: 0 })).toMatchObject({ outcome: 'retry', reasons: ['selfie_no_face'] });
    expect(decide(entered, { ...good, selfieFaces: 2 })).toMatchObject({ outcome: 'retry', reasons: ['selfie_multiple_faces'] });
    expect(decide(entered, { ...good, ktpFaces: 0, faceSimilarity: null })).toMatchObject({ outcome: 'retry', reasons: ['ktp_no_face'] });
    expect(decide(entered, { ...good, ocr: { ...good.ocr, nik: null } })).toMatchObject({ outcome: 'retry', reasons: ['ktp_unreadable'] });
  });

  it('NIK diketik berbeda dari foto = ulangi', () => {
    expect(decide({ ...entered, nik: '3174011205900099' }, good)).toMatchObject({ outcome: 'retry', reasons: ['nik_mismatch'] });
  });

  it('nama berbeda, wajah ragu, liveness rendah, OCR kurang yakin = tinjauan manual', () => {
    expect(decide({ ...entered, name: 'Ani Lestari' }, good)).toMatchObject({ outcome: 'review', reasons: ['name_mismatch'] });
    expect(decide(entered, { ...good, faceSimilarity: 0.55 })).toMatchObject({ outcome: 'review', reasons: ['face_uncertain'] });
    expect(decide(entered, { ...good, faceSimilarity: 0.3 })).toMatchObject({ outcome: 'review', reasons: ['face_mismatch'] });
    expect(decide(entered, { ...good, selfieLive: 0.1 })).toMatchObject({ outcome: 'review', reasons: ['liveness_low'] });
    expect(decide(entered, { ...good, ocr: { ...good.ocr, confidence: 30 } })).toMatchObject({ outcome: 'review', reasons: ['ocr_low_confidence'] });
  });

  it('ambang bisa diatur', () => {
    expect(decide(entered, { ...good, faceSimilarity: 0.55 }, { ...DEFAULT_THRESHOLDS, facePass: 0.5 }).outcome).toBe('approved');
  });
});
