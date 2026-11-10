/** CLI: node dist/scripts/migrate.js — dipakai service `migrate` di docker-compose. */
import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/database/migrator.js';

const here = dirname(fileURLToPath(import.meta.url));
// dist/scripts/migrate.js → ../../migrations; scripts/migrate.ts → ../migrations
const candidates = [resolve(here, '../../migrations'), resolve(here, '../migrations')];

export async function findMigrationsDir(): Promise<string> {
  for (const dir of candidates) {
    try {
      await readdir(dir);
      return dir;
    } catch {
      /* coba berikutnya */
    }
  }
  throw new Error('Folder migrations tidak ditemukan');
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL belum diatur');
  process.exit(1);
}
runMigrations(url, await findMigrationsDir(), (m) => console.log(m)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
