import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Redis } from 'ioredis';
import { decodeJwt } from 'jose';
import type pg from 'pg';
import { type WebSocket, WebSocketServer } from 'ws';
import { TokenService } from '../auth/token.service.js';
import { ENV, type Env } from '../config/env.js';
import { PG_POOL, REDIS } from '../core.module.js';

export const WS_PATH = '/v1/ws';
const REDIS_PREFIX = 'rt:';
const MAX_SUBS_PER_SOCKET = 50;
const MAX_SOCKETS_PER_USER = 5;
const UPGRADES_PER_IP_PER_MIN = 30;
const MSGS_PER_10S = 30;
const HEARTBEAT_MS = 30_000;

/** Kode penutupan khusus aplikasi (4000–4999). */
export const CLOSE_TOKEN_EXPIRED = 4001;
const CLOSE_TOO_MANY_MESSAGES = 4008;

/** Memutuskan apakah pengguna boleh berlangganan kanal yang cocok dengan pola. */
export type ChannelAuthorizer = (userId: string, match: RegExpExecArray) => Promise<boolean>;

interface Client {
  ws: WebSocket;
  userId: string;
  channels: Set<string>;
  alive: boolean;
  msgWindowStart: number;
  msgCount: number;
  expiryTimer?: NodeJS.Timeout;
}

/**
 * Hub WebSocket bersama (status lari sekarang, chat di modul 1.6).
 *
 * - Satu endpoint `wss://<api>/v1/ws`. Autentikasi lewat header `Authorization: Bearer <token akses>`
 *   saat handshake (token tidak pernah di URL). Browser tidak bisa memasang header itu, jadi
 *   cross-site WebSocket hijacking tidak mungkin.
 * - Di produksi, handshake yang tidak lewat HTTPS ditolak (sama dengan `rejectInsecure`).
 * - Koneksi ditutup (4001) tepat saat token akses kedaluwarsa; aplikasi memperpanjang sesi lalu
 *   menyambung ulang, sehingga sesi yang dicabut terputus paling lambat dalam umur token akses.
 * - Klien berlangganan kanal (`{"op":"sub","ch":"..."}`); setiap kanal wajib punya authorizer yang
 *   memeriksa hak akses di server. Kanal tanpa authorizer selalu ditolak.
 * - Pesan dari server disebar lewat Redis pub/sub agar berfungsi dengan lebih dari satu replika API.
 */
