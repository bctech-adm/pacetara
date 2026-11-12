import { type FormEvent, useState } from 'react';
import { api } from './api';

/**
 * Langganan (modul 2.5): status langganan Google Play pengguna/komunitas (read-only) dan pemberian paket manual
 * berbatas waktu untuk uji tanpa Play atau kompensasi. Setiap pembukaan dan pemberian tercatat di log.
 */
type Sub = {
  id: string;
  productId: string;
  kind: string;
  state: string;
  active: boolean;
  expiresAt: string | null;
  autoRenewing: boolean;
  acknowledged: boolean;
  testPurchase: boolean;
  orderId: string | null;
  revokedAt: string | null;
  replaced: boolean;
  createdAt: string;
};
type Grant = { id: string; plan: string; expiresAt: string; active: boolean; reason: string; revokedAt: string | null; createdAt: string; grantedBy: string | null };
type View = {
  user?: { id: string; displayName: string; plan: string; status: string };
  community?: { id: string; name: string; plan: string; memberCount: number };
  subscriptions: Sub[];
  grants: Grant[];
};
type CommunityHit = { id: string; name: string; city: string; plan: string; memberCount: number };

const PLAN: Record<string, string> = { free: 'Gratis', premium: 'Premium', pro: 'Komunitas Pro', pro_unlimited: 'Pro Unlimited' };
const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('id-ID') : '–');

export function Subscriptions() {
  const [email, setEmail] = useState('');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<CommunityHit[]>([]);
  const [target, setTarget] = useState<{ type: 'user' | 'community'; id: string } | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(t: { type: 'user' | 'community'; id: string }) {
    setError(null);
    try {
      setView(await api<View>('GET', `/v1/admin/subscriptions/${t.type === 'user' ? 'users' : 'communities'}/${t.id}`));
      setTarget(t);
    } catch (e) {
      setView(null);
      setError(e instanceof Error ? e.message : 'Gagal');
    }
  }

  async function findUser(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      // Email lewat body (bukan URL), pencarian tercatat di log.
      const u = await api<{ id: string }>('POST', '/v1/admin/users/lookup', { email });
      await load({ type: 'user', id: u.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal');
    }
  }

  async function findCommunity(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      setHits((await api<{ items: CommunityHit[] }>('POST', '/v1/admin/subscriptions/communities/search', { q })).items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal');
    }
  }

  return (
    <section className="card stack">
      <h2>Langganan</h2>
      <p className="muted">
        Status berasal dari Google Play dan hanya bisa dibaca. Pemberian manual untuk uji tanpa Play atau kompensasi, selalu berbatas waktu dan
        tercatat di log.
      </p>
      <form className="row" onSubmit={findUser}>
        <input type="email" required placeholder="Email pengguna" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="primary">Cari pengguna</button>
      </form>
      <form className="row" onSubmit={findCommunity}>
        <input required minLength={2} placeholder="Nama komunitas" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="primary">Cari komunitas</button>
      </form>
      {hits.length > 0 && (
        <ul className="list">
          {hits.map((h) => (
            <li key={h.id} className="row">
              <span>
                <strong>{h.name}</strong> · {h.city} · {PLAN[h.plan] ?? h.plan} · {h.memberCount} anggota
              </span>
              <button onClick={() => void load({ type: 'community', id: h.id })}>Lihat</button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="bad">{error}</p>}
      {view && target && <Detail view={view} target={target} onChanged={() => void load(target)} />}
    </section>
  );
}

function Detail({ view, target, onChanged }: { view: View; target: { type: 'user' | 'community'; id: string }; onChanged: () => void }) {
  const [plan, setPlan] = useState(target.type === 'user' ? 'premium' : 'pro');
  const [days, setDays] = useState(30);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  async function grant(e: FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 3) return setMsg('Tulis alasan (minimal 3 karakter)');
    if (!window.confirm(`Beri ${PLAN[plan]} selama ${days} hari?`)) return;
    try {
      await api('POST', '/v1/admin/subscriptions/grants', {
        ...(target.type === 'user' ? { userId: target.id } : { communityId: target.id }),
        plan,
        days,
        reason: reason.trim(),
      });
      setReason('');
      setMsg(null);
      onChanged();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Gagal');
    }
  }

  async function revoke(g: Grant) {
    const why = window.prompt('Alasan mencabut pemberian paket ini?');
    if (!why || why.trim().length < 3) return;
    try {
      await api('POST', `/v1/admin/subscriptions/grants/${g.id}/revoke`, { reason: why.trim() });
      onChanged();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Gagal');
    }
  }

  const title = view.user ? `${view.user.displayName} (${view.user.status})` : `${view.community?.name} · ${view.community?.memberCount} anggota`;
  const current = view.user?.plan ?? view.community?.plan ?? 'free';
  return (
    <div className="stack">
      <h3>
        {title} · paket saat ini: {PLAN[current] ?? current}
      </h3>
      <h4>Langganan Google Play</h4>
      {view.subscriptions.length === 0 && <p className="muted">Belum ada.</p>}
      <ul className="list">
        {view.subscriptions.map((s) => (
          <li key={s.id}>
            <strong>{PLAN[s.kind] ?? s.kind}</strong> ({s.productId}) · {s.state}
            {s.active ? ' · berhak' : ' · tidak berhak'} · berlaku sampai {fmt(s.expiresAt)}
            {s.autoRenewing ? ' · diperpanjang otomatis' : ''}
            {s.acknowledged ? '' : ' · belum di-acknowledge'}
            {s.testPurchase ? ' · pembelian uji' : ''}
            {s.revokedAt ? ` · dicabut/refund ${fmt(s.revokedAt)}` : ''}
            {s.replaced ? ' · digantikan token baru' : ''} · pesanan {s.orderId ?? '–'} · dibuat {fmt(s.createdAt)}
          </li>
        ))}
      </ul>
      <h4>Pemberian manual</h4>
      {view.grants.length === 0 && <p className="muted">Belum ada.</p>}
      <ul className="list">
        {view.grants.map((g) => (
          <li key={g.id} className="row">
            <span>
              <strong>{PLAN[g.plan] ?? g.plan}</strong> sampai {fmt(g.expiresAt)} · {g.active ? 'aktif' : g.revokedAt ? `dicabut ${fmt(g.revokedAt)}` : 'berakhir'} · oleh{' '}
              {g.grantedBy ?? '–'} · {g.reason}
            </span>
            {g.active && <button onClick={() => void revoke(g)}>Cabut</button>}
          </li>
        ))}
      </ul>
      <form className="stack" onSubmit={grant}>
        <div className="row">
          <select value={plan} onChange={(e) => setPlan(e.target.value)}>
            {target.type === 'user' ? (
              <option value="premium">Premium</option>
            ) : (
              <>
                <option value="pro">Komunitas Pro</option>
                <option value="pro_unlimited">Pro Unlimited</option>
              </>
            )}
          </select>
          <label>
            Hari{' '}
            <input type="number" min={1} max={365} value={days} onChange={(e) => setDays(Math.max(1, Math.min(365, Number(e.target.value) || 1)))} />
          </label>
        </div>
        <input required minLength={3} maxLength={500} placeholder="Alasan (uji / kompensasi …)" value={reason} onChange={(e) => setReason(e.target.value)} />
        {msg && <p className="bad">{msg}</p>}
        <button className="primary">Beri paket</button>
      </form>
    </div>
  );
}
