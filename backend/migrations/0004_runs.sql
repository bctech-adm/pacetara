-- Modul 1.4 Tracking lari.

-- Radius zona privasi per pengguna: titik rute dalam radius ini dari titik awal dan akhir
-- disembunyikan dari orang lain. Bawaan 250 m.
ALTER TABLE users ADD COLUMN privacy_radius_m integer NOT NULL DEFAULT 250
  CHECK (privacy_radius_m BETWEEN 100 AND 1000);

CREATE TABLE runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Dibuat aplikasi saat merekam; upload ulang (sinyal putus) tidak membuat lari ganda.
  client_run_id       uuid NOT NULL,
  source              text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'health_connect', 'garmin', 'strava')),
  title               text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  notes               text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 2000),
  visibility          text NOT NULL DEFAULT 'community' CHECK (visibility IN ('public', 'community', 'private')),
  started_at          timestamptz NOT NULL,
  ended_at            timestamptz NOT NULL CHECK (ended_at >= started_at),
  -- Statistik dihitung server dari titik GPS, bukan dikirim aplikasi.
  distance_m          integer NOT NULL CHECK (distance_m >= 0),
  moving_time_s       integer NOT NULL CHECK (moving_time_s >= 0),
  elapsed_time_s      integer NOT NULL CHECK (elapsed_time_s >= 0),
  avg_pace_s_per_km   integer CHECK (avg_pace_s_per_km > 0),
  elevation_gain_m    integer,
  -- Rute terenkripsi FieldCrypto (gzip JSON). full = hanya pemilik; public = setelah zona privasi.
  route_full_enc      bytea,
  route_public_enc    bytea,
  point_count         integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_run_id)
);
CREATE TRIGGER runs_updated_at BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX runs_user_started_idx ON runs (user_id, started_at DESC);

CREATE TABLE run_photos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  position    smallint NOT NULL CHECK (position BETWEEN 0 AND 3),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, position)
);
