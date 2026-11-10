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
