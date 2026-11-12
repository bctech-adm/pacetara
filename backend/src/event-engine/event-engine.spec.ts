import { describe, expect, it } from 'vitest';
import type { Env } from '../config/env.js';
import { parseJsonLdEvents, plainText } from './jsonld.js';
import { duplicateReason, inferCategories, nameSimilarity, normalizeEventName, normalizeUrl } from './normalize.js';
import { isAllowed, parseRobots } from './robots.js';
import { assertScrapeUrl, isPublicAddress, type RawResponse, ScrapeError, ScrapeHttp } from './scrape-http.js';
import { loadSources } from './sources.js';

const TODAY = '2026-11-12';

describe('robots.txt', () => {
  const txt = `
# komentar
User-agent: *
Disallow: /admin
Disallow: /cari?
Allow: /admin/publik

User-agent: BotLain
Disallow: /

User-agent: PaceTaraBot
User-agent: botketiga
Disallow: /private/
Allow: /private/events$
Crawl-delay: 10
`;

  it('memakai grup khusus PaceTaraBot bila ada', () => {
    const r = parseRobots(txt, 'PaceTaraBot');
    expect(r.crawlDelaySec).toBe(10);
    expect(isAllowed(r, '/admin')).toBe(true); // grup * tidak berlaku
    expect(isAllowed(r, '/private/x')).toBe(false);
    expect(isAllowed(r, '/private/events')).toBe(true);
    expect(isAllowed(r, '/private/events/2')).toBe(false);
  });

  it('jatuh ke grup * bila tidak ada grup khusus; pola terpanjang menang, seri = Allow', () => {
    const r = parseRobots(txt, 'BotTakDikenal');
    expect(isAllowed(r, '/admin/rahasia')).toBe(false);
    expect(isAllowed(r, '/admin/publik/a')).toBe(true);
    expect(isAllowed(r, '/cari?q=lari')).toBe(false);
    expect(isAllowed(r, '/events')).toBe(true);
    const tie = parseRobots('User-agent: *\nDisallow: /a\nAllow: /a', 'x');
    expect(isAllowed(tie, '/a')).toBe(true);
  });

  it('wildcard dan Disallow kosong', () => {
    const r = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow:', 'PaceTaraBot');
    expect(isAllowed(r, '/file.pdf')).toBe(false);
    expect(isAllowed(r, '/file.pdf?x=1')).toBe(true);
    expect(isAllowed(r, '/events')).toBe(true);
    expect(isAllowed(parseRobots('User-agent: *\nDisallow: /', 'PaceTaraBot'), '/events')).toBe(false);
    expect(isAllowed(parseRobots('', 'PaceTaraBot'), '/apa-saja')).toBe(true);
  });
});

