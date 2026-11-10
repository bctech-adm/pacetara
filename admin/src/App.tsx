import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useLoad } from './useLoad';
import { api, ApiError, hasStoredSession, login, logout, setLogoutHandler } from './api';
import { Events } from './Events';

/**
 * Panel super admin (modul 1.8): login dengan kata sandi + kode authenticator, antrean laporan,
 * banding, tindakan akun, log tindakan, dan input event manual (modul 1.7). Dasbor sponsor menyusul di 3.3.
 */
type Tab = 'reports' | 'events' | 'appeals' | 'users' | 'audit';

const REASONS: Record<string, string> = {
  spam: 'Spam',
  harassment: 'Pelecehan/perundungan',
  hate: 'Ujaran kebencian',
  sexual: 'Konten seksual',
  violence: 'Kekerasan',
  scam: 'Penipuan',
  impersonation: 'Menyamar',
  other: 'Lainnya',
};
const TARGETS: Record<string, string> = { message: 'Pesan', community: 'Komunitas', user: 'Pengguna', event: 'Event' };
const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('id-ID') : '–');

export function App() {
  const [authed, setAuthed] = useState(hasStoredSession());
  const [tab, setTab] = useState<Tab>('reports');

  useEffect(() => setLogoutHandler(() => setAuthed(false)), []);

  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return (
    <main className="shell wide">
      <header className="topbar">
        <h1>PaceTara Admin</h1>
        <nav>
          {(['reports', 'events', 'appeals', 'users', 'audit'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
              {{ reports: 'Laporan', events: 'Event', appeals: 'Banding', users: 'Pengguna', audit: 'Log' }[t]}
            </button>
          ))}
          <button
            className="tab"
            onClick={async () => {
              await logout();
              setAuthed(false);
            }}
          >
            Keluar
          </button>
        </nav>
      </header>
      {tab === 'reports' && <Reports />}
      {tab === 'events' && <Events />}
      {tab === 'appeals' && <Appeals />}
      {tab === 'users' && <Users />}
      {tab === 'audit' && <Audit />}
    </main>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password, code);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Tidak bisa menghubungi server');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell narrow">
      <h1>PaceTara Admin</h1>
      <form className="card stack" onSubmit={submit}>
        <label>
          Email
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Kata sandi
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label>
          Kode authenticator (6 digit)
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
        </label>
        {error && <p className="bad">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? 'Memeriksa…' : 'Masuk'}
        </button>
      </form>
    </main>
  );
}

// ---------- Laporan ----------

type QueueItem = {
  targetType: string;
  targetId: string;
  label: string;
  reports: number;
  reporters: number;
  reasons: string[];
  statuses: string[];
  firstAt: string;
  lastAt: string;
};

