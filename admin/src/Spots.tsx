import { useState } from 'react';
import { api } from './api';
import { useLoad } from './useLoad';

/**
 * Antrean spot lari (modul 2.6): kiriman pengguna baru tampil di peta aplikasi setelah disetujui di sini.
 * Tolak tempat yang bukan tempat umum (mis. rumah), duplikat, atau tidak layak. Setiap keputusan tercatat di log.
 */
type Status = 'pending' | 'approved' | 'rejected';

type Spot = {
  id: string;
  name: string;
  city: string;
  point: { lat: number; lng: number };
  lighting: number | null;
  toilet: boolean | null;
  parking: boolean | null;
  notes: string;
  status: Status;
  rejectReason: string | null;
  submitter: string | null;
  hidden: boolean;
  nearbyApproved: number;
  createdAt: string;
};

const STATUS: Record<Status, string> = { pending: 'Menunggu', approved: 'Disetujui', rejected: 'Ditolak' };
const LIGHT = ['Tidak ada', 'Sebagian', 'Terang'];
const yn = (v: boolean | null) => (v === null ? '?' : v ? 'Ada' : 'Tidak');

export function Spots() {
  const [status, setStatus] = useState<Status>('pending');
  const [msg, setMsg] = useState<string | null>(null);
  const list = useLoad(() => api<{ items: Spot[] }>('GET', `/v1/admin/spots?status=${status}`), [status]);

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
        <h2>Antrean spot lari</h2>
        <select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
          {Object.entries(STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <p className="muted">Spot di antrean belum terlihat pengguna. Periksa titiknya di peta (koordinat) sebelum menyetujui.</p>
      {list.error && <p className="bad">{list.error}</p>}
      {msg && <p className="bad">{msg}</p>}
      {list.data?.items.length === 0 && <p className="muted">Antrean kosong.</p>}
      <table>
        <thead>
          <tr>
            <th>Nama</th>
            <th>Kota</th>
            <th>Koordinat</th>
            <th>Fasilitas</th>
            <th>Pengirim</th>
            <th>{status === 'pending' ? 'Aksi' : 'Keterangan'}</th>
          </tr>
        </thead>
        <tbody>
          {list.data?.items.map((s) => (
            <tr key={s.id}>
              <td>
                {s.name}
                {s.notes && <div className="muted">{s.notes}</div>}
                {s.nearbyApproved > 0 && <div className="bad">{s.nearbyApproved} spot tayang dalam 150 m (duplikat?)</div>}
              </td>
              <td>{s.city}</td>
              <td className="mono">
                {s.point.lat.toFixed(5)}, {s.point.lng.toFixed(5)}
              </td>
              <td>
                Lampu: {s.lighting === null ? '?' : LIGHT[s.lighting]} · Toilet: {yn(s.toilet)} · Parkir: {yn(s.parking)}
              </td>
              <td>{s.submitter ?? '–'}</td>
              <td>
                {status === 'pending' ? (
                  <>
                    <button onClick={() => act(() => api('POST', `/v1/admin/spots/${s.id}/approve`, {}))}>Setujui</button>{' '}
                    <button
                      className="danger"
                      onClick={() => {
                        const reason = window.prompt('Alasan penolakan (ditampilkan ke pengirim)');
                        if (reason && reason.trim().length >= 3) void act(() => api('POST', `/v1/admin/spots/${s.id}/reject`, { reason: reason.trim() }));
                      }}
                    >
                      Tolak
                    </button>
                  </>
                ) : (
                  (s.rejectReason ?? (s.hidden ? 'Disembunyikan (laporan)' : 'Tampil'))
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
