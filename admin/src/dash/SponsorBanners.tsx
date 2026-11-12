import { type FormEvent, useEffect, useState } from 'react';
import { useLoad } from '../useLoad';
import { dash, DashError, dashImage } from './dashApi';
import { rupiah, startPayment } from './Dashboard';

/**
 * Banner sponsor swalayan (modul 3.3): unggah banner, pilih slot, kota sasaran, dan periode, bayar lewat Midtrans,
 * lalu pantau tayangan dan klik. Wajib akun Level 2 (verifikasi KTP di aplikasi).
 */
type Slot = 'home' | 'events' | 'event_detail';
type Config = { slots: { slot: Slot; perDay: number }[]; nationalFactor: number; maxDays: number; maxCities: number; size: { width: number; height: number }; paymentsEnabled: boolean };
type Banner = {
  id: string;
  slot: Slot;
  title: string;
  eventName: string | null;
  targetUrl: string | null;
  cities: string[];
  startsOn: string;
  endsOn: string;
  days: number;
  amount: number;
  status: string;
  state: string;
  rejectReason: string | null;
  impressions: number;
  clicks: number;
  imageUrl: string | null;
};
type EventItem = { id: string; name: string; date: string; city: string };

const SLOT: Record<Slot, string> = { home: 'Beranda aplikasi', events: 'Daftar event', event_detail: 'Halaman detail event' };
const STATE: Record<string, string> = {
  pending_payment: 'Menunggu pembayaran',
  pending_review: 'Menunggu persetujuan',
  rejected: 'Ditolak',
  scheduled: 'Disetujui, terjadwal',
  live: 'Sedang tayang',
  ended: 'Selesai',
};

