import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { NotOnWhatsAppError, type OtpProvider, ProviderUnavailableError, type SosAlert } from './provider.js';

const MAX_BODY = 1024;
const PHONE_RE = /^\+62\d{8,13}$/;
const CODE_RE = /^\d{4,8}$/;

/**
 * HTTP internal (tidak dipublikasikan ke internet). Hanya API yang memanggilnya.
 *   GET  /health  → { ready }
 *   POST /send    { phone, code }  dengan header X-Shared-Secret
 *   POST /sos     { phone, name, lat, lng, accuracyM?, at }  (modul 1.10, teks disusun di sini)
 *     204 terkirim · 401 rahasia salah · 400 input · 422 bukan nomor WhatsApp · 503 belum terhubung
 * API wajib beralih ke OTP email (OTP) atau SMS dari HP (SOS) untuk setiap respons selain 204.
 */
export function createOtpServer(provider: OtpProvider, sharedSecret: string): Server {
  const secret = Buffer.from(sharedSecret, 'utf8');

  return createServer((req, res) => {
    void handle(req, res).catch(() => send(res, 500, { error: 'internal' }));
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { provider: provider.name, ready: provider.isReady() });
    }
    if (req.method !== 'POST' || (req.url !== '/send' && req.url !== '/sos')) return send(res, 404, { error: 'not_found' });

    const given = Buffer.from(String(req.headers['x-shared-secret'] ?? ''), 'utf8');
    if (given.length !== secret.length || !timingSafeEqual(given, secret)) {
      return send(res, 401, { error: 'unauthorized' });
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'invalid_json' });
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const phone = b.phone;
    if (typeof phone !== 'string' || !PHONE_RE.test(phone)) return send(res, 400, { error: 'invalid_input' });
    let deliver: () => Promise<void>;
    if (req.url === '/sos') {
      const sos = parseSos(b);
      if (!sos) return send(res, 400, { error: 'invalid_input' });
      deliver = () => provider.sendSos(phone, sos);
    } else {
      const code = b.code;
      if (typeof code !== 'string' || !CODE_RE.test(code)) return send(res, 400, { error: 'invalid_input' });
      deliver = () => provider.sendOtp(phone, code);
    }

    try {
      await deliver();
      return send(res, 204);
    } catch (e) {
      if (e instanceof NotOnWhatsAppError) return send(res, 422, { error: 'not_on_whatsapp' });
      if (e instanceof ProviderUnavailableError) return send(res, 503, { error: 'unavailable' });
      return send(res, 502, { error: 'send_failed' });
    }
  }
}

function parseSos(b: Record<string, unknown>): SosAlert | undefined {
  const { name, lat, lng, accuracyM, at } = b;
  if (typeof name !== 'string' || name.length < 1 || name.length > 60) return undefined;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) return undefined;
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) return undefined;
  if (accuracyM !== undefined && (typeof accuracyM !== 'number' || !Number.isFinite(accuracyM) || accuracyM < 0)) return undefined;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return undefined;
  return { name, lat, lng, accuracyM: accuracyM as number | undefined, at };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body?: object) {
  if (res.headersSent) return;
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
