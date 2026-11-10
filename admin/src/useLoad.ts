import { useCallback, useEffect, useState } from 'react';

/** Muat data sekali (dan ulang saat deps berubah); galat menjadi pesan untuk ditampilkan. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    setError(null);
    fn()
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Gagal memuat'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, reload };
}
