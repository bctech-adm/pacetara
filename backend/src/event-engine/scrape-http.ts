import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { ALLOW_ALL, DISALLOW_ALL, isAllowed, parseRobots, type RobotsRules } from './robots.js';

/**
 * Satu-satunya jalan keluar HTTP scraper event (modul 2.4). Sopan dan anti-SSRF:
 * - hanya https (port bawaan) ke host yang ada di allowlist sumber, tanpa kredensial di URL, bukan IP literal;
 * - alamat hasil DNS diperiksa SAAT tersambung (opsi `lookup`), jadi IP privat/loopback/link-local ditolak
 *   termasuk lewat DNS rebinding;
 * - redirect hanya diikuti ke host yang sama (maks. 3), selain itu ditolak;
 * - robots.txt dihormati (token "PaceTaraBot"), beserta Crawl-delay;
 * - jeda minimal antar permintaan ke host yang sama, batas waktu, dan batas ukuran respons;
 * - User-Agent jujur tanpa data pribadi: "PaceTaraBot/1.0 (+<situs publik>/bot)".
 */

export const BOT_TOKEN = 'PaceTaraBot';
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2 * 1024 * 1024;
/** RFC 9309: crawler wajib membaca minimal 500 KiB robots.txt. */
const ROBOTS_MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const ROBOTS_TTL_MS = 24 * 3_600_000;
const ROBOTS_ERROR_TTL_MS = 3_600_000;
/** Crawl-delay di atas ini dianggap "jangan sering-sering" dan dibatasi agar job tidak menggantung. */
const MAX_CRAWL_DELAY_SEC = 60;

export class ScrapeError extends Error {
  constructor(
    readonly code: 'bad_url' | 'host_not_allowed' | 'private_address' | 'robots_disallowed' | 'redirect_other_host' | 'too_many_redirects' | 'too_large' | 'bad_status' | 'bad_content_type' | 'network',
    message: string,
  ) {
    super(message);
  }
}

// ---------- Alamat IP ----------

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** true hanya untuk alamat unicast publik. IPv4-mapped IPv6 (::ffff:a.b.c.d) diperiksa sebagai IPv4. */
export function isPublicAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPublicAddress(mapped[1]!);
  const family = isIP(ip);
  if (family === 4) return !blocked.check(ip, 'ipv4');
  if (family === 6) {
    if (/^::ffff:/i.test(ip)) return false; // mapped dalam bentuk heksadesimal
    return !blocked.check(ip, 'ipv6');
  }
  return false;
}

/** `lookup` untuk https.request: semua alamat hasil DNS wajib publik. */
export const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 4);
    const list = addresses as unknown as LookupAddress[];
    if (!list.length || list.some((a) => !isPublicAddress(a.address))) {
      const e = Object.assign(new Error(`Alamat ${hostname} tidak publik`), { code: 'EPRIVATEADDR' });
      return callback(e, '', 4);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

/** Validasi URL sebelum diminta: https, port bawaan, tanpa kredensial, host nama (bukan IP) di allowlist. */
export function assertScrapeUrl(raw: string, allowedHosts: ReadonlySet<string>): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ScrapeError('bad_url', 'URL tidak valid');
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') {
    throw new ScrapeError('bad_url', 'Hanya https tanpa port/kredensial');
  }
  const host = url.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.')) throw new ScrapeError('host_not_allowed', 'Host harus nama domain');
  if (!allowedHosts.has(host)) throw new ScrapeError('host_not_allowed', `Host ${host} tidak ada di allowlist`);
  url.hash = '';
  return url;
}

// ---------- Transport ----------

export interface RawResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export type Transport = (url: URL, opts: { headers: Record<string, string>; timeoutMs: number; maxBytes: number }) => Promise<RawResponse>;

/** Transport asli: node:https dengan safeLookup, TLS >= 1.2, batas ukuran dihitung saat streaming. */
export const httpsTransport: Transport = (url, opts) =>
  new Promise<RawResponse>((resolve, reject) => {
    const req = httpsRequest(url, { method: 'GET', headers: opts.headers, lookup: safeLookup, minVersion: 'TLSv1.2', agent: false }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const declared = Number(res.headers['content-length'] ?? 0);
      if (declared > opts.maxBytes) {
        res.destroy();
        return reject(new ScrapeError('too_large', 'Respons terlalu besar'));
      }
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > opts.maxBytes) {
          res.destroy();
          reject(new ScrapeError('too_large', 'Respons terlalu besar'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
        resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
      });
      res.on('error', (e) => reject(new ScrapeError('network', e.message)));
    });
    req.setTimeout(opts.timeoutMs, () => req.destroy(new ScrapeError('network', 'Batas waktu habis')));
    req.on('error', (e) => {
      if (e instanceof ScrapeError) return reject(e);
      if ((e as { code?: string }).code === 'EPRIVATEADDR') return reject(new ScrapeError('private_address', e.message));
      reject(new ScrapeError('network', (e as { code?: string }).code ?? 'galat jaringan'));
    });
    req.end();
  });

// ---------- Klien ----------

