import { Inject, Injectable, Logger } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import nodemailer, { type Transporter } from 'nodemailer';
import { ApiError } from '../common/http.js';
import { ENV, type Env } from '../config/env.js';

export type CodeMailKind = 'email_verify' | 'phone_verify' | 'password_reset';

const SUBJECT: Record<CodeMailKind, string> = {
  email_verify: 'Kode verifikasi email PaceTara',
  phone_verify: 'Kode verifikasi nomor HP PaceTara',
  password_reset: 'Kode atur ulang kata sandi PaceTara',
};

const INTRO: Record<CodeMailKind, string> = {
  email_verify: 'Gunakan kode berikut untuk memverifikasi email kamu di PaceTara.',
  phone_verify: 'Kami tidak bisa mengirim kode lewat WhatsApp, jadi kode verifikasi nomor HP kamu dikirim ke email ini.',
  password_reset: 'Ada permintaan untuk mengatur ulang kata sandi akun PaceTara kamu.',
};

/** Pengirim email. Isi email (termasuk kode) tidak pernah ditulis ke log. */
@Injectable()
export class Mailer {
  private readonly logger = new Logger('Mailer');
  private readonly transport?: Transporter;

  constructor(@Inject(ENV) private readonly env: Env) {
    if (env.SMTP_HOST) {
      this.transport = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        // Produksi: wajib STARTTLS jika bukan koneksi TLS langsung. Lokal (Mailpit) tanpa TLS.
        requireTLS: env.NODE_ENV === 'production' && !env.SMTP_SECURE,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      });
    }
  }

  get enabled(): boolean {
    return Boolean(this.transport);
  }

  async sendCode(to: string, kind: CodeMailKind, code: string, validMinutes: number): Promise<void> {
    if (!this.transport) throw new ApiError(503, 'email_unavailable', 'Pengiriman email belum tersedia');
    const text =
      `${INTRO[kind]}\n\nKode: ${code}\n\nBerlaku ${validMinutes} menit. Jangan berikan kode ini kepada siapa pun, ` +
      'termasuk yang mengaku dari PaceTara.\n\nJika kamu tidak meminta kode ini, abaikan email ini.';
    try {
      await this.transport.sendMail({ from: this.env.MAIL_FROM, to, subject: SUBJECT[kind], text });
    } catch (err) {
      // Hanya kode galat: pesan nodemailer bisa memuat alamat penerima.
      const e = err as { code?: string; responseCode?: number };
      this.logger.error(`Gagal mengirim email (${kind}): ${e.code ?? 'unknown'} ${e.responseCode ?? ''}`.trim());
      throw new ApiError(503, 'email_unavailable', 'Email gagal dikirim. Coba lagi sebentar lagi');
    }
  }
}

/** Klien layanan wa-otp internal. Mengembalikan false untuk setiap kegagalan agar pemanggil beralih ke email. */
@Injectable()
export class WhatsAppOtp {
  private readonly logger = new Logger('WhatsAppOtp');

  constructor(@Inject(ENV) private readonly env: Env) {}

  async send(phoneE164: string, code: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.env.WA_OTP_URL}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shared-secret': this.env.WA_OTP_SHARED_SECRET },
        body: JSON.stringify({ phone: phoneE164, code }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 204) return true;
      this.logger.warn(`wa-otp menjawab ${res.status}; beralih ke email`);
      return false;
    } catch (err) {
      this.logger.warn(`wa-otp tidak terjangkau (${err instanceof Error ? err.name : 'unknown'}); beralih ke email`);
      return false;
    }
  }

  /**
   * Pesan SOS mode aman (modul 1.10). Teks disusun layanan wa-otp; di sini hanya data terstruktur.
   * false = gagal (aplikasi menawarkan SMS dari HP). Lokasi, nama, dan nomor tidak pernah di-log.
   */
  async sendSos(phoneE164: string, sos: { name: string; lat: number; lng: number; accuracyM?: number; at: Date }): Promise<boolean> {
    try {
      const res = await fetch(`${this.env.WA_OTP_URL}/sos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shared-secret': this.env.WA_OTP_SHARED_SECRET },
        body: JSON.stringify({ phone: phoneE164, name: sos.name.slice(0, 60), lat: sos.lat, lng: sos.lng, accuracyM: sos.accuracyM, at: sos.at.toISOString() }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 204) return true;
      this.logger.warn(`wa-otp menjawab ${res.status} untuk SOS`);
      return false;
    } catch (err) {
      this.logger.warn(`wa-otp tidak terjangkau untuk SOS (${err instanceof Error ? err.name : 'unknown'})`);
      return false;
    }
  }
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

/** Memverifikasi ID token Google (tanda tangan, `aud`, `iss`, kedaluwarsa) di server. */
@Injectable()
export class GoogleVerifier {
  private readonly client = new OAuth2Client();
  private readonly audiences: string[];

  constructor(@Inject(ENV) env: Env) {
    this.audiences = env.GOOGLE_CLIENT_IDS.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  get enabled(): boolean {
    return this.audiences.length > 0;
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    if (!this.enabled) throw new ApiError(503, 'google_unavailable', 'Login Google belum tersedia');
    try {
      const ticket = await this.client.verifyIdToken({ idToken, audience: this.audiences });
      const p = ticket.getPayload();
      if (!p?.sub || !p.email) throw new Error('payload tidak lengkap');
      return { sub: p.sub, email: p.email, emailVerified: p.email_verified === true, name: p.name };
    } catch {
      throw new ApiError(401, 'invalid_google_token', 'Login Google gagal, coba lagi');
    }
  }
}
