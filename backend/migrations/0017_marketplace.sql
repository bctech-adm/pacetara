-- Modul 3.2 Marketplace. Tiga model per listing (PRD): biaya listing (bayar pasang/boost lewat Midtrans di dasbor
-- web, transaksi di luar aplikasi), afiliasi (tautan ke toko penjual di marketplace lain), split payment (pembeli
-- membayar lewat Xendit xenPlatform; dana masuk ke akun Xendit penjual, komisi ke akun PaceTara, PaceTara tidak
-- menampung dana).

-- Pembayaran Midtrans milik PaceTara (biaya listing, boost, dan banner sponsor modul 3.3). Status selalu dipastikan
-- ulang ke API status Midtrans; isi notifikasi tidak dipercaya.
CREATE TABLE payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         text NOT NULL UNIQUE,              -- dikirim ke Midtrans; tanpa data pribadi
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  purpose          text NOT NULL CHECK (purpose IN ('listing_fee', 'listing_boost', 'banner')),
  ref_id           uuid NOT NULL,                     -- listing atau banner
  amount           bigint NOT NULL CHECK (amount > 0),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'expired', 'refunded')),
  provider_status  text,
  payment_type     text,
  redirect_url     text,
  paid_at          timestamptz,
  applied_at       timestamptz,                       -- efek (aktifkan listing/banner) sudah diterapkan
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_user_idx ON payments (user_id, created_at DESC);
CREATE INDEX payments_ref_idx ON payments (ref_id);
CREATE INDEX payments_pending_idx ON payments (created_at) WHERE status = 'pending';
CREATE TRIGGER payments_updated_at BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Persetujuan kebijakan transaksi (berversi), wajib sebelum memasang atau membeli.
ALTER TABLE users ADD COLUMN market_policy_version text, ADD COLUMN market_policy_accepted_at timestamptz;

CREATE TABLE market_listings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model          text NOT NULL CHECK (model IN ('listing_fee', 'affiliate', 'split')),
  title          text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 80),
  description    text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  category       text NOT NULL CHECK (category IN ('shoes', 'apparel', 'watch', 'accessory', 'nutrition', 'equipment', 'other')),
  condition      text NOT NULL CHECK (condition IN ('new', 'like_new', 'used')),
  price          bigint NOT NULL CHECK (price BETWEEN 1000 AND 1000000000),
  city           text NOT NULL CHECK (char_length(city) BETWEEN 2 AND 60),
  affiliate_url  text CHECK (affiliate_url IS NULL OR affiliate_url LIKE 'https://%'),
  stock          integer CHECK (stock IS NULL OR stock BETWEEN 0 AND 999),
  status         text NOT NULL CHECK (status IN ('pending_payment', 'active', 'sold', 'expired', 'closed')),
  active_until   timestamptz,
  boosted_until  timestamptz,
  clicks         integer NOT NULL DEFAULT 0,          -- klik tautan afiliasi
  held_at        timestamptz,
  hidden_at      timestamptz,
  removed_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_affiliate_has_url CHECK ((model = 'affiliate') = (affiliate_url IS NOT NULL)),
  CONSTRAINT market_split_has_stock CHECK ((model = 'split') = (stock IS NOT NULL))
);
CREATE INDEX market_listings_feed_idx ON market_listings (boosted_until DESC NULLS LAST, created_at DESC)
  WHERE status = 'active' AND removed_at IS NULL AND hidden_at IS NULL;
CREATE INDEX market_listings_seller_idx ON market_listings (seller_id, created_at DESC);
CREATE TRIGGER market_listings_updated_at BEFORE UPDATE ON market_listings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE market_listing_photos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id   uuid NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  position     smallint NOT NULL CHECK (position BETWEEN 0 AND 5),
  storage_key  text NOT NULL,
  UNIQUE (listing_id, position)
);

-- "Hubungi penjual": membuka chat pribadi pembeli ↔ penjual (pengecualian #85 untuk orang asing).
CREATE TABLE market_contacts (
  listing_id  uuid NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  buyer_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_id, buyer_id)
);
CREATE INDEX market_contacts_pair_idx ON market_contacts (buyer_id, seller_id);

