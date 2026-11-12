-- Modul 2.3 Impor data lari (Health Connect, Garmin, Strava).

-- true  = statistik dihitung server dari titik GPS (lari aplikasi, atau impor yang membawa rute).
-- false = statistik dilaporkan sumber lain tanpa rute (treadmill, jam tanpa GPS, entri manual).
-- Liga dan papan peringkat (modul 2.6) hanya boleh menghitung lari dengan stats_verified = true.
ALTER TABLE runs ADD COLUMN stats_verified boolean NOT NULL DEFAULT true;
-- Lari Strava wajib privat (PRD 2.3, keputusan #63); ditegakkan juga di database.
ALTER TABLE runs ADD CONSTRAINT runs_strava_private CHECK (source <> 'strava' OR visibility = 'private');
-- Pencarian tumpang-tindih waktu untuk deduplikasi.
CREATE INDEX runs_user_ended_idx ON runs (user_id, ended_at);

-- Akun penyedia yang terhubung (OAuth). Token disimpan terenkripsi FieldCrypto.
-- external_user_hmac = HMAC berkunci atas id pengguna di penyedia (Garmin userId / Strava athlete id),
-- dipakai mencocokkan notifikasi webhook tanpa menyimpan id itu dalam bentuk terbaca.
CREATE TABLE import_connections (
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider            text NOT NULL CHECK (provider IN ('garmin', 'strava')),
  external_user_hmac  bytea NOT NULL,
  access_token_enc    bytea NOT NULL,
  refresh_token_enc   bytea,
  token_expires_at    timestamptz,
  scope               text NOT NULL DEFAULT '',
  connected_at        timestamptz NOT NULL DEFAULT now(),
  last_sync_at        timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider),
  UNIQUE (provider, external_user_hmac)
);
CREATE TRIGGER import_connections_updated_at BEFORE UPDATE ON import_connections FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Catatan setiap aktivitas yang pernah diterima, idempoten per (pengguna, sumber, id eksternal).
-- status: imported (menjadi lari), duplicate (tumpang-tindih dengan lari lain yang prioritasnya sama/lebih tinggi),
-- skipped (bukan lari, atau data tidak masuk akal). run_id = lari hasil impor atau lari yang menjadi duplikatnya.
CREATE TABLE import_records (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source       text NOT NULL CHECK (source IN ('health_connect', 'garmin', 'strava')),
  external_id  text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 128),
  status       text NOT NULL CHECK (status IN ('imported', 'duplicate', 'skipped')),
  run_id       uuid REFERENCES runs(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source, external_id)
);
CREATE TRIGGER import_records_updated_at BEFORE UPDATE ON import_records FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX import_records_run_idx ON import_records (run_id) WHERE run_id IS NOT NULL;
