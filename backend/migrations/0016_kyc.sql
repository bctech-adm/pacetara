-- Modul 3.1 Verifikasi Level 2 (KTP + selfie).
-- Foto KTP dan selfie TIDAK PERNAH disimpan (diproses di memori API). Yang disimpan:
-- - users.nik_hmac (HMAC berkunci, sudah ada sejak 0001) dan users.kyc_verified_at untuk akun Level 2;
-- - satu baris per percobaan: hasil, alasan, dan skor (tanpa data pribadi) untuk batas laju, audit, dan kalibrasi;
-- - khusus percobaan yang menunggu tinjauan manual: nik_hmac + nama hasil OCR/ketikan terenkripsi (review_data_enc),
--   dihapus begitu ditinjau atau kedaluwarsa (constraint kyc_review_data_only_pending).

ALTER TABLE users ADD COLUMN kyc_verified_at timestamptz;

CREATE TABLE kyc_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- approved: lolos otomatis atau disetujui admin; review: menunggu tinjauan; rejected: ditolak admin;
  -- retry: kualitas foto/NIK salah ketik (pengguna mengulang); expired: tinjauan tidak diputuskan dalam 30 hari;
  -- revoked: Level 2 dicabut admin setelah disetujui.
  status           text NOT NULL CHECK (status IN ('approved', 'review', 'rejected', 'retry', 'expired', 'revoked')),
  auto             boolean NOT NULL DEFAULT true,   -- keputusan mesin (true) atau admin (false)
  reasons          text[] NOT NULL DEFAULT '{}',
  face_score       real,
  selfie_real      real,
  selfie_live      real,
  ocr_confidence   real,
  name_score       real,
  consent_version  text NOT NULL,
  nik_hmac         bytea,
  review_data_enc  bytea,                            -- FieldCrypto JSON {ocrName, enteredName}, AAD kyc_attempts.review:<id>
  review_note      text CHECK (review_note IS NULL OR char_length(review_note) <= 300),
  reviewed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kyc_review_data_only_pending CHECK (status = 'review' OR (nik_hmac IS NULL AND review_data_enc IS NULL))
);
CREATE INDEX kyc_attempts_user_idx ON kyc_attempts (user_id, created_at DESC);
CREATE INDEX kyc_attempts_review_idx ON kyc_attempts (created_at) WHERE status = 'review';
-- Satu tinjauan menunggu per pengguna.
CREATE UNIQUE INDEX kyc_attempts_one_review ON kyc_attempts (user_id) WHERE status = 'review';

-- Notifikasi hasil tinjauan manual dan pencabutan (kategori pengaturan `account`).
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('community_invite', 'join_request', 'join_approved', 'run_invite', 'new_follower', 'post_like', 'post_comment', 'badge_earned',
                  'event_submission_approved', 'event_submission_rejected',
                  'session_new', 'session_cancelled', 'buddy_request', 'buddy_accepted', 'spot_approved', 'spot_rejected',
                  'kyc_approved', 'kyc_rejected', 'kyc_revoked'));
ALTER TABLE notification_prefs DROP CONSTRAINT notification_prefs_disabled_check;
ALTER TABLE notification_prefs ADD CONSTRAINT notification_prefs_disabled_check
  CHECK (disabled <@ ARRAY['chat', 'community', 'run_invite', 'friend_running', 'social', 'achievement', 'event', 'schedule', 'buddy', 'account']::text[]);
