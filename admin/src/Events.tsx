import { type FormEvent, useState } from 'react';
import { api } from './api';
import { useLoad } from './useLoad';

/**
 * Kalender event manual (modul 1.7): super admin memasukkan, mengubah, dan menghapus event.
 * Setiap perubahan tercatat di log tindakan. Event diarsipkan otomatis sehari setelah tanggalnya.
 */
export const CATEGORIES: Record<string, string> = {
  fun: 'Fun run',
  '5k': '5K',
  '10k': '10K',
  hm: 'Half marathon (21K)',
  fm: 'Full marathon (42K)',
  ultra: 'Ultra',
  other: 'Jarak lain',
};

type AdminEvent = {
  id: string;
  name: string;
  date: string;
  startTime: string | null;
  city: string;
  venue: string;
  description: string;
  categories: string[];
  registrationUrl: string;
  sourceName: string | null;
  sourceUrl: string | null;
  origin: 'admin' | 'scrape' | 'user';
  archived: boolean;
  goingCount: number;
  hidden: boolean;
  removed: boolean;
  createdBy: string | null;
  updatedAt: string;
};

export type Draft = Omit<AdminEvent, 'id' | 'archived' | 'goingCount' | 'hidden' | 'removed' | 'createdBy' | 'updatedAt' | 'origin'>;

const EMPTY: Draft = { name: '', date: '', startTime: null, city: '', venue: '', description: '', categories: [], registrationUrl: 'https://', sourceName: null, sourceUrl: null };

export const ORIGINS: Record<string, string> = { admin: 'Manual', scrape: 'Scraping', user: 'Kiriman penyelenggara' };

/** Body API dari draf: field opsional kosong dikirim sebagai null. */
export const draftBody = (d: Draft) => ({ ...d, startTime: d.startTime || null, sourceName: d.sourceName?.trim() || null, sourceUrl: d.sourceUrl?.trim() || null });

const fmtDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

