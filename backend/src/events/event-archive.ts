import type pg from 'pg';
import { TODAY_SQL } from './events.service.js';

/**
 * Arsipkan event sehari setelah tanggalnya (PRD 1.7). Dijalankan worker tiap jam; daftar event juga
 * menyaring berdasarkan tanggal, jadi jeda sampai job berikutnya tidak terlihat pengguna.
 * Tanda "ikut" tetap disimpan (untuk riwayat/paspor lari di Fase 2). Mengembalikan jumlah event diarsipkan.
 */
export async function archivePastEvents(pool: Pick<pg.Pool, 'query'>): Promise<number> {
  const { rowCount } = await pool.query(`UPDATE events SET archived_at = now() WHERE archived_at IS NULL AND event_date < ${TODAY_SQL}`);
  return rowCount ?? 0;
}

/**
 * Modul 2.4: kiriman event yang masih menunggu tetapi tanggalnya sudah lewat ditutup (ditolak dengan alasan
 * otomatis). Event hasil engine yang sudah tayang diarsipkan oleh archivePastEvents seperti event manual.
 */
export async function expireStaleSubmissions(pool: Pick<pg.Pool, 'query'>): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE event_submissions SET status = 'rejected', reject_reason = 'Tanggal event sudah lewat sebelum ditinjau', reviewed_at = now(), updated_at = now()
      WHERE status = 'pending' AND event_date < ${TODAY_SQL}`,
  );
  return rowCount ?? 0;
}

/** Tanggal hari ini (WIB) sebagai YYYY-MM-DD, sama dengan TODAY_SQL. */
export function todayWib(now = Date.now()): string {
  return new Date(now + 7 * 3_600_000).toISOString().slice(0, 10);
}
