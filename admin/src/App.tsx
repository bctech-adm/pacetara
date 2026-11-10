import { useEffect, useState } from 'react';
import { API_BASE_URL } from './config';

type Health = { status: string; database: string; redis: string };

/**
 * Kerangka panel super admin (modul 1.1). Login + 2FA, antrean laporan, dan log tindakan
 * dibangun di modul 1.8; input event manual di 1.7; dasbor sponsor di 3.3.
 */
export function App() {
  const [health, setHealth] = useState<Health | 'error' | null>(null);

  useEffect(() => {
    fetch(`${API_BASE_URL}/health`)
      .then((r) => r.json() as Promise<Health | { message: Health }>)
      .then((b) => setHealth('status' in b ? b : b.message))
      .catch(() => setHealth('error'));
  }, []);

  return (
    <main className="shell">
      <header>
        <h1>PaceTara Admin</h1>
        <p className="muted">Panel super admin dan dasbor sponsor</p>
      </header>
      <section className="card">
        <h2>Status API</h2>
        {health === null && <p>Memeriksa…</p>}
        {health === 'error' && <p className="bad">API tidak bisa dijangkau</p>}
        {health && health !== 'error' && (
          <dl>
            <dt>Keseluruhan</dt>
            <dd className={health.status === 'ok' ? 'good' : 'bad'}>{health.status}</dd>
            <dt>Database</dt>
            <dd className={health.database === 'ok' ? 'good' : 'bad'}>{health.database}</dd>
            <dt>Redis</dt>
            <dd className={health.redis === 'ok' ? 'good' : 'bad'}>{health.redis}</dd>
          </dl>
        )}
      </section>
    </main>
  );
}
