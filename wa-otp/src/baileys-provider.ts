import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import makeWASocket, {
  Browsers,
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
      // Harus preset platform yang dikenal WhatsApp; nilai bebas membuat kode pairing ditolak di HP.
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    let pairingRequested = false;

    sock.ev.on('connection.update', (u) => {
      // Event `qr` menandakan socket siap dipasangkan; saat itulah kode pairing boleh diminta.
      if (u.qr && !state.creds.registered) {
        if (this.opts.pairingNumber) {
          if (!pairingRequested) {
            pairingRequested = true;
            sock
              .requestPairingCode(this.opts.pairingNumber)
              .then((code) =>
                log.warn(
                  `Kode pairing WhatsApp: ${code} — masukkan dalam ±1 menit di WhatsApp > Perangkat tertaut > Tautkan dengan nomor telepon`,
                ),
              )
              .catch((e: unknown) => log.error({ err: e }, 'Gagal meminta kode pairing'));
          }
        } else {
          log.warn('Pindai QR berikut dari WhatsApp nomor OTP (Perangkat tertaut):');
          qrcode.generate(u.qr, { small: true });
        }
      }
      if (u.connection === 'open') {
        this.ready = true;
        this.retry = 0;
        log.info('WhatsApp terhubung');
      }
      if (u.connection === 'close') {
        this.ready = false;
        if (this.stopped) return;
        const status = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;

        if (status === DisconnectReason.loggedOut) {
          // Sesi ditolak (perangkat dilepas, atau pairing sebelumnya tidak selesai). Mulai sesi baru
          // dengan jeda panjang agar tidak membanjiri WhatsApp dengan permintaan pairing.
          log.error('Sesi WhatsApp ditolak (logged out). Membuat sesi baru; API memakai OTP email sementara.');
          this.scheduleReconnect(30_000, true);
          return;
        }
        if (status === DisconnectReason.restartRequired) {
          // Normal setelah pairing berhasil: sambung ulang segera dengan kredensial baru.
          log.info('Pairing diterima, menyambung ulang...');
          this.scheduleReconnect(500, false);
          return;
        }
        if (!state.creds.registered && !state.creds.me) {
          // Pairing belum selesai dan kodenya kedaluwarsa (biasanya 408). Kredensial setengah jadi
          // akan ditolak, jadi langsung mulai sesi baru dan minta kode baru.
          log.warn('Kode pairing kedaluwarsa, membuat kode baru...');
          this.scheduleReconnect(3_000, true);
          return;
        }
        const delay = Math.min(60_000, 2_000 * 2 ** this.retry++);
        log.warn(`Koneksi WhatsApp terputus (kode ${status ?? '?'}), mencoba lagi dalam ${delay / 1000} dtk`);
        this.scheduleReconnect(delay, false);
      }
    });
  }

  private scheduleReconnect(delayMs: number, resetSession: boolean) {
    const log = this.opts.logger;
    setTimeout(() => {
      void (async () => {
        if (this.stopped) return;
        if (resetSession) await clearDir(this.opts.sessionDir);
        await this.connect();
      })().catch((e: unknown) => log.error({ err: e }, 'Gagal menyambung ulang'));
    }, delayMs);
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

/** Menghapus isi folder sesi (bukan foldernya, karena itu titik mount volume). */
async function clearDir(dir: string) {
  if (!dir || dir === '/' || !dir.startsWith('/')) throw new Error(`Folder sesi tidak aman dihapus: ${dir}`);
  for (const entry of await readdir(dir)) {
    await rm(join(dir, entry), { recursive: true, force: true });
  }
}
