-- Modul 1.2 Akun dan login.

-- Kode verifikasi sekali pakai (email, nomor HP, reset kata sandi).
-- Kode mentah tidak pernah disimpan; hanya HMAC-nya. Target (email/HP yang sedang diverifikasi)
-- disimpan terenkripsi karena belum tentu sama dengan data di tabel users.
CREATE TABLE verification_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose       text NOT NULL CHECK (purpose IN ('email_verify', 'phone_verify', 'password_reset')),
  channel       text NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  target_enc    bytea NOT NULL,
  target_bidx   bytea NOT NULL,
  code_hmac     bytea NOT NULL,
  attempts      smallint NOT NULL DEFAULT 0,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_codes_active_idx
  ON verification_codes (user_id, purpose, created_at DESC) WHERE consumed_at IS NULL;

-- Pengaturan notifikasi dll. ditambah modul lain; di sini cukup kolom profil yang belum ada.
ALTER TABLE users ADD COLUMN avatar_updated_at timestamptz;

-- Level 1 = email DAN nomor HP terverifikasi. Level 2 (KTP) diatur modul 3.1 dan tidak diturunkan di sini.
CREATE OR REPLACE FUNCTION users_compute_level() RETURNS trigger AS $$
BEGIN
  IF NEW.verification_level < 2 THEN
    NEW.verification_level := CASE
      WHEN NEW.email_verified_at IS NOT NULL AND NEW.phone_verified_at IS NOT NULL THEN 1
      ELSE 0
    END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_level BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION users_compute_level();

-- Akun yang dihapus dianonimkan: tidak boleh ada data pribadi tersisa.
ALTER TABLE users ADD CONSTRAINT users_deleted_is_anonymous CHECK (
  status <> 'deleted' OR (
    email_enc IS NULL AND email_bidx IS NULL AND phone_enc IS NULL AND phone_bidx IS NULL
    AND password_hash IS NULL AND google_sub IS NULL AND avatar_key IS NULL AND nik_hmac IS NULL
    AND city IS NULL
  )
);
