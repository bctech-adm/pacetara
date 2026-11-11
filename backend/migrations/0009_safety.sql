-- Modul 1.10 Mode aman (SOS). Gratis untuk semua pengguna (REVIEW-PRD A1).

-- Kontak darurat pilihan pengguna (maks. 3). Data pihak ketiga: nama dan nomor terenkripsi FieldCrypto
-- (AAD emergency_contacts.name:<id> / emergency_contacts.phone:<id>); blind index hanya untuk mencegah duplikat.
CREATE TABLE emergency_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name_enc    bytea NOT NULL,
  phone_enc   bytea NOT NULL,
  phone_bidx  bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, phone_bidx)
);
CREATE INDEX emergency_contacts_user_idx ON emergency_contacts (user_id);

-- Catatan SOS untuk batas laju dan jejak audit. Lokasi TIDAK disimpan.
CREATE TABLE sos_alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contacts    smallint NOT NULL,
  delivered   smallint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sos_alerts_user_idx ON sos_alerts (user_id, created_at DESC);
