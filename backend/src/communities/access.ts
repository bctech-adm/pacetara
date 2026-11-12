import type { Queryable } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { type CommunityPlan, hasProFeature, type ProFeature } from '../plans/plans.js';

export type CommunityRole = 'owner' | 'admin' | 'member';

export interface CommunityAccess {
  communityId: string;
  name: string;
  city: string;
  plan: CommunityPlan;
  role: CommunityRole;
  isStaff: boolean;
  isOwner: boolean;
}

/** Pesan galat batas Pro per fitur (dialog upgrade 2.5 membaca limit.kind). */
const PRO_MESSAGES: Record<ProFeature, string> = {
  attendance: 'Absensi QR/GPS khusus Komunitas Pro',
  community_cash: 'Kas komunitas khusus Komunitas Pro',
  jersey: 'Pre-order jersey khusus Komunitas Pro',
  community_stats: 'Statistik komunitas khusus Komunitas Pro',
  league: 'Liga antar komunitas khusus Komunitas Pro',
};

export function proRequired(feature: ProFeature): ApiError {
  return new ApiError(403, 'limit_reached', PRO_MESSAGES[feature], { limit: { kind: feature, max: null } });
}

export function communityNotFound(): ApiError {
  return new ApiError(404, 'community_not_found', 'Komunitas tidak ditemukan');
}

/**
 * Hak akses fitur komunitas modul 2.6. Bukan anggota aktif, diblokir, menunggu persetujuan, atau komunitas
 * diturunkan super admin (#129) = 404 seolah komunitas tidak ada. [lock] = kunci baris komunitas (FOR SHARE) agar
 * paket tidak berubah di tengah transaksi.
 */
export async function communityAccess(db: Queryable, communityId: string, userId: string, lock = false): Promise<CommunityAccess> {
  const { rows } = await db.query<{ name: string; city: string; plan: CommunityPlan; role: CommunityRole; status: string }>(
    `SELECT c.name, c.city, c.plan, m.role, m.status
       FROM communities c JOIN community_members m ON m.community_id = c.id AND m.user_id = $2
       JOIN users u ON u.id = m.user_id AND u.status = 'active'
      WHERE c.id = $1 AND c.removed_at IS NULL ${lock ? 'FOR SHARE OF c' : ''}`,
    [communityId, userId],
  );
  const r = rows[0];
  if (!r || r.status !== 'active') throw communityNotFound();
  return {
    communityId,
    name: r.name,
    city: r.city,
    plan: r.plan,
    role: r.role,
    isStaff: r.role === 'owner' || r.role === 'admin',
    isOwner: r.role === 'owner',
  };
}

export function requireStaff(a: CommunityAccess): CommunityAccess {
  if (!a.isStaff) throw new ApiError(403, 'not_admin', 'Hanya admin komunitas');
  return a;
}

export function requirePro(a: CommunityAccess, feature: ProFeature): CommunityAccess {
  if (!hasProFeature(a.plan, feature)) throw proRequired(feature);
  return a;
}
