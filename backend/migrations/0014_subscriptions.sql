-- Modul 2.5 Langganan: Google Play Billing (Premium per pengguna, Komunitas Pro / Pro Unlimited per komunitas).
-- users.plan dan communities.plan (modul 1.3) tetap menjadi sumber yang dibaca semua batas paket; nilainya
-- dihitung ulang server dari tabel di bawah (compute_user_plan / compute_community_plan) dan TIDAK PERNAH
-- diubah oleh aplikasi.

-- Satu baris per purchaseToken Google Play. Token hanya terikat ke satu akun/komunitas (token_hash unik).
CREATE TABLE play_subscriptions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 purchaseToken: kunci pencocokan RTDN, voidedPurchases, dan linkedPurchaseToken.
  token_hash        bytea NOT NULL UNIQUE,
  -- purchaseToken terenkripsi FieldCrypto (AAD play_subscriptions.token:<id>), untuk memanggil ulang API Google.
  -- NULL setelah hapus akun (catatan akuntansi tetap, tanpa tautan ke akun Google).
  token_enc         bytea,
  product_id        text NOT NULL CHECK (char_length(product_id) BETWEEN 1 AND 150),
  kind              text NOT NULL CHECK (kind IN ('premium', 'pro', 'pro_unlimited')),
  -- Pembeli. NULL setelah hapus akun.
  user_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Komunitas yang dilanggankan (Pro). NULL untuk Premium, atau setelah komunitas dihapus.
  community_id      uuid REFERENCES communities(id) ON DELETE SET NULL,
  -- subscriptionState Google tanpa awalan SUBSCRIPTION_STATE_ (ACTIVE, CANCELED, IN_GRACE_PERIOD, ON_HOLD,
  -- PAUSED, EXPIRED, PENDING, PENDING_PURCHASE_CANCELED, ...).
  state             text NOT NULL CHECK (state ~ '^[A-Z_]{1,40}$'),
  expires_at        timestamptz,
  auto_renewing     boolean NOT NULL DEFAULT false,
  acknowledged      boolean NOT NULL DEFAULT false,
  test_purchase     boolean NOT NULL DEFAULT false,
  -- Id pesanan Google (GPA.…) untuk akuntansi/refund; bukan data pribadi.
  order_id          text CHECK (order_id IS NULL OR char_length(order_id) <= 100),
  -- Refund/pencabutan (voidedPurchaseNotification, SUBSCRIPTION_REVOKED, voidedPurchases.list).
  revoked_at        timestamptz,
  -- Token baru yang menggantikan token ini (upgrade/downgrade/berlangganan ulang lewat linkedPurchaseToken).
  replaced_by       uuid REFERENCES play_subscriptions(id) ON DELETE SET NULL,
  last_checked_at   timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX play_subscriptions_user_idx ON play_subscriptions (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX play_subscriptions_community_idx ON play_subscriptions (community_id) WHERE community_id IS NOT NULL;
CREATE INDEX play_subscriptions_expiry_idx ON play_subscriptions (expires_at) WHERE revoked_at IS NULL AND replaced_by IS NULL;

-- Pemberian paket manual oleh super admin (uji tanpa Play / kompensasi). Selalu berbatas waktu, tercatat di
-- admin_audit_log.
CREATE TABLE plan_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  community_id  uuid REFERENCES communities(id) ON DELETE CASCADE,
  plan          text NOT NULL CHECK (plan IN ('premium', 'pro', 'pro_unlimited')),
  expires_at    timestamptz NOT NULL,
  reason        text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  granted_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_grants_target CHECK (
    (plan = 'premium' AND user_id IS NOT NULL AND community_id IS NULL)
    OR (plan <> 'premium' AND community_id IS NOT NULL AND user_id IS NULL)
  )
);
CREATE INDEX plan_grants_user_idx ON plan_grants (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX plan_grants_community_idx ON plan_grants (community_id) WHERE community_id IS NOT NULL;

-- Idempotensi Real-time Developer Notifications (Pub/Sub messageId). Dibersihkan setelah 30 hari.
CREATE TABLE play_rtdn_messages (
  message_id    text PRIMARY KEY CHECK (char_length(message_id) BETWEEN 1 AND 200),
  kind          text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now()
);

-- Langganan Play memberi hak jika belum dicabut/diganti, statusnya aktif/dibatalkan-tapi-masih-berjalan/masa
-- tenggang, dan belum lewat masa berlaku. ON_HOLD, PAUSED, EXPIRED, PENDING = tanpa hak.
CREATE FUNCTION play_subscription_entitled(s play_subscriptions) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT s.revoked_at IS NULL AND s.replaced_by IS NULL
     AND s.state IN ('ACTIVE', 'CANCELED', 'IN_GRACE_PERIOD')
     AND s.expires_at IS NOT NULL AND s.expires_at > now()
$$;

CREATE FUNCTION compute_user_plan(uid uuid) RETURNS text
  LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN EXISTS (
           SELECT 1 FROM play_subscriptions s
            WHERE s.user_id = uid AND s.kind = 'premium' AND play_subscription_entitled(s))
         OR EXISTS (
           SELECT 1 FROM plan_grants g
            WHERE g.user_id = uid AND g.plan = 'premium' AND g.revoked_at IS NULL AND g.expires_at > now())
       THEN 'premium' ELSE 'free' END
$$;

CREATE FUNCTION compute_community_plan(cid uuid) RETURNS text
  LANGUAGE sql STABLE AS $$
  WITH p AS (
    SELECT s.kind AS plan FROM play_subscriptions s
     WHERE s.community_id = cid AND s.kind IN ('pro', 'pro_unlimited') AND play_subscription_entitled(s)
    UNION ALL
    SELECT g.plan FROM plan_grants g
     WHERE g.community_id = cid AND g.plan IN ('pro', 'pro_unlimited') AND g.revoked_at IS NULL AND g.expires_at > now()
  )
  SELECT CASE WHEN EXISTS (SELECT 1 FROM p WHERE plan = 'pro_unlimited') THEN 'pro_unlimited'
              WHEN EXISTS (SELECT 1 FROM p WHERE plan = 'pro') THEN 'pro'
              ELSE 'free' END
$$;
