import { type FormEvent, useState } from 'react';
import { api } from './api';
import { CATEGORIES, type Draft, draftBody, ORIGINS, SourceFields } from './Events';
import { useLoad } from './useLoad';

/**
 * Antrean event (modul 2.4): hasil scraping dan kiriman penyelenggara baru tayang setelah disetujui di sini.
 * Aksi: setujui (boleh dikoreksi dulu), tolak dengan alasan, atau gabung ke event yang sudah ada.
 * Setiap aksi dan setiap pembukaan kontak penyelenggara tercatat di log tindakan.
 */
type Status = 'pending' | 'approved' | 'rejected' | 'merged';

type Dup = { kind: 'event' | 'submission'; id: string; name: string; date: string; city: string; reason: 'same_url' | 'similar_name' };

type Submission = {
  id: string;
  origin: 'scrape' | 'user';
  sourceId: string | null;
  status: Status;
  name: string;
  date: string;
  startTime: string | null;
  city: string;
  venue: string;
  description: string;
  categories: string[];
  registrationUrl: string;
  sourceName: string;
  sourceUrl: string;
  hasContact: boolean;
  eventId: string | null;
  rejectReason: string | null;
  submittedBy: { id: string; displayName: string | null } | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  duplicates: Dup[];
};

type Sources = {
  userAgent: string;
  sources: {
    id: string;
    name: string;
    urls: string[];
    parser: string;
    lastRun: { startedAt: string; finishedAt: string | null; pages: number; found: number; created: number; updated: number; skipped: number; errors: string[] } | null;
  }[];
};

const STATUS: Record<Status, string> = { pending: 'Menunggu', approved: 'Disetujui', rejected: 'Ditolak', merged: 'Digabung' };
const DUP_REASON: Record<Dup['reason'], string> = { same_url: 'tautan sama', similar_name: 'nama mirip, tanggal & kota berdekatan' };
const fmtDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('id-ID') : '–');

