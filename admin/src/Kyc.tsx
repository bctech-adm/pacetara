import { useState } from 'react';
import { api } from './api';
import { useLoad } from './useLoad';

/**
 * Antrean tinjauan verifikasi KTP (modul 3.1). Foto KTP dan selfie TIDAK disimpan, jadi tinjauan memakai skor mesin,
 * alasan otomatis, dan nama hasil baca KTP vs nama yang diketik (dibuka per kasus, tercatat di log). Setujui hanya
 * bila perbedaannya jelas wajar (mis. nama tengah, satu huruf salah baca); selebihnya tolak dengan alasan agar
 * pengguna mengulang. Kasus kedaluwarsa otomatis setelah 30 hari.
 */
type Status = 'review' | 'approved' | 'rejected' | 'retry' | 'expired' | 'revoked';

type Attempt = {
  id: string;
  status: Status;
  auto: boolean;
  reasons: string[];
  messages: string[];
  note: string | null;
  createdAt: string;
  reviewedAt: string | null;
  userId: string;
  user: string;
  reviewer: string | null;
  scores: { face: number | null; selfieReal: number | null; selfieLive: number | null; ocr: number | null; name: number | null };
};
type Thresholds = { facePass: number; faceReject: number; livenessMin: number; nameMin: number; ocrMin: number };

const STATUS: Record<Status, string> = {
  review: 'Menunggu tinjauan',
  approved: 'Disetujui',
  rejected: 'Ditolak',
  retry: 'Diminta ulang',
  expired: 'Kedaluwarsa',
  revoked: 'Dicabut',
};
const n2 = (v: number | null) => (v === null ? '–' : v.toFixed(2));
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('id-ID') : '–');

export function Kyc() {
  const [status, setStatus] = useState<Status>('review');
  const [msg, setMsg] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, { ocrName: string; enteredName: string } | null>>({});
  const list = useLoad(() => api<{ items: Attempt[]; thresholds: Thresholds }>('GET', `/v1/admin/kyc?status=${status}`), [status]);
  const th = list.data?.thresholds;

  async function act(fn: () => Promise<unknown>) {
    setMsg(null);
    try {
      await fn();
      list.reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Gagal');
    }
  }

  async function showNames(id: string) {
    try {
      const d = await api<{ names: { ocrName: string; enteredName: string } | null }>('GET', `/v1/admin/kyc/${id}`);
      setNames((m) => ({ ...m, [id]: d.names }));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Gagal');
    }
  }

  async function revoke() {
    const userId = window.prompt('ID pengguna yang Level 2-nya dicabut');
    if (!userId) return;
    const reason = window.prompt('Alasan pencabutan (ditampilkan ke pengguna)');
    if (reason && reason.trim().length >= 3) await act(() => api('POST', `/v1/admin/kyc/users/${userId.trim()}/revoke`, { reason: reason.trim() }));
  }

  return (
    <section className="card">
      <div className="row">
        <h2>Verifikasi KTP</h2>
        <select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
          {Object.entries(STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <button className="danger" onClick={() => void revoke()}>
          Cabut Level 2…
        </button>
      </div>
      <p className="muted">
        Foto tidak disimpan. Putuskan dari skor dan nama. Ambang lolos otomatis: wajah ≥ {th?.facePass ?? '…'} (di bawah {th?.faceReject ?? '…'} = berbeda), anti-spoof
        dan liveness ≥ {th?.livenessMin ?? '…'}, nama ≥ {th?.nameMin ?? '…'}, OCR ≥ {th?.ocrMin ?? '…'}. Wajah ragu atau liveness rendah sebaiknya ditolak agar
        pengguna mengulang.
      </p>
      {list.error && <p className="bad">{list.error}</p>}
      {msg && <p className="bad">{msg}</p>}
      {list.data?.items.length === 0 && <p className="muted">Tidak ada data.</p>}
      <table>
        <thead>
          <tr>
            <th>Pengguna</th>
            <th>Alasan</th>
            <th>Skor</th>
            <th>Waktu</th>
            <th>{status === 'review' ? 'Aksi' : 'Keterangan'}</th>
          </tr>
        </thead>
        <tbody>
          {list.data?.items.map((a) => (
            <tr key={a.id}>
              <td>
                {a.user}
                <div className="muted mono">{a.userId}</div>
              </td>
              <td>
                {a.messages.map((m, i) => (
                  <div key={i}>{m}</div>
                ))}
                {status === 'review' &&
                  (a.id in names ? (
                    names[a.id] ? (
                      <div className="mono">
                        KTP: {names[a.id]!.ocrName || '(tidak terbaca)'}
                        <br />
                        Diketik: {names[a.id]!.enteredName}
                      </div>
                    ) : (
                      <div className="muted">Data tinjauan sudah dihapus</div>
                    )
                  ) : (
                    <button onClick={() => void showNames(a.id)}>Lihat nama (tercatat di log)</button>
                  ))}
              </td>
              <td className="mono">
                wajah {n2(a.scores.face)} · spoof {n2(a.scores.selfieReal)} · live {n2(a.scores.selfieLive)}
                <br />
                nama {n2(a.scores.name)} · OCR {a.scores.ocr === null ? '–' : Math.round(a.scores.ocr)}
              </td>
              <td>
                {fmt(a.createdAt)}
                {a.reviewedAt && <div className="muted">ditinjau {fmt(a.reviewedAt)}</div>}
              </td>
              <td>
                {status === 'review' ? (
                  <>
                    <button
                      onClick={() => {
                        const note = window.prompt('Catatan persetujuan (opsional)') ?? undefined;
                        void act(() => api('POST', `/v1/admin/kyc/${a.id}/approve`, note?.trim() ? { note: note.trim() } : {}));
                      }}
                    >
                      Setujui
                    </button>{' '}
                    <button
                      className="danger"
                      onClick={() => {
                        const reason = window.prompt('Alasan penolakan (ditampilkan ke pengguna)');
                        if (reason && reason.trim().length >= 3) void act(() => api('POST', `/v1/admin/kyc/${a.id}/reject`, { reason: reason.trim() }));
                      }}
                    >
                      Tolak
                    </button>
                  </>
                ) : (
                  <>
                    {a.auto ? 'Otomatis' : `Oleh ${a.reviewer ?? '–'}`}
                    {a.note && <div className="muted">{a.note}</div>}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
