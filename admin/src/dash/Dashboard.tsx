import { type FormEvent, useEffect, useState } from 'react';
import { useLoad } from '../useLoad';
import { dash, DashError, dashLogin, dashLogout, hasDashSession, setDashLogoutHandler } from './dashApi';

/**
 * Dasbor swalayan penjual & sponsor (modul 3.2/3.3) di /dasbor. Layanan digital PaceTara (biaya pasang listing,
 * boost, banner sponsor) dibayar di sini lewat Midtrans, bukan di aplikasi Android (REVIEW-PRD C1).
 */
type Tab = 'listings' | 'payments';

export const rupiah = (n: number) => `Rp${n.toLocaleString('id-ID')}`;
export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('id-ID') : '–');

export function Dashboard() {
  const [authed, setAuthed] = useState(hasDashSession());
  const [tab, setTab] = useState<Tab>('listings');
  const paid = new URLSearchParams(window.location.search).get('paid');

  useEffect(() => setDashLogoutHandler(() => setAuthed(false)), []);

  if (!authed) return <DashLogin onDone={() => setAuthed(true)} />;
  return (
    <main className="shell wide">
      <header className="topbar">
        <h1>Dasbor PaceTara</h1>
        <nav>
          {(['listings', 'payments'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
              {{ listings: 'Listing marketplace', payments: 'Pembayaran' }[t]}
            </button>
          ))}
          <button
            className="tab"
            onClick={async () => {
              await dashLogout();
              setAuthed(false);
            }}
          >
            Keluar
          </button>
        </nav>
      </header>
      {paid && <p className="card good">Pembayaran sedang dikonfirmasi. Status diperbarui otomatis setelah Midtrans memberi tahu kami (biasanya beberapa detik).</p>}
      {tab === 'listings' && <Listings />}
      {tab === 'payments' && <Payments />}
    </main>
  );
}

function DashLogin({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await dashLogin(email.trim(), password);
      onDone();
    } catch (err) {
      setError(err instanceof DashError ? err.message : 'Gagal masuk');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell narrow">
      <h1>Dasbor PaceTara</h1>
      <p className="muted">Untuk penjual marketplace dan sponsor. Masuk dengan email dan kata sandi akun PaceTara-mu.</p>
      <form className="card stack" onSubmit={submit}>
        <label>
          Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Kata sandi
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="bad">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? 'Memproses…' : 'Masuk'}
        </button>
        <p className="muted">Akun yang dibuat dengan Google belum punya kata sandi: buat lewat “Lupa kata sandi” di aplikasi.</p>
      </form>
    </main>
  );
}

type MarketConfig = {
  policyVersion: string;
  policyUrl: string;
  policyAccepted: boolean;
  listingFee: { amount: number; days: number };
  boost: { amount: number; days: number };
};
type Listing = {
  id: string;
  model: 'listing_fee' | 'affiliate' | 'split';
  title: string;
  price: number;
  city: string;
  status: 'pending_payment' | 'active' | 'sold' | 'expired' | 'closed';
  activeUntil: string | null;
  boosted: boolean;
  hidden?: boolean;
  clicks?: number;
};

const STATUS: Record<Listing['status'], string> = {
  pending_payment: 'Menunggu pembayaran',
  active: 'Tayang',
  sold: 'Terjual',
  expired: 'Masa tayang habis',
  closed: 'Ditutup',
};
const MODEL: Record<Listing['model'], string> = { listing_fee: 'Biaya pasang', affiliate: 'Afiliasi', split: 'Bayar di aplikasi' };
export const CATEGORY: Record<string, string> = {
  shoes: 'Sepatu',
  apparel: 'Pakaian',
  watch: 'Jam & gawai',
  accessory: 'Aksesori',
  nutrition: 'Nutrisi',
  equipment: 'Perlengkapan',
  other: 'Lainnya',
};
const CONDITION: Record<string, string> = { new: 'Baru', like_new: 'Seperti baru', used: 'Bekas' };

