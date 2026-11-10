import type { Queryable } from '../common/db.js';

/**
 * Kunci gambar chat milik komunitas yang akan dihapus. Baris pesan ikut terhapus lewat
 * ON DELETE CASCADE, jadi kunci harus dikumpulkan SEBELUM DELETE agar berkas di penyimpanan
 * tidak tertinggal. Panggil di transaksi yang sama.
 */
export async function chatImageKeysOfCommunities(db: Queryable, communityIds: string[]): Promise<string[]> {
  if (communityIds.length === 0) return [];
  const { rows } = await db.query<{ image_key: string }>(
    `SELECT m.image_key FROM chat_messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.community_id = ANY($1::uuid[]) AND m.image_key IS NOT NULL`,
    [communityIds],
  );
  return rows.map((r) => r.image_key);
}
