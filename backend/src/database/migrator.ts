/**
 * Menjalankan migrasi SQL secara berurutan. Setiap file dalam satu transaksi, dicatat di
 * schema_migrations beserta checksum (perubahan migrasi lama terdeteksi), dengan advisory lock.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

export async function runMigrations(url: string, dir: string, log: (m: string) => void = () => undefined): Promise<void> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[\w-]+\.sql$/.test(f)).sort();

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // Kunci advisory: aman jika dua container migrate berjalan bersamaan.
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const sql = await readFile(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prev = applied.get(file);
      if (prev) {
        if (prev !== checksum) throw new Error(`Migrasi ${file} sudah dijalankan tetapi isinya berubah`);
        continue;
      }
      log(`→ ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    log('Migrasi selesai');
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    await client.end();
  }
}