/** Menjalankan pembayaran Midtrans: server membuat transaksi, browser pindah ke halaman Snap. */
export async function startPayment(path: string, body: object) {
  const res = await dash<{ redirectUrl: string }>('POST', path, body);
  if (!res.redirectUrl.startsWith('https://')) throw new Error('Alamat pembayaran tidak valid');
  window.location.assign(res.redirectUrl);
}

function Listings() {
  const cfg = useLoad(() => dash<MarketConfig>('GET', '/v1/market/config'), []);
  const list = useLoad(() => dash<{ items: Listing[] }>('GET', '/v1/market/listings/mine'), []);
  const [msg, setMsg] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function act(fn: () => Promise<unknown>) {
    setMsg(null);
    try {
      await fn();
      list.reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Gagal');
    }
  }

  const c = cfg.data;
  return (
    <section className="card">
      <div className="row">
        <h2>Listing marketplace</h2>
        {c?.policyAccepted && !creating && (
          <button className="primary" onClick={() => setCreating(true)}>
            Pasang listing berbayar
          </button>
        )}
      </div>
      {c && (
        <p className="muted">
          Listing berbayar: {rupiah(c.listingFee.amount)} untuk {c.listingFee.days} hari tayang, transaksi dengan pembeli di luar aplikasi (pembeli menghubungimu lewat chat
          PaceTara). Boost: {rupiah(c.boost.amount)} untuk tampil di urutan atas selama {c.boost.days} hari. Listing afiliasi dan bayar-di-aplikasi dipasang dari aplikasi.
        </p>
      )}
      {cfg.error && <p className="bad">{cfg.error}</p>}
      {c && !c.policyAccepted && <PolicyGate cfg={c} onAccepted={cfg.reload} />}
      {creating && c && (
        <ListingForm
          onDone={() => {
            setCreating(false);
            list.reload();
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      {msg && <p className="bad">{msg}</p>}
      {list.error && <p className="bad">{list.error}</p>}
      {list.data?.items.length === 0 && <p className="muted">Belum ada listing.</p>}
      <table>
        <thead>
          <tr>
            <th>Barang</th>
            <th>Model</th>
            <th>Status</th>
            <th>Tayang sampai</th>
            <th>Aksi</th>
          </tr>
        </thead>
        <tbody>
          {list.data?.items.map((l) => (
            <tr key={l.id}>
              <td>
                {l.title}
                <div className="muted">
                  {rupiah(l.price)} · {l.city}
                  {l.boosted && ' · di-boost'}
                  {l.hidden && ' · disembunyikan karena laporan'}
                  {l.model === 'affiliate' && ` · ${l.clicks ?? 0} klik`}
                </div>
              </td>
              <td>{MODEL[l.model]}</td>
              <td>{STATUS[l.status]}</td>
              <td>{fmtDate(l.activeUntil)}</td>
              <td>
                {l.model === 'listing_fee' && ['pending_payment', 'expired', 'active'].includes(l.status) && (
                  <button className="primary" onClick={() => void act(() => startPayment(`/v1/market/listings/${l.id}/pay`, { purpose: 'listing_fee' }))}>
                    {l.status === 'pending_payment' ? 'Bayar' : 'Perpanjang'}
                  </button>
                )}{' '}
                {l.status === 'active' && <button onClick={() => void act(() => startPayment(`/v1/market/listings/${l.id}/pay`, { purpose: 'listing_boost' }))}>Boost</button>}{' '}
                {['active', 'pending_payment'].includes(l.status) && (
                  <button onClick={() => void act(() => dash('PATCH', `/v1/market/listings/${l.id}`, { status: 'sold' }))}>Tandai terjual</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function PolicyGate({ cfg, onAccepted }: { cfg: { policyVersion: string; policyUrl: string }; onAccepted: () => void }) {
  const [agree, setAgree] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="stack">
      <p>
        Sebelum memasang listing, baca{' '}
        <a href={cfg.policyUrl} target="_blank" rel="noreferrer noopener">
          kebijakan transaksi marketplace
        </a>{' '}
        (barang terlarang, posisi PaceTara sebagai perantara, biaya layanan, sengketa dan refund, sanksi penjual).
      </p>
      <label className="check">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> Saya sudah membaca dan menyetujui kebijakan transaksi versi {cfg.policyVersion}
      </label>
      {error && <p className="bad">{error}</p>}
      <button
        className="primary"
        disabled={!agree}
        onClick={async () => {
          try {
            await dash('POST', '/v1/market/policy', { version: cfg.policyVersion });
            onAccepted();
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Gagal');
          }
        }}
      >
        Setujui
      </button>
    </div>
  );
}

function ListingForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('shoes');
  const [condition, setCondition] = useState('used');
  const [price, setPrice] = useState('');
  const [city, setCity] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const p = Number(price.replace(/\D/g, ''));
    if (!files.length) return setError('Pilih 1–6 foto');
    setBusy(true);
    try {
      const form = new FormData();
      form.append('data', JSON.stringify({ model: 'listing_fee', title: title.trim(), description: description.trim(), category, condition, price: p, city: city.trim() }));
      for (const f of files.slice(0, 6)) form.append('photos', f);
      const created = await dash<{ id: string }>('POST', '/v1/market/listings', form);
      onDone();
      // Langsung ke pembayaran biaya pasang.
      await startPayment(`/v1/market/listings/${created.id}/pay`, { purpose: 'listing_fee' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <div className="grid2">
        <label>
          Judul
          <input value={title} onChange={(e) => setTitle(e.target.value)} minLength={3} maxLength={80} required />
        </label>
        <label>
          Harga (rupiah)
          <input inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} required />
        </label>
        <label>
          Kategori
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {Object.entries(CATEGORY).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          Kondisi
          <select value={condition} onChange={(e) => setCondition(e.target.value)}>
            {Object.entries(CONDITION).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          Kota
          <input value={city} onChange={(e) => setCity(e.target.value)} minLength={2} maxLength={60} required />
        </label>
        <label>
          Foto (1–6, JPG/PNG/WebP, maks. 8 MB)
          <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
        </label>
      </div>
      <label>
        Deskripsi (ukuran, minus, cara kirim/COD)
        <textarea rows={4} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {error && <p className="bad">{error}</p>}
      <div className="row">
        <button type="button" onClick={onCancel}>
          Batal
        </button>
        <button className="primary" disabled={busy}>
          {busy ? 'Memproses…' : 'Simpan dan bayar'}
        </button>
      </div>
    </form>
  );
}

type Payment = { id: string; orderId: string; purpose: string; amount: number; status: string; redirectUrl: string | null; paidAt: string | null; createdAt: string };
const PURPOSE: Record<string, string> = { listing_fee: 'Biaya pasang listing', listing_boost: 'Boost listing', banner: 'Banner sponsor' };
const PAY_STATUS: Record<string, string> = { pending: 'Menunggu', paid: 'Lunas', failed: 'Gagal', expired: 'Kedaluwarsa', refunded: 'Dikembalikan' };

function Payments() {
  const list = useLoad(() => dash<{ items: Payment[] }>('GET', '/v1/payments/mine'), []);
  return (
    <section className="card">
      <h2>Riwayat pembayaran</h2>
      {list.error && <p className="bad">{list.error}</p>}
      {list.data?.items.length === 0 && <p className="muted">Belum ada pembayaran.</p>}
      <table>
        <thead>
          <tr>
            <th>Untuk</th>
            <th>Jumlah</th>
            <th>Status</th>
            <th>Dibuat</th>
            <th>No. order</th>
          </tr>
        </thead>
        <tbody>
          {list.data?.items.map((p) => (
            <tr key={p.id}>
              <td>{PURPOSE[p.purpose] ?? p.purpose}</td>
              <td>{rupiah(p.amount)}</td>
              <td>
                {PAY_STATUS[p.status] ?? p.status}
                {p.redirectUrl && (
                  <>
                    {' '}
                    <a href={p.redirectUrl}>Lanjutkan bayar</a>
                  </>
                )}
              </td>
              <td>{fmtDate(p.createdAt)}</td>
              <td className="mono">{p.orderId}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
