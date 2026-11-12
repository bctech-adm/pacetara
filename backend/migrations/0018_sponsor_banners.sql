-- Modul 3.3 Banner sponsor dan dasbor swalayan. Sponsor (Level 2) mengunggah banner di dasbor web, memilih slot,
-- kota sasaran, dan periode, membayar lewat Midtrans (tabel payments, purpose 'banner'), lalu banner tayang setelah
-- disetujui super admin dan turun otomatis saat periode habis (dihitung dari tanggal, WIB).

CREATE TABLE sponsor_banners (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsor_id     uuid REFERENCES users(id) ON DELETE SET NULL,   -- dikosongkan saat hapus akun (catatan akuntansi tetap)
  slot           text NOT NULL CHECK (slot IN ('home', 'events', 'event_detail')),
  title          text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 80),  -- teks alternatif / judul kecil
  event_id       uuid REFERENCES events(id) ON DELETE SET NULL,
  target_url     text CHECK (target_url IS NULL OR target_url LIKE 'https://%'),
  cities         text[] NOT NULL DEFAULT '{}',                    -- kosong = nasional; disimpan huruf kecil
  starts_on      date NOT NULL,
  days           integer NOT NULL CHECK (days BETWEEN 1 AND 90),
  image_key      text,
  amount         bigint NOT NULL CHECK (amount > 0),
  status         text NOT NULL DEFAULT 'pending_payment'
                   CHECK (status IN ('pending_payment', 'pending_review', 'approved', 'rejected', 'cancelled')),
  reject_reason  text,
  paid_at        timestamptz,
  reviewed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- Slot detail event wajib tertaut ke event; slot lain tertaut ke event atau tautan https (atau tanpa tautan).
  CONSTRAINT banner_event_detail_has_event CHECK (slot <> 'event_detail' OR event_id IS NOT NULL OR status IN ('rejected', 'cancelled')),
  CONSTRAINT banner_one_target CHECK (NOT (event_id IS NOT NULL AND target_url IS NOT NULL))
);
CREATE INDEX sponsor_banners_active_idx ON sponsor_banners (slot, starts_on) WHERE status = 'approved';
CREATE INDEX sponsor_banners_sponsor_idx ON sponsor_banners (sponsor_id, created_at DESC);
CREATE TRIGGER sponsor_banners_updated_at BEFORE UPDATE ON sponsor_banners FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Statistik harian (WIB) agregat. Tayangan dan klik unik per pengguna per hari (dedup lewat Redis); tidak ada
-- data pengguna di tabel ini.
CREATE TABLE sponsor_banner_stats (
  banner_id    uuid NOT NULL REFERENCES sponsor_banners(id) ON DELETE CASCADE,
  day          date NOT NULL,
  impressions  integer NOT NULL DEFAULT 0,
  clicks       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (banner_id, day)
);

-- Notifikasi hasil tinjauan banner ke sponsor (kategori pengaturan `market`).
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('community_invite', 'join_request', 'join_approved', 'run_invite', 'new_follower', 'post_like', 'post_comment', 'badge_earned',
                  'event_submission_approved', 'event_submission_rejected',
                  'session_new', 'session_cancelled', 'buddy_request', 'buddy_accepted', 'spot_approved', 'spot_rejected',
                  'kyc_approved', 'kyc_rejected', 'kyc_revoked',
                  'market_order_paid', 'market_order_shipped', 'market_order_completed', 'market_order_disputed', 'market_order_resolved',
                  'market_seller_live', 'market_listing_paid', 'banner_approved', 'banner_rejected'));
