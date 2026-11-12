import { useState } from 'react';
import { api } from './api';
import { useLoad } from './useLoad';

/**
 * Marketplace (modul 3.2) di panel super admin: pesanan split payment dan sengketa, akun penjual (sanksi), dan
 * pembayaran Midtrans milik PaceTara. PaceTara tidak memegang dana pembeli: refund pesanan dieksekusi di dasbor
 * Xendit dari akun penjual, refund biaya listing/banner di dasbor Midtrans; di sini hanya mencatat keputusannya.
 */
type View = 'orders' | 'sellers' | 'payments';
type OrderStatus = 'open' | 'disputed' | 'pending' | 'paid' | 'shipped' | 'completed' | 'cancelled' | 'expired' | 'refunded';

type Order = {
  id: string;
  title: string;
  qty: number;
  amount: number;
  fee: number;
  status: string;
  buyer: string | null;
  seller: string | null;
  trackingNote: string | null;
  disputeOpenedAt: string | null;
  resolutionNote: string | null;
  paidAt: string | null;
  createdAt: string;
};
type Seller = { userId: string | null; user: string | null; status: string; xenditAccountId: string; suspendedReason: string | null; orders: number; createdAt: string };
type Payment = { id: string; orderId: string; purpose: string; refId: string; amount: number; status: string; applied: boolean; user: string | null; paidAt: string | null; createdAt: string };

const rupiah = (n: number) => `Rp${n.toLocaleString('id-ID')}`;
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('id-ID') : '–');
const ORDER_STATUS: Record<OrderStatus, string> = {
  open: 'Berjalan (dibayar/dikirim/sengketa)',
  disputed: 'Sengketa',
  pending: 'Menunggu bayar',
  paid: 'Dibayar',
  shipped: 'Dikirim',
  completed: 'Selesai',
  cancelled: 'Dibatalkan',
  expired: 'Kedaluwarsa',
  refunded: 'Dikembalikan',
};
const PURPOSE: Record<string, string> = { listing_fee: 'Biaya pasang', listing_boost: 'Boost', banner: 'Banner sponsor' };

export function Market() {
  const [view, setView] = useState<View>('orders');
  return (
    <section className="card">
      <div className="row">
        <h2>Marketplace</h2>
        <nav>
          {(['orders', 'sellers', 'payments'] as View[]).map((v) => (
            <button key={v} className={view === v ? 'tab active' : 'tab'} onClick={() => setView(v)}>
              {{ orders: 'Pesanan & sengketa', sellers: 'Akun penjual', payments: 'Pembayaran Midtrans' }[v]}
            </button>
          ))}
        </nav>
      </div>
      {view === 'orders' && <Orders />}
      {view === 'sellers' && <Sellers />}
      {view === 'payments' && <Payments />}
    </section>
  );
}

