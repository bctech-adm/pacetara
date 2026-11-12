import { z } from 'zod';
import { parseJsonLdEvents, type ScrapedEvent } from './jsonld.js';

/**
 * Sumber scraping event (modul 2.4). TIDAK ADA sumber yang aktif secara bawaan: pemilik menambahkannya
 * lewat env `EVENT_SCRAPE_SOURCES` (JSON) setelah memeriksa ketentuan layanan dan robots.txt situs itu
 * (PRD "Yang harus diverifikasi": Scraping event). Lihat README dan KEPUTUSAN.md.
 *
 * Contoh:
 *   EVENT_SCRAPE_SOURCES=[{"id":"kalender-contoh","name":"Kalender Contoh","urls":["https://kalender.contoh.id/lari"]}]
 */

export type EventParser = (html: string, pageUrl: string, today: string) => ScrapedEvent[];

/** Parser yang tersedia. Parser khusus situs ditambahkan di sini (dan diuji) bila data terstruktur tidak ada. */
export const PARSERS: Record<string, EventParser> = {
  jsonld: parseJsonLdEvents,
};

export interface EventSource {
  /** Id tetap, dipakai sebagai kunci idempoten bersama id/URL event di sumber. */
  id: string;
  /** Nama situs yang ditampilkan: "Sumber: <nama>". */
  name: string;
  /** Halaman yang dibaca (maks. 20), semuanya https. Host-nya menjadi allowlist sumber ini. */
  urls: string[];
  parser: keyof typeof PARSERS;
  allowedHosts: ReadonlySet<string>;
}

/** Daftar di kode (sengaja kosong). Isi hanya untuk situs yang ketentuannya sudah diperiksa. */
export const BUILTIN_SOURCES: Omit<EventSource, 'allowedHosts'>[] = [];

const httpsPage = z
  .string()
  .max(500)
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.protocol === 'https:' && !u.port && !u.username && !u.password && u.hostname.includes('.') && !/^[\d.]+$|:/.test(u.hostname);
    } catch {
      return false;
    }
  }, 'URL sumber harus https dengan nama domain');

const SourceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'id: huruf kecil/angka/strip, 2-40 karakter'),
    name: z.string().trim().min(2).max(80),
    urls: z.array(httpsPage).min(1).max(20),
    parser: z.enum(Object.keys(PARSERS) as [string, ...string[]]).default('jsonld'),
    enabled: z.boolean().default(true),
  })
  .strict();

/** Urai `EVENT_SCRAPE_SOURCES`. Konfigurasi salah = worker gagal start dengan pesan jelas (tanpa nilai rahasia). */
export function loadSources(raw: string): EventSource[] {
  const list: Omit<EventSource, 'allowedHosts'>[] = [...BUILTIN_SOURCES];
  if (raw.trim()) {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error('EVENT_SCRAPE_SOURCES bukan JSON yang valid');
    }
    const parsed = z.array(SourceSchema).max(50).safeParse(json);
    if (!parsed.success) {
      throw new Error(`EVENT_SCRAPE_SOURCES tidak valid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    for (const s of parsed.data) if (s.enabled) list.push({ id: s.id, name: s.name, urls: s.urls, parser: s.parser });
  }
  const ids = new Set<string>();
  return list.map((s) => {
    if (ids.has(s.id)) throw new Error(`EVENT_SCRAPE_SOURCES: id ganda "${s.id}"`);
    ids.add(s.id);
    return { ...s, allowedHosts: new Set(s.urls.map((u) => new URL(u).hostname.toLowerCase())) };
  });
}
