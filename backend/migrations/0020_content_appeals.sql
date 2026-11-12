-- Banding atas penurunan konten (melengkapi banding akun di 0006).
-- Setiap penurunan konten yang punya pemilik dicatat agar pemilik diberi tahu dan bisa mengajukan banding 14 hari.
-- Tidak menyimpan isi konten: isi pesan/postingan/komentar sudah dihapus saat diturunkan (privasi).
CREATE TABLE content_removals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type   text NOT NULL CHECK (target_type IN ('message', 'community', 'event', 'post', 'listing', 'spot', 'comment')),
  target_id     uuid NOT NULL,
  -- Ringkasan non-pribadi untuk ditampilkan ke pemilik (judul listing/komunitas/event/spot); null untuk teks bebas.
  label         text CHECK (char_length(label) <= 120),
  -- Komunitas, event, spot, dan listing bisa dipulihkan (barisnya tetap ada); pesan/postingan/komentar tidak.
  restorable    boolean NOT NULL,
  removed_at    timestamptz NOT NULL DEFAULT now(),
  removed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  appeal_until  timestamptz NOT NULL,
  restored_at   timestamptz,
  UNIQUE (target_type, target_id)
);
CREATE INDEX content_removals_owner_idx ON content_removals (owner_id, removed_at DESC);

-- Banding: target kosong = banding akun (perilaku lama); terisi = banding atas penurunan konten.
ALTER TABLE appeals ADD COLUMN removal_id uuid REFERENCES content_removals(id) ON DELETE CASCADE;
DROP INDEX appeals_one_open;
CREATE UNIQUE INDEX appeals_one_open ON appeals (user_id) WHERE status = 'open' AND removal_id IS NULL;
-- Satu banding per penurunan (diputuskan sekali).
CREATE UNIQUE INDEX appeals_one_per_removal ON appeals (removal_id) WHERE removal_id IS NOT NULL;

ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('community_invite', 'join_request', 'join_approved', 'run_invite', 'new_follower', 'post_like', 'post_comment', 'badge_earned',
                  'event_submission_approved', 'event_submission_rejected',
                  'session_new', 'session_cancelled', 'buddy_request', 'buddy_accepted', 'spot_approved', 'spot_rejected',
                  'kyc_approved', 'kyc_rejected', 'kyc_revoked',
                  'market_order_paid', 'market_order_shipped', 'market_order_completed', 'market_order_disputed', 'market_order_resolved',
                  'market_seller_live', 'market_listing_paid', 'banner_approved', 'banner_rejected',
                  'plan_activated', 'plan_ended', 'community_plan_activated', 'community_plan_ended',
                  'content_removed', 'content_appeal_accepted', 'content_appeal_rejected'));
