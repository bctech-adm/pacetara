import { pino } from 'pino';
import { BaileysProvider } from './baileys-provider.js';
import type { OtpProvider } from './provider.js';
import { createOtpServer } from './server.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const secret = process.env.WA_OTP_SHARED_SECRET ?? '';
if (secret.length < 32) {
  log.fatal('WA_OTP_SHARED_SECRET wajib diisi (minimal 32 karakter)');
  process.exit(1);
}

function createProvider(): OtpProvider {
  const name = process.env.WA_PROVIDER ?? 'baileys';
  switch (name) {
    case 'baileys':
      return new BaileysProvider({
        sessionDir: process.env.WA_SESSION_DIR ?? '/data/session',
        pairingNumber: process.env.WA_PAIRING_NUMBER || undefined,
        logger: log,
      });
    // case 'cloud-api': return new CloudApiProvider(...)  — saat pindah ke API resmi
    default:
      throw new Error(`WA_PROVIDER tidak dikenal: ${name}`);
  }
}

const provider = createProvider();
const server = createOtpServer(provider, secret);
const port = Number(process.env.PORT ?? 4000);

server.listen(port, '0.0.0.0', () => log.info(`wa-otp mendengarkan di port ${port} (${provider.name})`));
provider.start().catch((e: unknown) => log.error({ err: e }, 'Provider gagal dimulai; API akan memakai OTP email'));

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    void provider.stop().finally(() => server.close(() => process.exit(0)));
  });
}
