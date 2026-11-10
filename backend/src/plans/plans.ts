/**
 * Batas paket gratis vs berbayar (PRD: "Gratis vs berbayar"). SATU-SATUNYA tempat angka batas.
 * Semua batas ditegakkan di server; aplikasi hanya menampilkan.
 *
 * Catatan: PRD masih bertentangan soal batas anggota (tabel: 3/30/tanpa batas; paragraf: 50)
 * dan review menyarankan batas gratis lebih besar (docs/REVIEW-PRD.md A2, B1). Angka di bawah
 * mengikuti tabel PRD sampai pemilik memutuskan.
 */

export type UserPlan = 'free' | 'premium';
export type CommunityPlan = 'free' | 'pro' | 'pro_unlimited';

/** Batas jumlah komunitas yang boleh diikuti (termasuk yang dimiliki). null = tanpa batas. */
export const USER_JOIN_LIMIT: Record<UserPlan, number | null> = {
  free: 3,
  premium: null,
};

/** Batas anggota aktif per komunitas (termasuk pemilik). null = tanpa batas. */
export const COMMUNITY_MEMBER_LIMIT: Record<CommunityPlan, number | null> = {
  free: 3,
  pro: 30,
  pro_unlimited: null,
};

/** Komunitas berpaket gratis yang boleh dimiliki satu akun. Komunitas Pro tidak dihitung. */
export const FREE_COMMUNITIES_PER_OWNER = 1;

/** Fitur yang hanya untuk Komunitas Pro. */
export function hasMultiAdmin(plan: CommunityPlan): boolean {
  return plan !== 'free';
}

export function isPaidCommunity(plan: CommunityPlan): boolean {
  return plan !== 'free';
}

export interface LimitInfo {
  limit: number | null;
  used: number;
  reached: boolean;
}

export function limitInfo(limit: number | null, used: number): LimitInfo {
  return { limit, used, reached: limit !== null && used >= limit };
}
