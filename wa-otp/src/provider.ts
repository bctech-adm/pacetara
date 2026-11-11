/**
 * Antarmuka pengirim OTP WhatsApp. Baileys dipakai sekarang; untuk pindah ke WhatsApp Cloud API
 * resmi cukup menulis implementasi baru dan memilihnya lewat WA_PROVIDER, tanpa mengubah API.
 */
export interface OtpProvider {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  isReady(): boolean;
  /** @param phoneE164 nomor format +62…  @throws NotOnWhatsAppError | ProviderUnavailableError */
  sendOtp(phoneE164: string, code: string): Promise<void>;
  /** Pesan SOS mode aman (modul 1.10). Teks disusun di layanan ini (`sosMessage`), bukan dari pemanggil. */
  sendSos(phoneE164: string, sos: SosAlert): Promise<void>;
}

export interface SosAlert {
  /** Nama tampilan pengguna yang menekan SOS. */
  name: string;
  lat: number;
  lng: number;
  accuracyM?: number;
  /** Waktu SOS (ISO 8601). */
  at: string;
}

export class NotOnWhatsAppError extends Error {
  constructor() {
    super('Nomor tidak terdaftar di WhatsApp');
  }
}

export class ProviderUnavailableError extends Error {
  constructor(reason = 'Pengirim WhatsApp belum terhubung') {
    super(reason);
  }
}

export function otpMessage(code: string): string {
  return (
    `Kode verifikasi PaceTara kamu: *${code}*\n\n` +
    'Berlaku 5 menit. Jangan berikan kode ini kepada siapa pun, termasuk yang mengaku dari PaceTara.'
  );
}

/** Untuk log: +62812****7890. Nomor lengkap tidak pernah ditulis ke log. */
export function maskPhone(phone: string): string {
  return phone.length > 8 ? `${phone.slice(0, 5)}****${phone.slice(-4)}` : '****';
}

/** Karakter format WhatsApp dan baris baru dibuang dari nama agar pesan tidak bisa dibentuk ulang. */
function plainName(name: string): string {
  const clean = name.replace(/[*_~`\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return clean || 'Pengguna PaceTara';
}

/** Teks SOS. Lokasi sebagai tautan Google Maps; jam dalam WIB. */
export function sosMessage(sos: SosAlert): string {
  const name = plainName(sos.name);
  const at = new Date(sos.at);
  const wib = new Date(at.getTime() + 7 * 3_600_000);
  const hhmm = `${String(wib.getUTCHours()).padStart(2, '0')}:${String(wib.getUTCMinutes()).padStart(2, '0')}`;
  const acc = sos.accuracyM !== undefined ? `akurasi ±${Math.round(sos.accuracyM)} m, ` : '';
  return (
    `🚨 *SOS dari ${name}* (PaceTara)\n\n` +
    `${name} menekan tombol darurat saat berlari dan memilihmu sebagai kontak darurat.\n\n` +
    `Lokasi terakhir (${acc}pukul ${hhmm} WIB):\n` +
    `https://maps.google.com/?q=${sos.lat.toFixed(6)},${sos.lng.toFixed(6)}\n\n` +
    `Segera hubungi ${name}. Jika tidak bisa dihubungi, minta bantuan ke 112.`
  );
}