@Injectable()
export class RealtimeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Realtime');
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  private readonly authorizers: { pattern: RegExp; check: ChannelAuthorizer }[] = [];
  private readonly byChannel = new Map<string, Set<Client>>();
  private readonly byUser = new Map<string, Set<Client>>();
  private subscriber?: Redis;
  private heartbeat?: NodeJS.Timeout;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly tokens: TokenService,
    private readonly adapterHost: HttpAdapterHost,
  ) {}

  /** Daftarkan pemeriksa hak akses untuk kanal yang cocok dengan [pattern] (wajib berjangkar ^…$). */
  register(pattern: RegExp, check: ChannelAuthorizer): void {
    this.authorizers.push({ pattern, check });
  }

  /** Kirim event ke semua pelanggan kanal di semua replika. Jangan masukkan data pribadi ke [data]. */
  async publish(channel: string, event: string, data?: Record<string, unknown>): Promise<void> {
    await this.redis.publish(REDIS_PREFIX + channel, JSON.stringify({ op: 'event', ch: channel, ev: event, ...(data ? { data } : {}) }));
  }

  onApplicationBootstrap(): void {
    const server = this.adapterHost.httpAdapter?.getHttpServer() as import('node:http').Server | undefined;
    if (!server) return;
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.handleUpgrade(req, socket, head).catch(() => reject(socket, 500, 'server_error'));
    });

    this.subscriber = this.redis.duplicate();
    this.subscriber.on('message', (redisChannel: string, message: string) => {
      const set = this.byChannel.get(redisChannel.slice(REDIS_PREFIX.length));
      if (!set) return;
      for (const c of set) if (c.ws.readyState === c.ws.OPEN) c.ws.send(message);
    });

    this.heartbeat = setInterval(() => {
      for (const ws of this.wss.clients) {
        const c = (ws as WebSocket & { client?: Client }).client;
        if (!c) continue;
        if (!c.alive) {
          ws.terminate();
          continue;
        }
        c.alive = false;
        ws.ping();
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const ws of this.wss.clients) ws.close(1001, 'server_shutdown');
    this.wss.close();
    if (this.subscriber) await this.subscriber.quit().catch(() => undefined);
  }

  /** Jumlah koneksi aktif (untuk tes). */
  get connectionCount(): number {
    return this.wss.clients.size;
  }

  // ---------- Handshake ----------

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== WS_PATH) return reject(socket, 404, 'not_found');
    if (this.env.NODE_ENV === 'production' && forwardedProto(req) !== 'https') return reject(socket, 403, 'https_required');

    const ip = clientIp(req, this.env.TRUST_PROXY_HOPS);
    const key = `rt:ratelimit:${ip}`;
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, 60);
    if (n > UPGRADES_PER_IP_PER_MIN) return reject(socket, 429, 'rate_limited');

    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) return reject(socket, 401, 'unauthorized');
    let userId: string;
    let exp: number;
    try {
      userId = (await this.tokens.verifyAccess(token)).id;
      exp = decodeJwt(token).exp ?? 0;
    } catch (err) {
      const code = (err as { getResponse?: () => { error?: string } }).getResponse?.().error ?? 'invalid_access_token';
      return reject(socket, 401, code);
    }
    const { rows } = await this.pool.query<{ status: string; verification_level: number }>(
      'SELECT status, verification_level FROM users WHERE id = $1',
      [userId],
    );
    if (rows[0]?.status !== 'active') return reject(socket, 401, 'unauthorized');
    if (rows[0].verification_level < 1) return reject(socket, 403, 'verification_required');
    if ((this.byUser.get(userId)?.size ?? 0) >= MAX_SOCKETS_PER_USER) return reject(socket, 429, 'too_many_connections');

    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, userId, exp));
  }

  private onConnection(ws: WebSocket, userId: string, exp: number): void {
    const client: Client = { ws, userId, channels: new Set(), alive: true, msgWindowStart: Date.now(), msgCount: 0 };
    (ws as WebSocket & { client?: Client }).client = client;
    let userSet = this.byUser.get(userId);
    if (!userSet) this.byUser.set(userId, (userSet = new Set()));
    userSet.add(client);

    const msLeft = exp * 1000 - Date.now();
    client.expiryTimer = setTimeout(() => ws.close(CLOSE_TOKEN_EXPIRED, 'token_expired'), Math.max(0, msLeft));
    client.expiryTimer.unref();

    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (raw, isBinary) => {
      void this.onMessage(client, raw, isBinary).catch(() => send(client, { op: 'error', code: 'server_error' }));
    });
    ws.on('close', () => this.onClose(client));
    ws.on('error', () => ws.terminate());
    send(client, { op: 'ready' });
  }

  private async onMessage(client: Client, raw: import('ws').RawData, isBinary: boolean): Promise<void> {
    const now = Date.now();
    if (now - client.msgWindowStart > 10_000) {
      client.msgWindowStart = now;
      client.msgCount = 0;
    }
    if (++client.msgCount > MSGS_PER_10S) return client.ws.close(CLOSE_TOO_MANY_MESSAGES, 'too_many_messages');
    if (isBinary) return client.ws.close(1003, 'text_only');

    let msg: { op?: unknown; ch?: unknown };
    try {
      msg = JSON.parse(raw.toString()) as typeof msg;
    } catch {
      return send(client, { op: 'error', code: 'bad_message' });
    }
    const ch = typeof msg.ch === 'string' && msg.ch.length <= 120 ? msg.ch : undefined;
    switch (msg.op) {
      case 'ping':
        return send(client, { op: 'pong' });
      case 'sub': {
        if (!ch) return send(client, { op: 'error', code: 'bad_message' });
        if (client.channels.has(ch)) return send(client, { op: 'subscribed', ch });
        if (client.channels.size >= MAX_SUBS_PER_SOCKET) return send(client, { op: 'error', ch, code: 'too_many_subscriptions' });
        if (!(await this.authorize(client.userId, ch))) return send(client, { op: 'error', ch, code: 'forbidden' });
        if (client.ws.readyState !== client.ws.OPEN) return;
        await this.addSubscription(client, ch);
        return send(client, { op: 'subscribed', ch });
      }
      case 'unsub':
        if (ch) await this.removeSubscription(client, ch);
        return send(client, { op: 'unsubscribed', ch });
      default:
        return send(client, { op: 'error', code: 'bad_message' });
    }
  }

  private async authorize(userId: string, channel: string): Promise<boolean> {
    for (const a of this.authorizers) {
      const m = a.pattern.exec(channel);
      if (m) return a.check(userId, m);
    }
    return false;
  }

  private async addSubscription(client: Client, ch: string): Promise<void> {
    client.channels.add(ch);
    let set = this.byChannel.get(ch);
    if (!set) {
      this.byChannel.set(ch, (set = new Set()));
      await this.subscriber?.subscribe(REDIS_PREFIX + ch);
    }
    set.add(client);
  }

  private async removeSubscription(client: Client, ch: string): Promise<void> {
    client.channels.delete(ch);
    const set = this.byChannel.get(ch);
    if (!set) return;
    set.delete(client);
    if (set.size === 0) {
      this.byChannel.delete(ch);
      await this.subscriber?.unsubscribe(REDIS_PREFIX + ch).catch(() => undefined);
    }
  }

  private onClose(client: Client): void {
    if (client.expiryTimer) clearTimeout(client.expiryTimer);
    for (const ch of [...client.channels]) void this.removeSubscription(client, ch);
    const userSet = this.byUser.get(client.userId);
    userSet?.delete(client);
    if (userSet?.size === 0) this.byUser.delete(client.userId);
  }
}

function send(client: Client, msg: Record<string, unknown>): void {
  if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(msg));
}

const STATUS_TEXT: Record<number, string> = {
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
};

function reject(socket: Duplex, status: number, code: string): void {
  if (socket.destroyed) return;
  const body = JSON.stringify({ statusCode: status, error: code });
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nConnection: close\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

/** Protokol asli dari proxy tepercaya (entri terakhir X-Forwarded-Proto, ditulis Caddy/Traefik). */
function forwardedProto(req: IncomingMessage): string | undefined {
  const raw = req.headers['x-forwarded-proto'];
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  return value
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .at(-1);
}

/** IP klien dengan aturan yang sama seperti `trust proxy` Express: lewati [hops] proxy dari kanan. */
export function clientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>, hops: number): string {
  const raw = req.headers['x-forwarded-for'];
  const xff = (Array.isArray(raw) ? raw.join(',') : (raw ?? ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const chain = [...xff, req.socket.remoteAddress ?? 'unknown'];
  return chain[Math.max(0, chain.length - 1 - hops)]!;
}
