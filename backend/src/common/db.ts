import type pg from 'pg';

/** Menjalankan fn dalam satu transaksi; rollback otomatis jika melempar galat. */
export async function withTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;
