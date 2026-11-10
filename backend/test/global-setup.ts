import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/database/migrator.js';

/** Menjalankan migrasi ke database tes sekali sebelum semua tes (jika TEST_DATABASE_URL diatur). */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
  await runMigrations(url, dir);
}