export function EventQueue() {
  const [status, setStatus] = useState<Status>('pending');
  const [selected, setSelected] = useState<Submission | null>(null);
  const list = useLoad(() => api<Submission[]>('GET', `/v1/admin/event-submissions?status=${status}`), [status]);

  if (selected) {
    return (
      <SubmissionDetail
        sub={selected}
        onDone={() => {
          setSelected(null);
          list.reload();
        }}
      />
    );
  }

  return (
    <>
      <section className="card">
        <div className="row">
          <h2>Antrean event</h2>
          <select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
            {Object.entries(STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <p className="muted">Kiriman di sini belum terlihat pengguna. Event tayang setelah disetujui; duplikat sebaiknya digabung.</p>
        {list.error && <p className="bad">{list.error}</p>}
        {list.data?.length === 0 && <p className="muted">Antrean kosong.</p>}
        <table>
          <thead>
            <tr>
              <th>Tanggal</th>
              <th>Nama</th>
              <th>Kota</th>
              <th>Asal</th>
              <th>{status === 'pending' ? 'Duplikat?' : 'Ditinjau'}</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((s) => (
              <tr key={s.id} className="clickable" onClick={() => setSelected(s)}>
                <td>{fmtDate(s.date)}</td>
                <td>{s.name}</td>
                <td>{s.city || <em className="bad">kosong</em>}</td>
                <td>
                  {ORIGINS[s.origin]} <span className="muted">· {s.sourceName}</span>
                </td>
                <td>{status === 'pending' ? (s.duplicates.length ? <strong className="bad">{s.duplicates.length} kandidat</strong> : '–') : `${fmt(s.reviewedAt)} · ${s.reviewedBy ?? 'otomatis'}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <SourcesCard />
    </>
  );
}

function SourcesCard() {
  const src = useLoad(() => api<Sources>('GET', '/v1/admin/event-sources'), []);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  async function runNow() {
    setBusy(true);
    setNote(null);
    try {
      await api('POST', '/v1/admin/event-sources/run');
      setNote('Putaran dijalankan di latar belakang. Muat ulang beberapa menit lagi untuk melihat hasilnya.');
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Gagal menjalankan');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <h2>Sumber scraping</h2>
      {src.error && <p className="bad">{src.error}</p>}
      {src.data && src.data.sources.length > 0 && (
        <p>
          <button disabled={busy} onClick={runNow}>
            Jalankan sekarang
          </button>{' '}
          <button className="link" onClick={src.reload}>
            Muat ulang
          </button>{' '}
          <span className="muted">Maks. sekali per 15 menit agar situs sumber tidak terbebani.</span>
        </p>
      )}
      {note && <p className="muted">{note}</p>}
      {src.data && src.data.sources.length === 0 && (
        <p className="muted">
          Belum ada sumber aktif. Sumber ditambahkan pemilik lewat <code>EVENT_SCRAPE_SOURCES</code> di <code>.env</code> setelah memeriksa ketentuan layanan dan robots.txt
          situsnya (lihat README).
        </p>
      )}
      {src.data && src.data.sources.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Sumber</th>
              <th>Halaman</th>
              <th>Putaran terakhir</th>
            </tr>
          </thead>
          <tbody>
            {src.data.sources.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.name} <span className="muted mono">({s.id}, {s.parser})</span>
                </td>
                <td className="mono">{s.urls.join('\n')}</td>
                <td>
                  {s.lastRun ? (
                    <>
                      {fmt(s.lastRun.finishedAt)}: {s.lastRun.pages}/{s.urls.length} halaman, {s.lastRun.found} event, {s.lastRun.created} baru, {s.lastRun.updated} diperbarui
                      {s.lastRun.errors.map((e) => (
                        <div key={e} className="bad">
                          {e}
                        </div>
                      ))}
                    </>
                  ) : (
                    'belum pernah'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {src.data && <p className="muted mono">User-Agent: {src.data.userAgent}</p>}
    </section>
  );
}

function SubmissionDetail({ sub, onDone }: { sub: Submission; onDone: () => void }) {
  const pending = sub.status === 'pending';
  const [d, setD] = useState<Draft>({
    name: sub.name,
    date: sub.date,
    startTime: sub.startTime,
    city: sub.city,
    venue: sub.venue,
    description: sub.description,
    categories: sub.categories,
    registrationUrl: sub.registrationUrl,
    sourceName: sub.sourceName,
    sourceUrl: sub.sourceUrl,
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [contact, setContact] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const toggle = (c: string) => set('categories', d.categories.includes(c) ? d.categories.filter((x) => x !== c) : [...d.categories, c]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      onDone();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Gagal');
    } finally {
      setBusy(false);
    }
  }

  function approve(e: FormEvent) {
    e.preventDefault();
    if (d.categories.length === 0) return setMsg('Pilih minimal satu kategori jarak');
    void run(() => api('POST', `/v1/admin/event-submissions/${sub.id}/approve`, draftBody(d)));
  }

  function reject() {
    const reason = window.prompt('Alasan penolakan (dikirim ke pengirim):');
    if (!reason) return;
    void run(() => api('POST', `/v1/admin/event-submissions/${sub.id}/reject`, { reason }));
  }

  function merge(eventId: string, name: string) {
    if (!window.confirm(`Gabungkan kiriman ini ke "${name}"? Kiriman tidak akan tayang sebagai event terpisah.`)) return;
    void run(() => api('POST', `/v1/admin/event-submissions/${sub.id}/merge`, { eventId }));
  }

  async function showContact() {
    try {
      const r = await api<{ contact: string | null }>('GET', `/v1/admin/event-submissions/${sub.id}/contact`);
      setContact(r.contact ?? '(tidak ada)');
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Gagal membuka kontak');
    }
  }

  return (
    <section className="card">
      <button className="link" onClick={onDone}>
        ← Kembali
      </button>
      <h2>{sub.name}</h2>
      <p className="muted">
        {STATUS[sub.status]} · {ORIGINS[sub.origin]}
        {sub.sourceId ? ` (${sub.sourceId})` : ''} · masuk {fmt(sub.createdAt)}
        {sub.updatedAt !== sub.createdAt ? ` · diperbarui ${fmt(sub.updatedAt)}` : ''}
        {sub.submittedBy ? ` · dikirim ${sub.submittedBy.displayName ?? 'Pengguna dihapus'}` : sub.origin === 'user' ? ' · pengirim sudah menghapus akun' : ''}
      </p>
      <p>
        Sumber: <strong>{sub.sourceName}</strong> ·{' '}
        <a href={sub.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">
          Lihat halaman resmi
        </a>
      </p>
      {sub.origin === 'user' && sub.hasContact && (
        <p>
          Kontak penyelenggara:{' '}
          {contact ? (
            <span className="mono">{contact}</span>
          ) : (
            <button className="link" onClick={showContact}>
              Tampilkan (tercatat di log)
            </button>
          )}
        </p>
      )}
      {sub.rejectReason && <p className="bad">Alasan ditolak: {sub.rejectReason}</p>}
      {sub.eventId && <p className="muted">Event: {sub.eventId}</p>}

      {pending && sub.duplicates.length > 0 && (
        <div className="card">
          <h3>Kemungkinan duplikat</h3>
          <ul className="list">
            {sub.duplicates.map((x) => (
              <li key={`${x.kind}-${x.id}`}>
                {x.kind === 'event' ? 'Event tayang' : 'Kiriman menunggu'}: <strong>{x.name}</strong> · {fmtDate(x.date)} · {x.city || '–'} <span className="muted">({DUP_REASON[x.reason]})</span>{' '}
                {x.kind === 'event' && (
                  <button disabled={busy} onClick={() => merge(x.id, x.name)}>
                    Gabung ke event ini
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="muted">Kiriman menunggu yang duplikat: setujui salah satu, lalu gabungkan yang lain ke event hasilnya.</p>
        </div>
      )}

      {pending ? (
        <form className="stack" onSubmit={approve}>
          <p className="muted">Periksa dan koreksi sebelum menyetujui. Pastikan tautan pendaftaran resmi.</p>
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
              Jam mulai (opsional)
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
            Deskripsi
            <textarea rows={4} maxLength={2000} value={d.description} onChange={(e) => set('description', e.target.value)} />
          </label>
          {msg && <p className="bad">{msg}</p>}
          <div className="row">
            <button type="button" className="danger" disabled={busy} onClick={reject}>
              Tolak…
            </button>
            <button className="primary" disabled={busy}>
              {busy ? 'Memproses…' : 'Setujui dan tayangkan'}
            </button>
          </div>
        </form>
      ) : (
        msg && <p className="bad">{msg}</p>
      )}
    </section>
  );
}