export function SponsorBanners() {
  const cfg = useLoad(() => dash<Config>('GET', '/v1/sponsor/config'), []);
  const list = useLoad(() => dash<{ items: Banner[] }>('GET', '/v1/sponsor/banners'), []);
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [statsFor, setStatsFor] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>) {
    setMsg(null);
    try {
      await fn();
      list.reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Gagal');
    }
  }

  if (cfg.error) {
    return (
      <section className="card">
        <h2>Banner sponsor</h2>
        <p className="bad">{cfg.error}</p>
        <p className="muted">Sponsor wajib verifikasi KTP (Level 2) di aplikasi PaceTara: Profil → Verifikasi KTP.</p>
      </section>
    );
  }
  const c = cfg.data;
  return (
    <section className="card">
      <div className="row">
        <h2>Banner sponsor</h2>
        {c && !creating && (
          <button className="primary" onClick={() => setCreating(true)} disabled={!c.paymentsEnabled}>
            Pasang banner
          </button>
        )}
      </div>
      {c && (
        <p className="muted">
          Tarif per hari per kota: {c.slots.map((s) => `${SLOT[s.slot]} ${rupiah(s.perDay)}`).join(' · ')}. Nasional = {c.nationalFactor}× tarif harian. Ukuran {c.size.width}×{c.size.height} px
          (rasio 3:1). Banner tayang setelah disetujui tim PaceTara dan tidak ditampilkan ke pengguna Premium.
          {!c.paymentsEnabled && ' Pembayaran belum tersedia.'}
        </p>
      )}
      {creating && c && (
        <BannerForm
          cfg={c}
          onCancel={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            list.reload();
          }}
        />
      )}
      {msg && <p className="bad">{msg}</p>}
      {list.error && <p className="bad">{list.error}</p>}
      {list.data?.items.length === 0 && <p className="muted">Belum ada banner.</p>}
      <ul className="list">
        {list.data?.items.map((b) => (
          <li key={b.id}>
            <div className="row">
              <strong>{b.title}</strong>
              <span>{STATE[b.state] ?? b.state}</span>
            </div>
            <div className="muted">
              {SLOT[b.slot]} · {b.cities.length ? b.cities.join(', ') : 'Nasional'} · {b.startsOn} s.d. {b.endsOn} · {rupiah(b.amount)}
              {b.eventName && ` · Event: ${b.eventName}`}
            </div>
            {b.imageUrl && <DashBannerImage path={b.imageUrl} />}
            {b.rejectReason && <p className="quote">Alasan penolakan: {b.rejectReason}</p>}
            <div className="row">
              <span>
                {b.impressions.toLocaleString('id-ID')} tayangan · {b.clicks.toLocaleString('id-ID')} klik
              </span>
              <span>
                {b.status === 'pending_payment' && (
                  <>
                    <button className="primary" onClick={() => void act(() => startPayment(`/v1/sponsor/banners/${b.id}/pay`, {}))}>
                      Bayar
                    </button>{' '}
                    <button onClick={() => void act(() => dash('DELETE', `/v1/sponsor/banners/${b.id}`))}>Batalkan</button>
                  </>
                )}
                {b.status === 'approved' && <button onClick={() => setStatsFor(statsFor === b.id ? null : b.id)}>Statistik harian</button>}
              </span>
            </div>
            {statsFor === b.id && <BannerStats id={b.id} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function DashBannerImage({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    dashImage(path)
      .then((u) => {
        url = u;
        setSrc(u);
      })
      .catch(() => setSrc(null));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);
  return src ? <img className="reported-photo" src={src} alt="Banner" /> : null;
}

function BannerStats({ id }: { id: string }) {
  const s = useLoad(() => dash<{ days: { day: string; impressions: number; clicks: number }[]; totals: { impressions: number; clicks: number; ctr: number } }>('GET', `/v1/sponsor/banners/${id}/stats`), [id]);
  if (s.error) return <p className="bad">{s.error}</p>;
  if (!s.data) return <p className="muted">Memuat…</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Tanggal (WIB)</th>
          <th>Tayangan</th>
          <th>Klik</th>
        </tr>
      </thead>
      <tbody>
        {s.data.days.map((d) => (
          <tr key={d.day}>
            <td>{d.day}</td>
            <td>{d.impressions}</td>
            <td>{d.clicks}</td>
          </tr>
        ))}
        <tr>
          <th>Total</th>
          <th>{s.data.totals.impressions}</th>
          <th>
            {s.data.totals.clicks} (CTR {s.data.totals.ctr}%)
          </th>
        </tr>
      </tbody>
    </table>
  );
}

function BannerForm({ cfg, onCancel, onDone }: { cfg: Config; onCancel: () => void; onDone: () => void }) {
  const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
  const [slot, setSlot] = useState<Slot>('home');
  const [title, setTitle] = useState('');
  const [link, setLink] = useState<'none' | 'event' | 'url'>('none');
  const [eventId, setEventId] = useState('');
  const [url, setUrl] = useState('');
  const [cities, setCities] = useState('');
  const [startsOn, setStartsOn] = useState(today);
  const [days, setDays] = useState(7);
  const [file, setFile] = useState<File | null>(null);
  const [quote, setQuote] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const events = useLoad(() => dash<{ items: EventItem[] }>('GET', '/v1/events?limit=50'), []);
  const cityList = cities
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const needsEvent = slot === 'event_detail';

  useEffect(() => {
    let alive = true;
    dash<{ amount: number }>('POST', '/v1/sponsor/quote', { slot, days, cities: Math.min(cityList.length, cfg.maxCities) })
      .then((q) => alive && setQuote(q.amount))
      .catch(() => alive && setQuote(null));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot, days, cityList.length]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!file) return setError('Pilih gambar banner');
    const useEvent = needsEvent || link === 'event';
    if (useEvent && !eventId) return setError('Pilih event');
    setBusy(true);
    try {
      const form = new FormData();
      form.append(
        'data',
        JSON.stringify({
          slot,
          title: title.trim(),
          cities: cityList,
          startsOn,
          days,
          ...(useEvent ? { eventId } : {}),
          ...(!useEvent && link === 'url' ? { targetUrl: url.trim() } : {}),
        }),
      );
      form.append('image', file);
      const created = await dash<{ id: string }>('POST', '/v1/sponsor/banners', form);
      onDone();
      await startPayment(`/v1/sponsor/banners/${created.id}/pay`, {});
    } catch (err) {
      setError(err instanceof DashError || err instanceof Error ? err.message : 'Gagal');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <div className="grid2">
        <label>
          Slot
          <select value={slot} onChange={(e) => setSlot(e.target.value as Slot)}>
            {cfg.slots.map((s) => (
              <option key={s.slot} value={s.slot}>
                {SLOT[s.slot]} ({rupiah(s.perDay)}/hari/kota)
              </option>
            ))}
          </select>
        </label>
        <label>
          Judul (teks alternatif)
          <input value={title} onChange={(e) => setTitle(e.target.value)} minLength={3} maxLength={80} required />
        </label>
        <label>
          Kota sasaran (pisahkan koma; kosong = nasional)
          <input value={cities} onChange={(e) => setCities(e.target.value)} placeholder="Bandung, Jakarta Selatan" />
        </label>
        <label>
          Mulai (WIB)
          <input type="date" value={startsOn} min={today} onChange={(e) => setStartsOn(e.target.value)} required />
        </label>
        <label>
          Lama tayang (hari)
          <input type="number" min={1} max={cfg.maxDays} value={days} onChange={(e) => setDays(Math.max(1, Math.min(cfg.maxDays, Number(e.target.value) || 1)))} />
        </label>
        <label>
          Gambar ({cfg.size.width}×{cfg.size.height} px, JPG/PNG/WebP)
          <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
      </div>
      {!needsEvent && (
        <label>
          Saat banner diketuk
          <select value={link} onChange={(e) => setLink(e.target.value as 'none' | 'event' | 'url')}>
            <option value="none">Tidak membuka apa pun</option>
            <option value="event">Buka event di kalender PaceTara</option>
            <option value="url">Buka tautan https</option>
          </select>
        </label>
      )}
      {(needsEvent || link === 'event') && (
        <label>
          Event {needsEvent && '(banner tampil di halaman event ini)'}
          <select value={eventId} onChange={(e) => setEventId(e.target.value)}>
            <option value="">Pilih event…</option>
            {events.data?.items.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.name} · {ev.date} · {ev.city}
              </option>
            ))}
          </select>
        </label>
      )}
      {!needsEvent && link === 'url' && (
        <label>
          Tautan (https://…)
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} required />
        </label>
      )}
      <p>
        Total: <strong>{quote === null ? '…' : rupiah(quote)}</strong> {cityList.length > cfg.maxCities && <span className="bad">Maksimal {cfg.maxCities} kota</span>}
      </p>
      {error && <p className="bad">{error}</p>}
      <div className="row">
        <button type="button" onClick={onCancel}>
          Batal
        </button>
        <button className="primary" disabled={busy}>
          {busy ? 'Memproses…' : 'Simpan dan bayar'}
        </button>
      </div>
      <p className="muted">Biaya tidak dikembalikan otomatis bila banner ditolak; tim PaceTara memproses refund lewat Midtrans.</p>
    </form>
  );
}
