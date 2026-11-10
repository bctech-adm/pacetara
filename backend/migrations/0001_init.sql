-- Skema awal PaceTara (modul 1.1).
-- Kolom *_enc berisi ciphertext FieldCrypto (AES-256-GCM, dienkripsi di aplikasi).
-- Kolom *_bidx berisi blind index HMAC-SHA256 untuk pencarian dan keunikan.
-- Tabel per fitur (komunitas, lari, chat, dst.) ditambahkan oleh migrasi modulnya masing-masing.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  email_enc             bytea,
  email_bidx            bytea UNIQUE,
  email_verified_at     timestamptz,

  phone_enc             bytea,
  phone_bidx            bytea UNIQUE,
  phone_verified_at     timestamptz,

  password_hash         text,                -- Argon2id; NULL untuk akun Google saja
  google_sub            text UNIQUE,

  display_name          text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 60),
  avatar_key            text,                -- kunci objek di MinIO, bukan URL
  city                  text,
  avg_pace_sec_per_km   integer CHECK (avg_pace_sec_per_km BETWEEN 120 AND 1800),

  -- 0: baru daftar, 1: email + HP terverifikasi, 2: KTP + selfie
  verification_level    smallint NOT NULL DEFAULT 0 CHECK (verification_level BETWEEN 0 AND 2),
  nik_hmac              bytea UNIQUE,        -- HMAC berkunci (bukan hash biasa), hanya Level 2

  role                  text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'super_admin')),
  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'suspended', 'banned', 'deleted')),

  privacy_accepted_at   timestamptz,
  privacy_version       text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,

  CONSTRAINT users_login_method CHECK (status = 'deleted' OR password_hash IS NOT NULL OR google_sub IS NOT NULL)
);

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Token penyegar dirotasi; family_id untuk mendeteksi pemakaian ulang token lama
-- (jika token yang sudah dirotasi dipakai lagi, seluruh family dicabut).
CREATE TABLE refresh_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id     uuid NOT NULL,
  token_hash    bytea NOT NULL UNIQUE,       -- SHA-256 dari token acak; token mentah tidak disimpan
  device_label  text,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  replaced_by   uuid REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

-- Log tindakan super admin (PRD 1.8). Hanya bisa ditambah, tidak diubah atau dihapus oleh aplikasi.
CREATE TABLE admin_audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  action        text NOT NULL,
  target_type   text,
  target_id     text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_log_created_idx ON admin_audit_log (created_at DESC);

CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log hanya boleh ditambah';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER admin_audit_log_immutable BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
