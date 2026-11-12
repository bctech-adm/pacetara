import type { Queryable } from '../common/db.js';

/** Tinjauan manual yang tidak diputuskan dalam 30 hari kedaluwarsa (data tinjauan dihapus). */
export const KYC_REVIEW_DAYS = 30;

/**
 * Job worker (modul 3.1): tinjauan verifikasi KTP yang menunggu > 30 hari diubah menjadi `expired`, dan NIK HMAC +
 * nama terenkripsinya dihapus. Pengguna bisa mencoba lagi. Fungsi lepas agar worker tidak memuat mesin OCR/wajah.
 */
export async function expireKycReviews(db: Queryable): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE kyc_attempts SET status = 'expired', nik_hmac = NULL, review_data_enc = NULL, reviewed_at = now()
      WHERE status = 'review' AND created_at < now() - make_interval(days => $1)`,
    [KYC_REVIEW_DAYS],
  );
  return rowCount ?? 0;
}
