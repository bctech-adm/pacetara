import type pg from 'pg';

/** Gambar chat dihapus dari penyimpanan setelah 6 bulan (PRD 1.6); teks tetap. */
export const CHAT_IMAGE_RETENTION_DAYS = 180;

interface ObjectStore {
  delete(key: string): Promise<void>;
}

/**
 * Hapus gambar chat yang lebih tua dari [days] hari, maksimal [batch] per panggilan.
 * Baris pesan tetap; `image_key` dikosongkan dan `image_expired_at` diisi sehingga aplikasi
 * menampilkan "Gambar sudah kedaluwarsa". Berkas yang gagal dihapus dicoba lagi di putaran berikutnya.
 * Mengembalikan jumlah gambar yang dihapus.
 */
export async function expireChatImages(pool: pg.Pool, storage: ObjectStore, days = CHAT_IMAGE_RETENTION_DAYS, batch = 500): Promise<number> {
  const { rows } = await pool.query<{ id: string; image_key: string }>(
    `SELECT id, image_key FROM chat_messages
      WHERE image_key IS NOT NULL AND created_at < now() - make_interval(days => $1)
      ORDER BY created_at LIMIT $2`,
    [days, batch],
  );
  let done = 0;
  for (const r of rows) {
    try {
      await storage.delete(r.image_key);
    } catch {
      continue;
    }
    await pool.query('UPDATE chat_messages SET image_key = NULL, image_expired_at = now() WHERE id = $1 AND image_key = $2', [r.id, r.image_key]);
    done++;
  }
  return done;
}
