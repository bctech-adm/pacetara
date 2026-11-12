import type { EventCategory } from '../events/events.service.js';
import { inferCategories, normalizeEventName, normalizeUrl } from './normalize.js';

/** Event hasil scraping, sebelum masuk antrean (event_submissions). */
export interface ScrapedEvent {
  /** Kunci idempoten per sumber: url halaman event (dinormalisasi), atau nama+tanggal. */
  externalKey: string;
  name: string;
  date: string;
  startTime: string | null;
  /** Bisa kosong; super admin wajib mengisinya sebelum menyetujui. */
  city: string;
  venue: string;
  description: string;
  categories: EventCategory[];
  registrationUrl: string;
  /** Halaman resmi event di situs sumber. */
  sourceUrl: string;
}

const EVENT_TYPES = new Set(['event', 'sportsevent', 'festival', 'sportevent']);
const MAX_NODES = 2_000;
const MAX_DEPTH = 8;
const MAX_EVENTS = 200;
/** Event lebih dari 2 tahun ke depan dianggap salah data. */
const MAX_DAYS_AHEAD = 730;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Teks polos: tag HTML dibuang, entitas umum diurai, spasi dirapikan. */
export function plainText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const s = v
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+|#39);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (ENTITIES[k]) return ENTITIES[k];
      const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : k.startsWith('#') ? parseInt(k.slice(1), 10) : NaN;
      return Number.isFinite(code) && code > 31 && code < 0x110000 ? String.fromCodePoint(code) : m;
    })
    // Karakter kontrol dibuang.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** URL https absolut (relatif terhadap halaman), tanpa kredensial; selain itu null. */
function httpsUrl(v: unknown, base: string): string | null {
  const raw = typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { url?: unknown }).url === 'string' ? (v as { url: string }).url : null;
  if (!raw) return null;
  try {
    const u = new URL(raw.trim(), base);
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
    u.hash = '';
    const s = u.toString();
    return s.length <= 500 ? s : null;
  } catch {
    return null;
  }
}

function types(node: Record<string, unknown>): string[] {
  const t = node['@type'];
  const arr = Array.isArray(t) ? t : [t];
  return arr.filter((x): x is string => typeof x === 'string').map((x) => x.replace(/^.*[/#:]/, '').toLowerCase());
}

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

/** Blok <script type="application/ld+json"> dari HTML. Blok yang rusak dilewati. */
export function extractJsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (const m of html.matchAll(re)) {
    const body = m[1]!
      .trim()
      .replace(/^<!--/, '')
      .replace(/-->$/, '')
      .replace(/^\s*\/\/\s*<!\[CDATA\[/, '')
      .replace(/\/\/\s*\]\]>\s*$/, '')
      .trim();
    if (!body) continue;
    try {
      out.push(JSON.parse(body));
    } catch {
      // abaikan blok rusak
    }
  }
  return out;
}

/** Semua node bertipe Event (termasuk di @graph, ItemList, dsb.), dengan batas kedalaman dan jumlah. */
function collectEvents(roots: unknown[]): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  let visited = 0;
  const walk = (v: unknown, depth: number) => {
    if (visited++ > MAX_NODES || depth > MAX_DEPTH || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const node = v as Record<string, unknown>;
    if (types(node).some((t) => EVENT_TYPES.has(t) || t.endsWith('event'))) {
      found.push(node);
      return; // subEvent/superEvent tidak ditelusuri agar tidak dobel
    }
    for (const [k, x] of Object.entries(node)) if (k !== '@context') walk(x, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return found;
}

function location(node: Record<string, unknown>): { city: string; venue: string; virtual: boolean } {
  const locs = Array.isArray(node.location) ? node.location : [node.location];
  for (const l of locs) {
    if (!l || typeof l !== 'object') {
      if (typeof l === 'string') return { city: '', venue: plainText(l, 160), virtual: false };
      continue;
    }
    const loc = l as Record<string, unknown>;
    if (types(loc).includes('virtuallocation')) continue;
    const addr = first(loc.address);
    let city = '';
    if (addr && typeof addr === 'object') {
      const a = addr as Record<string, unknown>;
      city = plainText(a.addressLocality, 60) || plainText(a.addressRegion, 60);
    }
    return { city: city.length >= 2 ? city : '', venue: plainText(loc.name, 160), virtual: false };
  }
  return { city: '', venue: '', virtual: locs.some((l) => l && typeof l === 'object') };
}

function dateParts(v: unknown): { date: string; time: string | null } | null {
  if (typeof v !== 'string') return null;
  // Tanggal dan jam diambil apa adanya (waktu setempat penyelenggara), tanpa konversi zona waktu.
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(v.trim());
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) return null;
  const hh = m[4] ? Number(m[4]) : NaN;
  const mm = m[5] ? Number(m[5]) : NaN;
  const time = hh <= 23 && mm <= 59 && !(hh === 0 && mm === 0) ? `${m[4]}:${m[5]}` : null;
  return { date, time };
}

/**
 * Parser generik: event schema.org (JSON-LD) dari satu halaman. Event yang dibatalkan/ditunda, virtual,
 * sudah lewat ([today], WIB), atau tanpa nama/tanggal dilewati. Tautan pendaftaran = offers.url, lalu url
 * event, lalu halaman itu sendiri; semuanya wajib https.
 */
export function parseJsonLdEvents(html: string, pageUrl: string, today: string): ScrapedEvent[] {
  const out = new Map<string, ScrapedEvent>();
  const maxDate = new Date(Date.parse(`${today}T00:00:00Z`) + MAX_DAYS_AHEAD * 86_400_000).toISOString().slice(0, 10);
  for (const node of collectEvents(extractJsonLd(html))) {
    if (out.size >= MAX_EVENTS) break;
    const status = String(first(node.eventStatus) ?? '');
    if (/cancelled|postponed/i.test(status)) continue;
    const name = plainText(node.name, 120);
    if (name.length < 3) continue;
    const when = dateParts(node.startDate);
    if (!when || when.date < today || when.date > maxDate) continue;
    const loc = location(node);
    if (loc.virtual) continue;
    const eventUrl = httpsUrl(node.url, pageUrl);
    const offers = Array.isArray(node.offers) ? node.offers : [node.offers];
    const offerUrl = offers.map((o) => httpsUrl(o, pageUrl)).find(Boolean) ?? null;
    const sourceUrl = eventUrl ?? httpsUrl(pageUrl, pageUrl);
    if (!sourceUrl) continue;
    const description = plainText(node.description, 2000);
    // Kunci = halaman khusus event (bila ada); halaman daftar yang memuat banyak event memakai nama + tanggal.
    const ownPage = normalizeUrl(eventUrl);
    const externalKey = (ownPage && ownPage !== normalizeUrl(pageUrl) ? ownPage : `${normalizeEventName(name)}|${when.date}`).slice(0, 500);
    out.set(externalKey, {
      externalKey,
      name,
      date: when.date,
      startTime: when.time,
      city: loc.city,
      venue: loc.venue,
      description,
      categories: inferCategories(`${name} ${description}`),
      registrationUrl: offerUrl ?? sourceUrl,
      sourceUrl,
    });
  }
  return [...out.values()];
}
