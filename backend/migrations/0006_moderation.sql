-- Modul 1.8 Laporan konten dan panel super admin.

-- 2FA super admin: rahasia TOTP terenkripsi FieldCrypto (AAD users.totp:<id>). Diisi lewat skrip CLI.
ALTER TABLE users ADD COLUMN totp_secret_enc bytea;
-- Penangguhan sementara: NULL = tanpa batas waktu. Dipulihkan otomatis saat login setelah lewat.
ALTER TABLE users ADD COLUMN suspended_until timestamptz;

-- Sesi panel admin (login dengan kata sandi + TOTP). Hanya token dari sesi ini yang boleh membuka /v1/admin.
ALTER TABLE refresh_tokens ADD COLUMN admin_session boolean NOT NULL DEFAULT false;

-- Pesan disembunyikan otomatis setelah beberapa laporan, sambil menunggu tinjauan.
ALTER TABLE chat_messages ADD COLUMN hidden_at timestamptz;
-- Diturunkan super admin (tombstone seperti dihapus pengirim, tetapi dengan keterangan berbeda).
ALTER TABLE chat_messages ADD COLUMN removed_by_admin boolean NOT NULL DEFAULT false;

-- Komunitas: disembunyikan dari direktori (otomatis) atau diturunkan (super admin, tidak bisa diakses).
ALTER TABLE communities ADD COLUMN hidden_at timestamptz;
ALTER TABLE communities ADD COLUMN removed_at timestamptz;

CREATE TABLE reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type  text NOT NULL CHECK (target_type IN ('user', 'community', 'message', 'event')),
  target_id    uuid NOT NULL,
  reason       text NOT NULL CHECK (reason IN ('spam', 'harassment', 'hate', 'sexual', 'violence', 'scam', 'impersonation', 'other')),
  -- Keterangan bebas dari pelapor, terenkripsi (AAD reports.details:<id>).
  details_enc  bytea,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  resolved_by  uuid REFERENCES users(id) ON DELETE SET NULL
);
-- Satu laporan terbuka per pelapor per sasaran (lapor ulang tidak menggandakan hitungan).
CREATE UNIQUE INDEX reports_one_open_per_reporter ON reports (reporter_id, target_type, target_id) WHERE status = 'open';
CREATE INDEX reports_open_target_idx ON reports (target_type, target_id) WHERE status = 'open';
CREATE INDEX reports_created_idx ON reports (created_at DESC);

CREATE TABLE appeals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Isi banding terenkripsi (AAD appeals.message:<id>).
  message_enc    bytea NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz,
  decided_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  decision_note  text CHECK (char_length(decision_note) <= 500)
);
CREATE UNIQUE INDEX appeals_one_open ON appeals (user_id) WHERE status = 'open';
