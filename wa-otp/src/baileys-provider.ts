import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
} from 'baileys';
import type { Logger } from 'pino';
import qrcode from 'qrcode-terminal';
import {
  maskPhone,
  NotOnWhatsAppError,
  type OtpProvider,
  otpMessage,
  ProviderUnavailableError,
} from './provider.js';

export interface BaileysOptions {
  sessionDir: string;
  /** Jika diisi (format 62…), pakai kode pairing alih-alih QR saat sesi belum ada. */
  pairingNumber?: string;
  logger: Logger;
}

export class BaileysProvider implements OtpProvider {
  readonly name = 'baileys';
  private sock?: WASocket;
  private ready = false;
  private stopped = false;
  private retry = 0;

  constructor(private readonly opts: BaileysOptions) {}

  isReady() {
    return this.ready;
  }

  async start() {
    this.stopped = false;
    await this.connect();
  }

  async stop() {
    this.stopped = true;
    this.ready = false;
    this.sock?.end(undefined);
  }

  private async connect() {
    const { state, saveCreds } = await useMultiFileAuthState(this.opts.sessionDir);
    const { version } = await fetchLatestBaileysVersion();
    const log = this.opts.logger;

    const sock = makeWASocket({
      version,
      auth: state,
      logger: log.child({ module: 'baileys' }, { level: 'warn' }) as never,
      browser: ['PaceTara OTP', 'Chrome', '1.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    if (this.opts.pairingNumber && !state.creds.registered) {
      // Beri waktu socket membuka koneksi sebelum meminta kode pairing.
      setTimeout(() => {
        sock
          .requestPairingCode(this.opts.pairingNumber!)
          .then((code) => log.warn(`Kode pairing WhatsApp: ${code} (WhatsApp > Perangkat tertaut > Tautkan dengan nomor)`))
          .catch((e: unknown) => log.error({ err: e }, 'Gagal meminta kode pairing'));
      }, 3000);
    }

    sock.ev.on('connection.update', (u) => {
      if (u.qr && !this.opts.pairingNumber) {
        log.warn('Pindai QR berikut dari WhatsApp nomor OTP (Perangkat tertaut):');
        qrcode.generate(u.qr, { small: true });
      }
      if (u.connection === 'open') {
        this.ready = true;
        this.retry = 0;
        log.info('WhatsApp terhubung');
      }
      if (u.connection === 'close') {
        this.ready = false;
        const status = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (status === DisconnectReason.loggedOut) {
          log.error('Sesi WhatsApp keluar (logged out). Hapus volume sesi lalu pindai ulang. API akan memakai OTP email.');
          return;
        }
        if (this.stopped) return;
        const delay = Math.min(60_000, 2_000 * 2 ** this.retry++);
        log.warn(`Koneksi WhatsApp terputus (kode ${status ?? '?'}), mencoba lagi dalam ${delay / 1000} dtk`);
        setTimeout(() => void this.connect().catch((e: unknown) => log.error({ err: e }, 'Gagal menyambung ulang')), delay);
      }
    });
  }

  async sendOtp(phoneE164: string, code: string) {
    if (!this.sock || !this.ready) throw new ProviderUnavailableError();
    const digits = phoneE164.replace(/^\+/, '');
    const [result] = (await this.sock.onWhatsApp(digits)) ?? [];
    if (!result?.exists) throw new NotOnWhatsAppError();
    await this.sock.sendMessage(result.jid, { text: otpMessage(code) });
    this.opts.logger.info(`OTP terkirim ke ${maskPhone(phoneE164)}`);
  }
}