describe('normalisasi dan duplikat', () => {
  it('nama dinormalisasi', () => {
    expect(normalizeEventName('Bandung Marathon 2026 – The 5th Edition!')).toBe('bandung marathon 5th');
    expect(normalizeEventName('Café Run & Fun')).toBe('cafe run fun');
    expect(nameSimilarity('Jakarta Marathon 2026', 'JAKARTA MARATHON')).toBe(1);
    expect(nameSimilarity('Jakarta Marathon', 'Bali Marathon')).toBe(0.5);
  });

  it('URL dinormalisasi; halaman depan tidak dipakai', () => {
    expect(normalizeUrl('https://www.Contoh.id/event/lari/?utm_source=ig#daftar')).toBe('contoh.id/event/lari');
    expect(normalizeUrl('https://contoh.id/')).toBeNull();
    expect(normalizeUrl('http://contoh.id/event')).toBeNull();
    expect(normalizeUrl('https://contoh.id/e?id=5&utm_medium=x')).toBe('contoh.id/e?id=5');
  });

  it('kandidat duplikat: nama mirip + tanggal berdekatan + kota, atau URL sama', () => {
    const a = { name: 'Bandung Marathon 2026', date: '2026-12-06', city: 'Bandung', registrationUrl: 'https://a.id/daftar' };
    expect(duplicateReason(a, { name: 'BANDUNG MARATHON', date: '2026-12-07', city: 'Kota Bandung', registrationUrl: 'https://b.id/x' })).toBe('similar_name');
    expect(duplicateReason(a, { name: 'Bandung Marathon', date: '2026-12-20', city: 'Bandung', registrationUrl: 'https://b.id/x' })).toBeNull();
    expect(duplicateReason(a, { name: 'Bandung Marathon', date: '2026-12-06', city: 'Surabaya', registrationUrl: 'https://b.id/x' })).toBeNull();
    expect(duplicateReason(a, { name: 'Bandung Marathon', date: '2026-12-06', city: '', registrationUrl: 'https://b.id/x' })).toBe('similar_name');
    expect(duplicateReason(a, { name: 'Nama Lain Sama Sekali', date: '2026-12-10', city: 'Bogor', registrationUrl: 'https://www.a.id/daftar/' })).toBe('same_url');
    expect(duplicateReason(a, { name: 'Surabaya Night Run', date: '2026-12-06', city: 'Bandung', registrationUrl: 'https://c.id/y' })).toBeNull();
  });

  it('kategori ditebak dari teks', () => {
    expect(inferCategories('Jakarta Half Marathon 21K')).toEqual(['hm']);
    expect(inferCategories('Borobudur Marathon: 10K dan 5K')).toEqual(expect.arrayContaining(['fm', '10k', '5k']));
    expect(inferCategories('Half-Marathon Bogor')).toEqual(['hm']);
    expect(inferCategories('Rinjani Ultra 100K')).toEqual(['ultra']);
    expect(inferCategories('Color Fun Run')).toEqual(['fun']);
    expect(inferCategories('Lari 25K')).toEqual(['other']);
  });
});

describe('parser JSON-LD schema.org Event', () => {
  const html = `<!doctype html><html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
  {"@type":"Organization","name":"Org"},
  {"@type":"SportsEvent","name":"Bandung Night Run 10K &amp; 5K","startDate":"2026-12-06T05:30:00+07:00",
   "url":"/event/bnr","eventStatus":"https://schema.org/EventScheduled",
   "location":{"@type":"Place","name":"Gedung Sate","address":{"@type":"PostalAddress","addressLocality":"Bandung"}},
   "offers":{"@type":"Offer","url":"https://tiket.contoh.id/bnr"},"description":"<p>Lari malam</p>"}
]}</script>
<script type="application/ld+json">[
  {"@type":"Event","name":"Lari Kemarin","startDate":"2026-11-01","location":{"@type":"Place","address":{"addressLocality":"Bogor"}}},
  {"@type":"Event","name":"Lari Batal","startDate":"2026-12-01","eventStatus":"EventCancelled"},
  {"@type":"Event","name":"Lari Virtual","startDate":"2026-12-01","location":{"@type":"VirtualLocation","url":"https://zoom.example"}},
  {"@type":"Event","name":"Fun Run Tanpa Kota","startDate":"2026-12-20","url":"http://tidak-aman.id/x"},
  {"@type":"Event","name":"Rusak","startDate":"2026-02-30"}
]</script>
<script type="application/ld+json">{ rusak </script>
</head><body></body></html>`;

  it('membaca event, melewati yang lewat/batal/virtual/tanggal salah, URL hanya https', () => {
    const items = parseJsonLdEvents(html, 'https://kalender.contoh.id/lari', TODAY);
    expect(items).toHaveLength(2);
    const [bnr, fun] = items;
    expect(bnr).toMatchObject({
      name: 'Bandung Night Run 10K & 5K',
      date: '2026-12-06',
      startTime: '05:30',
      city: 'Bandung',
      venue: 'Gedung Sate',
      description: 'Lari malam',
      registrationUrl: 'https://tiket.contoh.id/bnr',
      sourceUrl: 'https://kalender.contoh.id/event/bnr',
      externalKey: 'kalender.contoh.id/event/bnr',
    });
    expect(bnr!.categories).toEqual(expect.arrayContaining(['10k', '5k']));
    // url http dibuang → halaman daftar jadi sumber; kunci = nama + tanggal.
    expect(fun).toMatchObject({ city: '', sourceUrl: 'https://kalender.contoh.id/lari', registrationUrl: 'https://kalender.contoh.id/lari', externalKey: 'fun run tanpa kota|2026-12-20' });
  });

  it('teks polos membuang tag dan karakter kontrol', () => {
    expect(plainText('<b>Halo</b>\u0000 &lt;dunia&gt; &#65;', 100)).toBe('Halo <dunia> A');
    expect(plainText('a'.repeat(10), 5)).toHaveLength(5);
  });
});

