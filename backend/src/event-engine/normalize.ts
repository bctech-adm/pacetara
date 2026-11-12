import type { EventCategory } from '../events/events.service.js';

/**
 * Normalisasi untuk deteksi duplikat event (modul 2.4). Murni, tanpa I/O, diuji di event-engine.spec.ts.
 */

/** Kata yang tidak membedakan event: tahun, kata sambung, dan penanda edisi. */
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'dan', 'di', 'ke', 'by', 'edition', 'edisi', 'presents', 'present']);

/** "Bandung Marathon 2026 – The 5th Edition!" → "bandung marathon 5th". */
export function normalizeEventName(name: string): string {
  return nameTokens(name).join(' ');
}

export function nameTokens(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' dan ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && !STOPWORDS.has(t) && !/^(19|20)\d\d$/.test(t));
}

/** Koefisien Dice atas himpunan token nama (0..1). */
export function nameSimilarity(a: string, b: string): number {
  const ta = new Set(nameTokens(a));
  const tb = new Set(nameTokens(b));
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return (2 * common) / (ta.size + tb.size);
}

const TRACKING = /^(utm_|fbclid$|gclid$|ref$|mc_)/i;

/**
 * URL untuk perbandingan: host huruf kecil tanpa "www.", tanpa fragmen, parameter pelacak, dan garis miring
 * akhir. Null jika bukan https atau hanya halaman depan (situs penyelenggara yang memuat banyak event).
 */
export function normalizeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '');
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  if (!path && !params.length) return null;
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  return `${host}${path}${query}`;
}

const normCity = (c: string) =>
  c
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^(kota|kabupaten|kab\.?)\s+/, '')
    .replace(/[^a-z0-9]+/g, '');

/** Selisih hari antara dua tanggal YYYY-MM-DD. */
export function dayDiff(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

export interface DupCandidateInput {
  name: string;
  date: string;
  city: string;
  registrationUrl: string;
  sourceUrl?: string | null;
}

export type DupReason = 'same_url' | 'similar_name';

/** Jendela tanggal untuk nama mirip (event bisa bergeser sehari-dua antar sumber). */
export const DUP_DAY_WINDOW = 3;
const NAME_THRESHOLD = 0.6;

/**
 * Apakah [a] dan [b] kemungkinan event yang sama? Tautan pendaftaran/halaman resmi yang sama, atau nama
 * mirip (Dice >= 0,6 setelah normalisasi) pada tanggal berdekatan (<= 3 hari) di kota yang sama (kota
 * kosong dianggap cocok). Ditampilkan sebagai kandidat; super admin yang memutuskan menggabung.
 */
export function duplicateReason(a: DupCandidateInput, b: DupCandidateInput): DupReason | null {
  const urlsA = [normalizeUrl(a.registrationUrl), normalizeUrl(a.sourceUrl)].filter(Boolean);
  const urlsB = new Set([normalizeUrl(b.registrationUrl), normalizeUrl(b.sourceUrl)].filter(Boolean));
  if (urlsA.some((u) => urlsB.has(u)) && dayDiff(a.date, b.date) <= 31) return 'same_url';
  if (dayDiff(a.date, b.date) > DUP_DAY_WINDOW) return null;
  const ca = normCity(a.city);
  const cb = normCity(b.city);
  if (ca && cb && ca !== cb) return null;
  const na = normalizeEventName(a.name);
  if (na && na === normalizeEventName(b.name)) return 'similar_name';
  return nameSimilarity(a.name, b.name) >= NAME_THRESHOLD ? 'similar_name' : null;
}

/** Tebak kategori jarak dari nama/deskripsi (data terstruktur jarang memuatnya). Admin bisa mengubah. */
export function inferCategories(text: string): EventCategory[] {
  const t = text.toLowerCase();
  const out = new Set<EventCategory>();
  if (/\bultra\b|\b(50|60|70|80|100|160)\s?k\b/.test(t)) out.add('ultra');
  if (/half\s*-?\s*marathon|\b21(\.1)?\s?k\b|\bhm\b/.test(t)) out.add('hm');
  if (/full\s*-?\s*marathon|\b42(\.195)?\s?k\b|\bfm\b/.test(t) || /(?<!half[\s-]?|mini[\s-]?)\bmarathon\b/.test(t)) out.add('fm');
  if (/\b10\s?k\b/.test(t)) out.add('10k');
  if (/\b5\s?k\b/.test(t)) out.add('5k');
  if (/fun\s*-?\s*run/.test(t)) out.add('fun');
  return out.size ? [...out] : ['other'];
}
