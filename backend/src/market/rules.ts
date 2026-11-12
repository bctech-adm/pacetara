/**
 * Aturan murni marketplace (modul 3.2): komisi split payment, validasi dan penulisan ulang tautan afiliasi.
 */

/** Marketplace tujuan tautan afiliasi (domain dan subdomainnya). Tautan ke situs lain ditolak (mencegah phishing). */
export const AFFILIATE_HOSTS = ['tokopedia.com', 'tokopedia.link', 'shopee.co.id', 'shope.ee', 'lazada.co.id', 'blibli.com', 'bukalapak.com', 'tiktok.com', 'zalora.co.id'];

export const CATEGORIES = ['shoes', 'apparel', 'watch', 'accessory', 'nutrition', 'equipment', 'other'] as const;
export const CONDITIONS = ['new', 'like_new', 'used'] as const;

/** Komisi PaceTara: persen dari total (dibulatkan) + flat, tidak pernah melebihi total. */
export function computeFee(amount: number, percent: number, flat: number): number {
  const fee = Math.round((amount * percent) / 100) + flat;
  return Math.max(0, Math.min(amount, fee));
}

/** Host marketplace dasar yang cocok, atau null. */
export function affiliateBase(hostname: string): string | null {
  const h = hostname.toLowerCase();
  return AFFILIATE_HOSTS.find((b) => h === b || h.endsWith(`.${b}`)) ?? null;
}

/** Validasi tautan produk penjual: https, port bawaan, tanpa kredensial, host marketplace yang dikenal. */
export function validateAffiliateUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password || !affiliateBase(url.hostname)) return null;
  url.hash = '';
  return url.toString();
}

/** Parse AFFILIATE_TEMPLATES (JSON host → template berisi `{url}`). Entri tidak sah diabaikan. */
export function parseAffiliateTemplates(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw.trim()) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AFFILIATE_TEMPLATES bukan JSON yang valid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AFFILIATE_TEMPLATES harus objek host → template');
  for (const [host, tpl] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof tpl !== 'string' || !tpl.startsWith('https://') || !tpl.includes('{url}') || !AFFILIATE_HOSTS.includes(host)) {
      throw new Error(`AFFILIATE_TEMPLATES: entri ${host} tidak valid (host dikenal, template https berisi {url})`);
    }
    out.set(host, tpl);
  }
  return out;
}

/** Tautan keluar: template afiliasi PaceTara untuk host itu (jika ada), selain itu tautan asli. */
export function outboundUrl(productUrl: string, templates: Map<string, string>): string {
  const base = affiliateBase(new URL(productUrl).hostname);
  const tpl = base ? templates.get(base) : undefined;
  return tpl ? tpl.replace('{url}', encodeURIComponent(productUrl)) : productUrl;
}