describe('anti-SSRF', () => {
  it('alamat privat/loopback/link-local ditolak', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '224.0.0.1']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ['104.16.1.1', '8.8.8.8', '2606:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it('URL: hanya https ke host di allowlist, tanpa port/kredensial/IP literal', () => {
    const allow = new Set(['kalender.contoh.id']);
    expect(assertScrapeUrl('https://kalender.contoh.id/lari', allow).hostname).toBe('kalender.contoh.id');
    for (const bad of [
      'http://kalender.contoh.id/lari',
      'https://kalender.contoh.id:8443/lari',
      'https://u:p@kalender.contoh.id/',
      'https://lain.contoh.id/',
      'https://127.0.0.1/',
      'https://[::1]/',
      'file:///etc/passwd',
      'bukan url',
    ]) {
      expect(() => assertScrapeUrl(bad, allow), bad).toThrow(ScrapeError);
    }
  });
});

describe('ScrapeHttp (transport palsu, tanpa internet)', () => {
  const env = { PUBLIC_WEB_URL: 'https://pace.contoh.id', EVENT_SCRAPE_DELAY_MS: 5000 } as Env;
  const allow = new Set(['kalender.contoh.id']);

  function client(routes: Record<string, RawResponse | (() => RawResponse)>) {
    const http = new ScrapeHttp(env);
    const calls: { url: string; ua: string }[] = [];
    const sleeps: number[] = [];
    let clock = 1_000_000;
    http.now = () => clock;
    http.sleep = async (ms) => {
      sleeps.push(ms);
      clock += ms;
    };
    http.transport = async (url, opts) => {
      calls.push({ url: url.toString(), ua: opts.headers['User-Agent']! });
      const r = routes[url.toString()];
      if (!r) return { status: 404, headers: {}, body: Buffer.from('') };
      return typeof r === 'function' ? r() : r;
    };
    return { http, calls, sleeps };
  }
  const page = (body: string, type = 'text/html; charset=utf-8'): RawResponse => ({ status: 200, headers: { 'content-type': type }, body: Buffer.from(body) });

  it('User-Agent jujur, robots.txt dibaca sekali, jeda antar permintaan', async () => {
    const { http, calls, sleeps } = client({
      'https://kalender.contoh.id/robots.txt': page('User-agent: *\nCrawl-delay: 8', 'text/plain'),
      'https://kalender.contoh.id/a': page('<html>a</html>'),
      'https://kalender.contoh.id/b': page('<html>b</html>'),
    });
    expect(await http.get('https://kalender.contoh.id/a', allow)).toBe('<html>a</html>');
    expect(await http.get('https://kalender.contoh.id/b', allow)).toBe('<html>b</html>');
    expect(calls.map((c) => c.url)).toEqual(['https://kalender.contoh.id/robots.txt', 'https://kalender.contoh.id/a', 'https://kalender.contoh.id/b']);
    expect(calls[0]!.ua).toBe('PaceTaraBot/1.0 (+https://pace.contoh.id/bot)');
    // Crawl-delay 8 detik > jeda bawaan 5 detik.
    expect(sleeps).toEqual([8000, 8000]);
  });

  it('robots.txt melarang → tidak diminta', async () => {
    const { http, calls } = client({
      'https://kalender.contoh.id/robots.txt': page('User-agent: PaceTaraBot\nDisallow: /lari', 'text/plain'),
      'https://kalender.contoh.id/lari': page('x'),
    });
    await expect(http.get('https://kalender.contoh.id/lari', allow)).rejects.toMatchObject({ code: 'robots_disallowed' });
    expect(calls.map((c) => c.url)).toEqual(['https://kalender.contoh.id/robots.txt']);
  });

  it('robots.txt 5xx = jangan scrape; 404 = boleh', async () => {
    const down = client({ 'https://kalender.contoh.id/robots.txt': { status: 503, headers: {}, body: Buffer.from('') }, 'https://kalender.contoh.id/a': page('x') });
    await expect(down.http.get('https://kalender.contoh.id/a', allow)).rejects.toMatchObject({ code: 'robots_disallowed' });
    const none = client({ 'https://kalender.contoh.id/a': page('ok') });
    expect(await none.http.get('https://kalender.contoh.id/a', allow)).toBe('ok');
  });

  it('redirect ke host lain ditolak; ke host sama diikuti', async () => {
    const { http } = client({
      'https://kalender.contoh.id/lama': { status: 301, headers: { location: '/baru' }, body: Buffer.from('') },
      'https://kalender.contoh.id/baru': page('baru'),
      'https://kalender.contoh.id/jahat': { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' }, body: Buffer.from('') },
      'https://kalender.contoh.id/http': { status: 302, headers: { location: 'http://kalender.contoh.id/x' }, body: Buffer.from('') },
    });
    expect(await http.get('https://kalender.contoh.id/lama', allow)).toBe('baru');
    await expect(http.get('https://kalender.contoh.id/jahat', allow)).rejects.toMatchObject({ code: 'redirect_other_host' });
    await expect(http.get('https://kalender.contoh.id/http', allow)).rejects.toMatchObject({ code: 'bad_url' });
  });

  it('jenis konten selain HTML/JSON dan status selain 200 ditolak', async () => {
    const { http } = client({
      'https://kalender.contoh.id/gambar': page('x', 'image/png'),
      'https://kalender.contoh.id/galat': { status: 500, headers: {}, body: Buffer.from('') },
    });
    await expect(http.get('https://kalender.contoh.id/gambar', allow)).rejects.toMatchObject({ code: 'bad_content_type' });
    await expect(http.get('https://kalender.contoh.id/galat', allow)).rejects.toMatchObject({ code: 'bad_status' });
  });
});

describe('konfigurasi sumber', () => {
  it('kosong = tidak ada sumber aktif (bawaan)', () => {
    expect(loadSources('')).toEqual([]);
  });

  it('valid, allowlist dari host URL, enabled:false dilewati', () => {
    const s = loadSources(
      JSON.stringify([
        { id: 'kalender-a', name: 'Kalender A', urls: ['https://a.contoh.id/lari', 'https://www.a.contoh.id/lari?p=2'] },
        { id: 'mati', name: 'Mati', urls: ['https://b.contoh.id/'], enabled: false },
      ]),
    );
    expect(s).toHaveLength(1);
    expect(s[0]!.parser).toBe('jsonld');
    expect([...s[0]!.allowedHosts]).toEqual(['a.contoh.id', 'www.a.contoh.id']);
  });

  it('menolak http, IP, id ganda, parser tak dikenal, JSON rusak', () => {
    expect(() => loadSources('[{"id":"a1","name":"A","urls":["http://a.id/x"]}]')).toThrow();
    expect(() => loadSources('[{"id":"a1","name":"A","urls":["https://10.0.0.1/x"]}]')).toThrow();
    expect(() => loadSources('[{"id":"a1","name":"AA","urls":["https://a.id/x"]},{"id":"a1","name":"BB","urls":["https://b.id/x"]}]')).toThrow(/ganda/);
    expect(() => loadSources('[{"id":"a1","name":"AA","urls":["https://a.id/x"],"parser":"xpath"}]')).toThrow();
    expect(() => loadSources('{bukan json')).toThrow(/JSON/);
  });
});
