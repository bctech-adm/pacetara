import { useEffect, useState } from 'react';
import { api, apiImage } from './api';
import { useLoad } from './useLoad';

/**
 * Antrean banner sponsor (modul 3.3). Banner yang sudah dibayar menunggu persetujuan di sini; setelah disetujui
 * tayang sesuai periode dan turun otomatis. Tolak bila gambar/tautan menyesatkan, melanggar hukum, atau tidak
 * relevan; refund biaya dilakukan di dasbor Midtrans. Setiap keputusan tercatat di log.
 */
type Status = 'pending_review' | 'approved' | 'rejected' | 'pending_payment' | 'cancelled';
type Banner = {
  id: string;
  slot: 'home' | 'events' | 'event_detail';
  title: string;
  eventName: string | null;
  targetUrl: string | null;
  cities: string[];
  startsOn: string;
  endsOn: string;
  days: number;
  amount: number;
  state: string;
  rejectReason: string | null;
  imageUrl: string | null;
  impressions: number;
  clicks: number;
  sponsor: string;
};

const STATUS: Record<Status, string> = {
  pending_review: 'Menunggu tinjauan',
  approved: 'Disetujui',
  rejected: 'Ditolak',
  pending_payment: 'Belum dibayar',
  cancelled: 'Dibatalkan',
};
const SLOT: Record<Banner['slot'], string> = { home: 'Beranda', events: 'Daftar event', event_detail: 'Detail event' };
const STATE: Record<string, string> = { scheduled: 'Terjadwal', live: 'Tayang', ended: 'Selesai' };

function BannerImage({ id }: { id: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    apiImage(`/v1/admin/banners/${id}/image`)
      .then((u) => {
        url = u;
        setSrc(u);
      })
      .catch(() => setSrc(null));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);
  return src ? <img className="reported-photo" src={src} alt="Banner" /> : <span className="muted">Memuat gambar…</span>;
}

export function Banners() {
  const [status, setStatus] = useState<Status>('pending_review');
  const [msg, setMsg] = useState<string | null>(null);
  const list = useLoad(() => api<{ items: Banner[] }>('GET', `/v1/admin/banners?status=${status}`), [status]);

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
    <section className="card">
      <div className="row">
        <h2>Banner sponsor</h2>
        <select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
          {Object.entries(STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <p className="muted">Periksa gambar, teks, dan tautan sebelum menyetujui. Jika disetujui setelah tanggal mulai, periode otomatis digeser ke hari ini.</p>
      {list.error && <p className="bad">{list.error}</p>}
      {msg && <p className="bad">{msg}</p>}
      {list.data?.items.length === 0 && <p className="muted">Tidak ada banner.</p>}
      <ul className="list">
        {list.data?.items.map((b) => (
          <li key={b.id}>
            <div className="row">
              <strong>{b.title}</strong>
              <span className="muted">
                {SLOT[b.slot]} · {b.cities.length ? b.cities.join(', ') : 'Nasional'} · {b.startsOn} s.d. {b.endsOn} ({b.days} hari) · Rp{b.amount.toLocaleString('id-ID')}
              </span>
            </div>
            <div className="muted">
              Sponsor: {b.sponsor}
              {b.eventName && ` · Event: ${b.eventName}`}
              {b.targetUrl && (
                <>
                  {' '}
                  · Tautan: <span className="mono">{b.targetUrl}</span>
                </>
              )}
              {b.state in STATE && ` · ${STATE[b.state]} · ${b.impressions} tayangan, ${b.clicks} klik`}
            </div>
            {b.imageUrl && <BannerImage id={b.id} />}
            {b.rejectReason && <p className="quote">{b.rejectReason}</p>}
            {status === 'pending_review' && (
              <div className="row">
                <button className="primary" onClick={() => void act(() => api('POST', `/v1/admin/banners/${b.id}/approve`))}>
                  Setujui
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    const reason = window.prompt('Alasan penolakan (ditampilkan ke sponsor; lakukan refund di dasbor Midtrans)');
                    if (reason && reason.trim().length >= 3) void act(() => api('POST', `/v1/admin/banners/${b.id}/reject`, { reason: reason.trim() }));
                  }}
                >
                  Tolak
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
