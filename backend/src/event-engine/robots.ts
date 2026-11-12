/**
 * Pengurai robots.txt (RFC 9309) untuk scraper event. Grup yang cocok dengan token bot kita
 * ("pacetarabot", tanpa beda huruf besar/kecil) dipakai; jika tidak ada, grup "*". Aturan dengan pola
 * terpanjang yang cocok menang; jika sama panjang, Allow menang. Mendukung wildcard `*` dan akhiran `$`.
 * Crawl-delay (non-standar) dihormati bila ada.
 */

export interface RobotsRules {
  rules: { allow: boolean; pattern: string }[];
  crawlDelaySec: number | null;
}

/** Kebijakan khusus saat robots.txt tidak bisa dibaca (RFC 9309 bagian 2.3.1). */
export const ALLOW_ALL: RobotsRules = { rules: [], crawlDelaySec: null };
export const DISALLOW_ALL: RobotsRules = { rules: [{ allow: false, pattern: '/' }], crawlDelaySec: null };

export function parseRobots(text: string, botToken: string): RobotsRules {
  const token = botToken.toLowerCase();
  type Group = { agents: string[]; rules: RobotsRules['rules']; delay: number | null };
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], delay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      // "Disallow:" kosong = tidak melarang apa pun.
      if (value) current.rules.push({ allow: key === 'allow', pattern: value });
    } else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.delay = n;
    }
  }

  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && a !== '' && a.includes(token)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  const delays = chosen.map((g) => g.delay).filter((d): d is number => d !== null);
  return { rules: chosen.flatMap((g) => g.rules), crawlDelaySec: delays.length ? Math.max(...delays) : null };
}

function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = body
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${re}${anchored ? '$' : ''}`).test(path);
}

/** [path] = pathname + search, mis. "/events?page=2". */
export function isAllowed(robots: RobotsRules, path: string): boolean {
  if (path === '/robots.txt') return true;
  let best: { allow: boolean; len: number } | null = null;
  for (const r of robots.rules) {
    if (!patternMatches(r.pattern, path)) continue;
    const len = r.pattern.length;
    if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { allow: r.allow, len };
  }
  return best ? best.allow : true;
}