function Orders() {
  const [status, setStatus] = useState<OrderStatus>('open');
  const [msg, setMsg] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string | null>>({});
  const list = useLoad(() => api<{ items: Order[] }>('GET', `/v1/admin/market/orders?status=${status}`), [status]);

  async function act(fn: () => Promise<unknown>) {
    setMsg(null);
    try {
      await fn();
      list.reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Gagal');
    }
  }

  return (
    <>
      <div className="row">
        <select value={status} onChange={(e) => setStatus(e.target.value as OrderStatus)}>
          {Object.entries(ORDER_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <p className="muted">Refund dieksekusi di dasbor Xendit (akun penjual, menu Transaksi/Refund), lalu catat keputusannya di sini agar pembeli dan penjual diberi tahu.</p>
      {list.error && <p className="bad">{list.error}</p>}
      {msg && <p className="bad">{msg}</p>}
      {list.data?.items.length === 0 && <p className="muted">Tidak ada pesanan.</p>}
      <table>
        <thead>
          <tr>
            <th>Pesanan</th>
            <th>Pihak</th>
            <th>Status</th>
            <th>Waktu</th>
            <th>Aksi</th>
          </tr>
        </thead>
        <tbody>
          {list.data?.items.map((o) => (
            <tr key={o.id}>
              <td>
                {o.title} x{o.qty}
                <div className="muted">
                  {rupiah(o.amount)} (komisi {rupiah(o.fee)})
                </div>
                {o.trackingNote && <div className="muted">Resi: {o.trackingNote}</div>}
              </td>
              <td>
                Pembeli: {o.buyer ?? 'Pengguna dihapus'}
                <br />
                Penjual: {o.seller ?? 'Pengguna dihapus'}
              </td>
              <td>
                {ORDER_STATUS[o.status as OrderStatus] ?? o.status}
                {o.resolutionNote && <div className="muted">{o.resolutionNote}</div>}
                {o.disputeOpenedAt &&
                  (o.id in reasons ? (
                    <p className="quote">{reasons[o.id] ?? '(alasan sudah dihapus)'}</p>
                  ) : (
                    <button
                      className="link"
                      onClick={async () => {
                        const r = await api<{ reason: string | null }>('GET', `/v1/admin/market/orders/${o.id}/dispute`);
                        setReasons((m) => ({ ...m, [o.id]: r.reason }));
                      }}
                    >
                      Lihat alasan sengketa (tercatat di log)
                    </button>
                  ))}
              </td>
              <td>
                Dibayar {fmt(o.paidAt)}
                <div className="muted">Dibuat {fmt(o.createdAt)}</div>
              </td>
              <td>
                {['disputed', 'paid', 'shipped'].includes(o.status) && (
                  <>
                    <button
                      onClick={() => {
                        const note = window.prompt('Catatan keputusan: pesanan dianggap selesai (dana tetap di penjual)');
                        if (note && note.trim().length >= 3) void act(() => api('POST', `/v1/admin/market/orders/${o.id}/resolve`, { outcome: 'completed', note: note.trim() }));
                      }}
                    >
                      Selesai
                    </button>{' '}
                    <button
                      className="danger"
                      onClick={() => {
                        const note = window.prompt('Catatan refund (sudah dieksekusi di dasbor Xendit?)');
                        if (note && note.trim().length >= 3) void act(() => api('POST', `/v1/admin/market/orders/${o.id}/resolve`, { outcome: 'refunded', note: note.trim() }));
                      }}
                    >
                      Refund
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Sellers() {
  const [msg, setMsg] = useState<string | null>(null);
  const list = useLoad(() => api<{ items: Seller[] }>('GET', '/v1/admin/market/sellers'), []);

  async function act(path: string, label: string) {
    const reason = window.prompt(label);
    if (!reason || reason.trim().length < 3) return;
    setMsg(null);
    try {
      await api('POST', path, { reason: reason.trim() });
      list.reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Gagal');
    }
  }

  return (
    <>
      <p className="muted">Menangguhkan akun penjual menyembunyikan semua listing bayar-di-aplikasinya dan menghentikan pesanan baru. Akun Xendit penjual tidak diubah.</p>
      {list.error && <p className="bad">{list.error}</p>}
      {msg && <p className="bad">{msg}</p>}
      <table>
        <thead>
          <tr>
            <th>Penjual</th>
            <th>Status</th>
            <th>Pesanan</th>
            <th>Akun Xendit</th>
            <th>Aksi</th>
          </tr>
        </thead>
        <tbody>
          {list.data?.items.map((s) => (
            <tr key={s.xenditAccountId}>
              <td>{s.user ?? 'Pengguna dihapus'}</td>
              <td>
                {s.status}
                {s.suspendedReason && <div className="muted">{s.suspendedReason}</div>}
              </td>
              <td>{s.orders}</td>
              <td className="mono">{s.xenditAccountId}</td>
              <td>
                {s.userId &&
                  (s.status === 'suspended' ? (
                    <button onClick={() => void act(`/v1/admin/market/sellers/${s.userId}/restore`, 'Alasan pemulihan')}>Pulihkan</button>
                  ) : (
                    <button className="danger" onClick={() => void act(`/v1/admin/market/sellers/${s.userId}/suspend`, 'Alasan penangguhan (ditampilkan ke penjual)')}>
                      Tangguhkan
                    </button>
                  ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Payments() {
  const [status, setStatus] = useState('all');
  const list = useLoad(() => api<{ items: Payment[] }>('GET', `/v1/admin/payments?status=${status}`), [status]);
  return (
    <>
      <div className="row">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {['all', 'pending', 'paid', 'failed', 'expired', 'refunded'].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <p className="muted">Pembayaran lunas yang “belum diterapkan” berarti sasarannya (listing/banner) sudah tidak memenuhi syarat: pertimbangkan refund di dasbor Midtrans.</p>
      {list.error && <p className="bad">{list.error}</p>}
      <table>
        <thead>
          <tr>
            <th>Untuk</th>
            <th>Pengguna</th>
            <th>Jumlah</th>
            <th>Status</th>
            <th>No. order</th>
          </tr>
        </thead>
        <tbody>
          {list.data?.items.map((p) => (
            <tr key={p.id}>
              <td>
                {PURPOSE[p.purpose] ?? p.purpose}
                <div className="muted mono">{p.refId}</div>
              </td>
              <td>{p.user ?? '–'}</td>
              <td>{rupiah(p.amount)}</td>
              <td>
                {p.status}
                {p.status === 'paid' && !p.applied && <div className="bad">belum diterapkan</div>}
                <div className="muted">{fmt(p.paidAt ?? p.createdAt)}</div>
              </td>
              <td className="mono">{p.orderId}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