function Reports() {
  const [status, setStatus] = useState<'open' | 'closed'>('open');
  const [selected, setSelected] = useState<QueueItem | null>(null);
  const queue = useLoad(() => api<QueueItem[]>('GET', `/v1/admin/reports?status=${status}`), [status]);

  if (selected) {
    return (
      <ReportDetail
        item={selected}
        onBack={() => {
          setSelected(null);
          queue.reload();
        }}
      />
    );
  }
  return (
    <section className="card">
      <div className="row">
        <h2>Antrean laporan</h2>
        <select value={status} onChange={(e) => setStatus(e.target.value as 'open' | 'closed')}>
          <option value="open">Terbuka</option>
          <option value="closed">Selesai (30 hari)</option>
        </select>
      </div>
      {queue.error && <p className="bad">{queue.error}</p>}
      {queue.data?.length === 0 && <p className="muted">Tidak ada laporan.</p>}
      <table>
        <thead>
          <tr>
            <th>Jenis</th>
            <th>Sasaran</th>
            <th>Pelapor</th>
            <th>Alasan</th>
            <th>Terakhir</th>
          </tr>
        </thead>
        <tbody>
          {queue.data?.map((q) => (
            <tr key={`${q.targetType}:${q.targetId}`} className="clickable" onClick={() => setSelected(q)}>
              <td>{TARGETS[q.targetType] ?? q.targetType}</td>
              <td>{q.label}</td>
              <td>{q.reporters}</td>
              <td>{q.reasons.map((r) => REASONS[r] ?? r).join(', ')}</td>
              <td>{fmt(q.lastAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

type ContextMessage = {
  id: string;
  isReported: boolean;
  kind: string;
  text: string | null;
  hasImage: boolean;
  deleted: boolean;
  removedByAdmin: boolean;
  hidden: boolean;
  createdAt: string;
  sender: { id: string; displayName: string };
};
type Detail = {
  targetType: string;
  targetId: string;
  target: Record<string, unknown> | null;
  reports: { id: string; reason: string; details: string | null; status: string; createdAt: string; reporter: { displayName: string } }[];
};

function ReportDetail({ item, onBack }: { item: QueueItem; onBack: () => void }) {
  const detail = useLoad(() => api<Detail>('GET', `/v1/admin/reports/${item.targetType}/${item.targetId}`), [item]);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const open = detail.data?.reports.some((r) => r.status === 'open');

  async function resolve(action: 'dismiss' | 'remove') {
    const label = action === 'remove' ? 'Turunkan konten ini?' : 'Abaikan semua laporan terbuka?';
    if (!window.confirm(label)) return;
    try {
      await api('POST', `/v1/admin/reports/${item.targetType}/${item.targetId}/resolve`, { action, note: note || undefined });
      onBack();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Gagal');
    }
  }

  const t = detail.data?.target;
  return (
    <section className="card">
      <button className="link" onClick={onBack}>
        ← Kembali
      </button>
      <h2>
        {TARGETS[item.targetType]}: {item.label}
      </h2>
      {detail.error && <p className="bad">{detail.error}</p>}
      {t && item.targetType === 'message' && <Conversation ctx={t as { conversation: { kind: string; communityName: string | null }; messages: ContextMessage[] }} />}
      {t && item.targetType === 'community' && (
        <dl>
          <dt>Nama</dt>
          <dd>{String(t.name)}</dd>
          <dt>Kota</dt>
          <dd>{String(t.city)}</dd>
          <dt>Deskripsi</dt>
          <dd>{String(t.description) || '–'}</dd>
          <dt>Anggota</dt>
          <dd>{String(t.memberCount)}</dd>
          <dt>Pemilik</dt>
          <dd>{(t.owner as { displayName: string }).displayName}</dd>
          <dt>Status</dt>
          <dd>{t.removed ? 'Diturunkan' : t.hidden ? 'Disembunyikan otomatis' : 'Tampil'}</dd>
        </dl>
      )}
      {t && item.targetType === 'event' && (
        <dl>
          <dt>Nama</dt>
          <dd>{String(t.name)}</dd>
          <dt>Tanggal</dt>
          <dd>{String(t.date)}</dd>
          <dt>Kota</dt>
          <dd>{String(t.city)}</dd>
          <dt>Lokasi</dt>
          <dd>{String(t.venue) || '–'}</dd>
          <dt>Tautan</dt>
          <dd className="mono">{String(t.registrationUrl)}</dd>
          <dt>Deskripsi</dt>
          <dd>{String(t.description) || '–'}</dd>
          <dt>Status</dt>
          <dd>{t.removed ? 'Diturunkan' : t.hidden ? 'Disembunyikan otomatis' : 'Tampil'}</dd>
        </dl>
      )}
      {t && item.targetType === 'user' && <UserCard user={t as unknown as UserSummary} onChanged={detail.reload} />}

      <h3>Laporan ({detail.data?.reports.length ?? 0})</h3>
      <ul className="list">
        {detail.data?.reports.map((r) => (
          <li key={r.id}>
            <strong>{REASONS[r.reason] ?? r.reason}</strong> · {r.reporter.displayName} · {fmt(r.createdAt)} · {r.status}
            {r.details && <p className="quote">{r.details}</p>}
          </li>
        ))}
      </ul>
      {open && (
        <div className="stack">
          <label>
            Catatan (opsional, masuk log)
            <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="row">
            <button onClick={() => resolve('dismiss')}>Abaikan laporan</button>
            {item.targetType !== 'user' && (
              <button className="danger" onClick={() => resolve('remove')}>
                Turunkan konten
              </button>
            )}
          </div>
          {msg && <p className="bad">{msg}</p>}
        </div>
      )}
    </section>
  );
}

function Conversation({ ctx }: { ctx: { conversation: { kind: string; communityName: string | null }; messages: ContextMessage[] } }) {
  return (
    <>
      <p className="muted">
        {ctx.conversation.kind === 'community' ? `Chat komunitas ${ctx.conversation.communityName ?? ''}` : 'Chat pribadi'} · konteks di sekitar
        pesan yang dilaporkan. Membuka halaman ini tercatat di log.
      </p>
      <ol className="chat">
        {ctx.messages.map((m) => (
          <li key={m.id} className={m.isReported ? 'reported' : ''}>
            <span className="muted">
              {fmt(m.createdAt)} · {m.sender.displayName}
            </span>
            <div>
              {m.deleted
                ? m.removedByAdmin
                  ? '(diturunkan admin)'
                  : '(dihapus pengirim)'
                : m.kind === 'image'
                  ? m.hasImage
                    ? '(gambar)'
                    : '(gambar kedaluwarsa)'
                  : m.text}
              {m.hidden && <em> · disembunyikan otomatis</em>}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

// ---------- Pengguna ----------

type UserSummary = {
  id: string;
  displayName: string;
  city: string | null;
  status: string;
  role: string;
  verificationLevel: number;
  suspendedUntil: string | null;
  createdAt: string;
  openReports: number;
  communities: number;
};

function UserCard({ user, onChanged }: { user: UserSummary; onChanged: () => void }) {
  const [reason, setReason] = useState('');
  const [days, setDays] = useState('7');
  const [msg, setMsg] = useState<string | null>(null);

  async function act(path: string, body: Record<string, unknown>, confirmText: string) {
    if (reason.trim().length < 3) return setMsg('Tulis alasan (minimal 3 karakter)');
    if (!window.confirm(confirmText)) return;
    try {
      await api('POST', `/v1/admin/users/${user.id}/${path}`, { ...body, reason });
      setMsg('Tersimpan');
      setReason('');
      onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Gagal');
    }
  }

  return (
    <div className="stack">
      <dl>
        <dt>Nama</dt>
        <dd>{user.displayName}</dd>
        <dt>Kota</dt>
        <dd>{user.city ?? '–'}</dd>
        <dt>Status</dt>
        <dd className={user.status === 'active' ? 'good' : 'bad'}>
          {user.status}
          {user.suspendedUntil ? ` sampai ${fmt(user.suspendedUntil)}` : ''}
        </dd>
        <dt>Level verifikasi</dt>
        <dd>{user.verificationLevel}</dd>
        <dt>Komunitas</dt>
        <dd>{user.communities}</dd>
        <dt>Laporan terbuka</dt>
        <dd>{user.openReports}</dd>
        <dt>Bergabung</dt>
        <dd>{fmt(user.createdAt)}</dd>
      </dl>
      {user.role !== 'super_admin' && user.status !== 'deleted' && (
        <>
          <label>
            Alasan (masuk log)
            <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="row">
            {user.status === 'active' ? (
              <>
                <select value={days} onChange={(e) => setDays(e.target.value)}>
                  <option value="1">1 hari</option>
                  <option value="7">7 hari</option>
                  <option value="30">30 hari</option>
                  <option value="none">Tanpa batas</option>
                </select>
                <button onClick={() => act('suspend', { days: days === 'none' ? null : Number(days) }, `Tangguhkan ${user.displayName}?`)}>Tangguhkan</button>
                <button className="danger" onClick={() => act('ban', {}, `Blokir permanen ${user.displayName}?`)}>
                  Blokir
                </button>
              </>
            ) : (
              <button onClick={() => act('reinstate', {}, `Pulihkan akun ${user.displayName}?`)}>Pulihkan akun</button>
            )}
          </div>
        </>
      )}
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}

function Users() {
  const [email, setEmail] = useState('');
  const [user, setUser] = useState<UserSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function find(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    try {
      setUser(await api<UserSummary>('POST', '/v1/admin/users/lookup', { email }));
    } catch (err) {
      setUser(null);
      setError(err instanceof Error ? err.message : 'Gagal');
    }
  }

  return (
    <section className="card stack">
      <h2>Cari pengguna</h2>
      <p className="muted">Pencarian hanya dengan email lengkap (email disimpan terenkripsi). Setiap pencarian tercatat di log.</p>
      <form className="row" onSubmit={find}>
        <input type="email" required placeholder="email@contoh.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="primary">Cari</button>
      </form>
      {error && <p className="bad">{error}</p>}
      {user && <UserCard user={user} onChanged={() => void find()} />}
    </section>
  );
}

// ---------- Banding ----------

type Appeal = {
  id: string;
  user: { id: string; displayName: string; status: string; suspendedUntil: string | null };
  message: string;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
};

function Appeals() {
  const [status, setStatus] = useState<'open' | 'closed'>('open');
  const list = useLoad(() => api<Appeal[]>('GET', `/v1/admin/appeals?status=${status}`), [status]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);

  async function decide(a: Appeal, accept: boolean) {
    const note = (notes[a.id] ?? '').trim();
    if (note.length < 3) return setMsg('Tulis catatan keputusan (minimal 3 karakter)');
    if (!window.confirm(accept ? `Terima banding dan pulihkan ${a.user.displayName}?` : 'Tolak banding?')) return;
    try {
      await api('POST', `/v1/admin/appeals/${a.id}/decide`, { accept, note });
      setMsg(null);
      list.reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Gagal');
    }
  }

  return (
    <section className="card">
      <div className="row">
        <h2>Banding akun</h2>
        <select value={status} onChange={(e) => setStatus(e.target.value as 'open' | 'closed')}>
          <option value="open">Menunggu</option>
          <option value="closed">Sudah diputuskan</option>
        </select>
      </div>
      {list.error && <p className="bad">{list.error}</p>}
      {msg && <p className="bad">{msg}</p>}
      {list.data?.length === 0 && <p className="muted">Tidak ada banding.</p>}
      <ul className="list">
        {list.data?.map((a) => (
          <li key={a.id} className="stack">
            <div>
              <strong>{a.user.displayName}</strong> · {a.user.status}
              {a.user.suspendedUntil ? ` sampai ${fmt(a.user.suspendedUntil)}` : ''} · diajukan {fmt(a.createdAt)}
            </div>
            <p className="quote">{a.message}</p>
            {a.status === 'open' ? (
              <div className="row">
                <input placeholder="Catatan keputusan" value={notes[a.id] ?? ''} onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })} />
                <button onClick={() => decide(a, false)}>Tolak</button>
                <button className="primary" onClick={() => decide(a, true)}>
                  Terima
                </button>
              </div>
            ) : (
              <p className="muted">
                {a.status === 'accepted' ? 'Diterima' : 'Ditolak'} {fmt(a.decidedAt)}: {a.decisionNote}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- Log ----------

type AuditRow = {
  id: string;
  actor: { displayName: string | null } | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

function Audit() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const load = useCallback(async (before?: string) => {
    try {
      const page = await api<AuditRow[]>('GET', `/v1/admin/audit${before ? `?before=${before}` : ''}`);
      setRows((r) => (before ? [...r, ...page] : page));
      setDone(page.length < 100);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="card">
      <h2>Log tindakan admin</h2>
      <p className="muted">Log hanya bisa ditambah; tidak bisa diubah atau dihapus.</p>
      {error && <p className="bad">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Waktu</th>
            <th>Pelaku</th>
            <th>Tindakan</th>
            <th>Sasaran</th>
            <th>Rincian</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{fmt(r.createdAt)}</td>
              <td>{r.actor?.displayName ?? 'CLI'}</td>
              <td>{r.action}</td>
              <td>{r.targetType ? `${r.targetType}:${r.targetId?.slice(0, 8)}` : '–'}</td>
              <td className="mono">{Object.keys(r.metadata).length ? JSON.stringify(r.metadata) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!done && rows.length > 0 && <button onClick={() => load(rows.at(-1)!.id)}>Muat lebih lama</button>}
    </section>
  );
}