export function Events() {
  const [scope, setScope] = useState<'upcoming' | 'past'>('upcoming');
  const [editing, setEditing] = useState<AdminEvent | 'new' | null>(null);
  const list = useLoad(() => api<AdminEvent[]>('GET', `/v1/admin/events?scope=${scope}`), [scope]);

  if (editing) {
    return (
      <EventForm
        event={editing === 'new' ? null : editing}
        onDone={() => {
          setEditing(null);
          list.reload();
        }}
      />
    );
  }

  return (
    <section className="card">
      <div className="row">
        <h2>Kalender event</h2>
        <div className="row">
          <select value={scope} onChange={(e) => setScope(e.target.value as 'upcoming' | 'past')}>
            <option value="upcoming">Mendatang</option>
            <option value="past">Sudah lewat (arsip)</option>
          </select>
          <button className="primary" onClick={() => setEditing('new')}>
            Tambah event
          </button>
        </div>
      </div>
      {list.error && <p className="bad">{list.error}</p>}
      {list.data?.length === 0 && <p className="muted">Belum ada event.</p>}
      <table>
        <thead>
          <tr>
            <th>Tanggal</th>
            <th>Nama</th>
            <th>Kota</th>
            <th>Kategori</th>
            <th>Asal</th>
            <th>Ikut</th>
          </tr>
        </thead>
        <tbody>
          {list.data?.map((e) => (
            <tr key={e.id} className="clickable" onClick={() => setEditing(e)}>
              <td>
                {fmtDate(e.date)}
                {e.startTime ? ` ${e.startTime}` : ''}
              </td>
              <td>
                {e.name}
                {e.removed && <em className="bad"> · diturunkan</em>}
                {!e.removed && e.hidden && <em className="bad"> · disembunyikan (laporan)</em>}
              </td>
              <td>{e.city}</td>
              <td>{e.categories.map((c) => CATEGORIES[c]?.split(' ')[0] ?? c).join(', ')}</td>
              <td>
                {ORIGINS[e.origin] ?? e.origin}
                {e.sourceName ? <span className="muted"> · {e.sourceName}</span> : null}
              </td>
              <td>{e.goingCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function EventForm({ event, onDone }: { event: AdminEvent | null; onDone: () => void }) {
  const [d, setD] = useState<Draft>(event ? toDraft(event) : EMPTY);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const toggle = (c: string) => set('categories', d.categories.includes(c) ? d.categories.filter((x) => x !== c) : [...d.categories, c]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (d.categories.length === 0) return setMsg('Pilih minimal satu kategori jarak');
    setBusy(true);
    setMsg(null);
    const body = draftBody(d);
    try {
      if (event) await api('PUT', `/v1/admin/events/${event.id}`, body);
      else await api('POST', '/v1/admin/events', body);
      onDone();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Gagal menyimpan');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!event || !window.confirm(`Hapus "${event.name}"? Tanda ikut dari pengguna ikut terhapus.`)) return;
    try {
      await api('DELETE', `/v1/admin/events/${event.id}`);
      onDone();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Gagal menghapus');
    }
  }

  return (
    <section className="card">
      <button className="link" onClick={onDone}>
        ← Kembali
      </button>
      <h2>{event ? 'Ubah event' : 'Tambah event'}</h2>
      {event && (
        <p className="muted">
          {event.goingCount} pengguna menandai ikut · dibuat oleh {event.createdBy ?? '–'}
          {event.archived ? ' · sudah diarsipkan' : ''}
        </p>
      )}
      <form className="stack" onSubmit={save}>
        <label>
          Nama event
          <input required minLength={3} maxLength={120} value={d.name} onChange={(e) => set('name', e.target.value)} />
        </label>
        <div className="grid2">
          <label>
            Tanggal
            <input type="date" required value={d.date} onChange={(e) => set('date', e.target.value)} />
          </label>
          <label>
            Jam mulai (opsional, waktu setempat)
            <input type="time" value={d.startTime ?? ''} onChange={(e) => set('startTime', e.target.value || null)} />
          </label>
          <label>
            Kota
            <input required minLength={2} maxLength={60} value={d.city} onChange={(e) => set('city', e.target.value)} />
          </label>
          <label>
            Lokasi (opsional)
            <input maxLength={160} value={d.venue} onChange={(e) => set('venue', e.target.value)} />
          </label>
        </div>
        <fieldset className="checks">
          <legend>Kategori jarak</legend>
          {Object.entries(CATEGORIES).map(([k, label]) => (
            <label key={k} className="check">
              <input type="checkbox" checked={d.categories.includes(k)} onChange={() => toggle(k)} />
              {label}
            </label>
          ))}
        </fieldset>
        <label>
          Tautan pendaftaran resmi (https)
          <input type="url" required pattern="https://.*" maxLength={500} value={d.registrationUrl} onChange={(e) => set('registrationUrl', e.target.value)} />
        </label>
        <SourceFields d={d} set={set} />
        <label>
          Deskripsi (opsional)
          <textarea rows={4} maxLength={2000} value={d.description} onChange={(e) => set('description', e.target.value)} />
        </label>
        {msg && <p className="bad">{msg}</p>}
        <div className="row">
          {event ? (
            <button type="button" className="danger" onClick={remove}>
              Hapus event
            </button>
          ) : (
            <span />
          )}
          <button className="primary" disabled={busy}>
            {busy ? 'Menyimpan…' : 'Simpan'}
          </button>
        </div>
      </form>
    </section>
  );
}

function toDraft(e: AdminEvent): Draft {
  return {
    name: e.name,
    date: e.date,
    startTime: e.startTime,
    city: e.city,
    venue: e.venue,
    description: e.description,
    categories: e.categories,
    registrationUrl: e.registrationUrl,
    sourceName: e.sourceName,
    sourceUrl: e.sourceUrl,
  };
}

/** Sumber dan halaman resmi: selalu ditampilkan di aplikasi ("Sumber: … · Lihat halaman resmi"). */
export function SourceFields({ d, set }: { d: Draft; set: <K extends keyof Draft>(k: K, v: Draft[K]) => void }) {
  return (
    <div className="grid2">
      <label>
        Nama sumber (kosong = "Tim PaceTara")
        <input maxLength={80} value={d.sourceName ?? ''} onChange={(e) => set('sourceName', e.target.value || null)} />
      </label>
      <label>
        Halaman resmi (https, kosong = tautan pendaftaran)
        <input type="url" pattern="https://.*" maxLength={500} value={d.sourceUrl ?? ''} onChange={(e) => set('sourceUrl', e.target.value || null)} />
      </label>
    </div>
  );
}