-- Akun penjual split payment = sub-akun Xendit xenPlatform bertipe MANAGED (penjual menyelesaikan verifikasi dan
-- menarik dana sendiri di Xendit). Baris tetap ada setelah hapus akun (user_id NULL) untuk akuntansi.
CREATE TABLE market_seller_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  xendit_account_id  text NOT NULL UNIQUE,
  status             text NOT NULL CHECK (status IN ('invited', 'registered', 'awaiting_docs', 'live', 'suspended')),
  suspended_reason   text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER market_seller_accounts_updated_at BEFORE UPDATE ON market_seller_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Pesanan split payment. Disimpan untuk akuntansi/sengketa walau akun dihapus (id pengguna dikosongkan).
CREATE TABLE market_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id         text NOT NULL UNIQUE,           -- dikirim ke Xendit; tanpa data pribadi
  listing_id          uuid REFERENCES market_listings(id) ON DELETE SET NULL,
  buyer_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  seller_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  xendit_account_id   text NOT NULL,
  title               text NOT NULL,
  qty                 integer NOT NULL CHECK (qty BETWEEN 1 AND 10),
  unit_price          bigint NOT NULL CHECK (unit_price > 0),
  amount              bigint NOT NULL CHECK (amount > 0),
  fee_amount          bigint NOT NULL CHECK (fee_amount >= 0),
  status              text NOT NULL CHECK (status IN ('pending', 'paid', 'shipped', 'completed', 'cancelled', 'expired', 'disputed', 'refunded')),
  xendit_invoice_id   text UNIQUE,
  invoice_url         text,
  tracking_note       text CHECK (tracking_note IS NULL OR char_length(tracking_note) <= 200),
  dispute_reason_enc  bytea,                          -- FieldCrypto, AAD market_orders.dispute:<id>
  dispute_opened_at   timestamptz,
  resolution_note     text,
  resolved_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  paid_at             timestamptz,
  shipped_at          timestamptz,
  completed_at        timestamptz,
  closed_at           timestamptz,                    -- dibatalkan/kedaluwarsa/refund
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX market_orders_buyer_idx ON market_orders (buyer_id, created_at DESC);
CREATE INDEX market_orders_seller_idx ON market_orders (seller_id, created_at DESC);
CREATE INDEX market_orders_open_idx ON market_orders (status, created_at) WHERE status IN ('pending', 'paid', 'shipped', 'disputed');
CREATE TRIGGER market_orders_updated_at BEFORE UPDATE ON market_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Nilai yang dibuat sekali di penyedia (mis. id split rule Xendit per besaran komisi).
CREATE TABLE provider_settings (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Laporan listing; notifikasi marketplace (kategori pengaturan `market`).
ALTER TABLE reports DROP CONSTRAINT reports_target_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check
  CHECK (target_type IN ('user', 'community', 'message', 'event', 'post', 'comment', 'spot', 'listing'));
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('community_invite', 'join_request', 'join_approved', 'run_invite', 'new_follower', 'post_like', 'post_comment', 'badge_earned',
                  'event_submission_approved', 'event_submission_rejected',
                  'session_new', 'session_cancelled', 'buddy_request', 'buddy_accepted', 'spot_approved', 'spot_rejected',
                  'kyc_approved', 'kyc_rejected', 'kyc_revoked',
                  'market_order_paid', 'market_order_shipped', 'market_order_completed', 'market_order_disputed', 'market_order_resolved',
                  'market_seller_live', 'market_listing_paid'));
ALTER TABLE notification_prefs DROP CONSTRAINT notification_prefs_disabled_check;
ALTER TABLE notification_prefs ADD CONSTRAINT notification_prefs_disabled_check
  CHECK (disabled <@ ARRAY['chat', 'community', 'run_invite', 'friend_running', 'social', 'achievement', 'event', 'schedule', 'buddy', 'account', 'market']::text[]);