@Injectable()
export class ScrapeHttp {
  /** Diganti di tes (tanpa internet). */
  transport: Transport = httpsTransport;
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
  now: () => number = () => Date.now();

  readonly userAgent: string;
  private readonly minDelayMs: number;
  private readonly robots = new Map<string, { rules: RobotsRules; until: number }>();
  private readonly lastRequest = new Map<string, number>();

  constructor(@Inject(ENV) env: Env) {
    this.userAgent = `${BOT_TOKEN}/1.0 (+${env.PUBLIC_WEB_URL.replace(/\/+$/, '')}/bot)`;
    this.minDelayMs = env.EVENT_SCRAPE_DELAY_MS;
  }

  /** Ambil halaman HTML/JSON dari host di [allowedHosts]. Melempar ScrapeError. */
  async get(raw: string, allowedHosts: ReadonlySet<string>): Promise<string> {
    let url = assertScrapeUrl(raw, allowedHosts);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const rules = await this.robotsFor(url);
      if (!isAllowed(rules, url.pathname + url.search)) throw new ScrapeError('robots_disallowed', `robots.txt melarang ${url.pathname}`);
      const res = await this.fetch(url, MAX_BYTES, rules.crawlDelaySec);
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        const next = this.redirectTarget(url, res.headers.location, allowedHosts);
        url = next;
        continue;
      }
      if (res.status !== 200) throw new ScrapeError('bad_status', `${url.hostname} menjawab ${res.status}`);
      const type = (res.headers['content-type'] ?? '').toLowerCase();
      if (!/text\/html|application\/xhtml\+xml|application\/(ld\+)?json/.test(type)) {
        throw new ScrapeError('bad_content_type', `Jenis konten tidak didukung: ${type.split(';')[0] || 'kosong'}`);
      }
      return res.body.toString('utf8');
    }
    throw new ScrapeError('too_many_redirects', 'Terlalu banyak redirect');
  }

  private redirectTarget(from: URL, location: string, allowedHosts: ReadonlySet<string>): URL {
    let next: URL;
    try {
      next = new URL(location, from);
    } catch {
      throw new ScrapeError('bad_url', 'Redirect tidak valid');
    }
    // Hanya host yang sama: host yang sah tidak bisa membelokkan scraper ke alamat lain/internal.
    if (next.hostname.toLowerCase() !== from.hostname.toLowerCase()) throw new ScrapeError('redirect_other_host', `Redirect ke host lain (${next.hostname}) ditolak`);
    return assertScrapeUrl(next.toString(), allowedHosts);
  }

  /** robots.txt per host, disimpan 24 jam. 4xx = boleh semua; 5xx/galat jaringan = dilarang semua (RFC 9309). */
  async robotsFor(url: URL): Promise<RobotsRules> {
    const key = url.host.toLowerCase();
    const cached = this.robots.get(key);
    if (cached && cached.until > this.now()) return cached.rules;
    let rules: RobotsRules;
    let ttl = ROBOTS_TTL_MS;
    try {
      let target = new URL('/robots.txt', url);
      let res = await this.fetch(target, ROBOTS_MAX_BYTES, null);
      for (let hop = 0; hop < MAX_REDIRECTS && res.status >= 300 && res.status < 400 && res.headers.location; hop++) {
        const next = new URL(res.headers.location, target);
        if (next.protocol !== 'https:' || next.hostname.toLowerCase() !== target.hostname.toLowerCase()) break;
        target = next;
        res = await this.fetch(target, ROBOTS_MAX_BYTES, null);
      }
      if (res.status >= 200 && res.status < 300) rules = parseRobots(res.body.toString('utf8'), BOT_TOKEN);
      else if (res.status >= 400 && res.status < 500) rules = ALLOW_ALL;
      else {
        rules = DISALLOW_ALL;
        ttl = ROBOTS_ERROR_TTL_MS;
      }
    } catch (err) {
      // Batas ukuran robots.txt terlampaui = anggap tidak bisa dibaca → jangan scrape.
      if (err instanceof ScrapeError && (err.code === 'private_address' || err.code === 'host_not_allowed')) throw err;
      rules = DISALLOW_ALL;
      ttl = ROBOTS_ERROR_TTL_MS;
    }
    this.robots.set(key, { rules, until: this.now() + ttl });
    return rules;
  }

  /** Satu permintaan dengan jeda sopan per host. */
  private async fetch(url: URL, maxBytes: number, crawlDelaySec: number | null): Promise<RawResponse> {
    const host = url.host.toLowerCase();
    const delay = Math.max(this.minDelayMs, Math.min(crawlDelaySec ?? 0, MAX_CRAWL_DELAY_SEC) * 1000);
    const last = this.lastRequest.get(host);
    if (last !== undefined) {
      const wait = last + delay - this.now();
      if (wait > 0) await this.sleep(wait);
    }
    this.lastRequest.set(host, this.now());
    return this.transport(url, {
      headers: { 'User-Agent': this.userAgent, Accept: 'text/html,application/xhtml+xml,application/ld+json;q=0.9,*/*;q=0.1', 'Accept-Encoding': 'identity' },
      timeoutMs: TIMEOUT_MS,
      maxBytes,
    });
  }
}
