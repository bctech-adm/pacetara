-- Modul 2.6 Fitur komunitas lanjutan: jadwal lari + RSVP, absensi (QR/GPS, Pro), liga antar komunitas (Pro),
-- cari teman lari, kas komunitas + pre-order jersey (Pro, pencatatan saja), peta spot lari.
-- Semua tabel milik komunitas memakai ON DELETE CASCADE ke communities: hapus komunitas = data turunannya ikut terhapus.
-- Akun yang dihapus tidak menghapus baris users (anonimisasi, #30), jadi langkah hapus akun ditulis eksplisit di
-- masing-masing service (onAccountDeletion).

-- ---------- Jadwal lari rutin + sesi + RSVP ----------

CREATE TABLE community_schedules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id        uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  title               text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 80),
  -- Hari ISO: 1 = Senin ... 7 = Minggu, jam setempat di zona [timezone].
  weekday             smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_time          time NOT NULL,
  timezone            text NOT NULL DEFAULT 'Asia/Jakarta' CHECK (timezone IN ('Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura')),
  location_name       text NOT NULL CHECK (char_length(location_name) BETWEEN 2 AND 120),
  -- Titik kumpul (tempat umum yang dipilih admin, bukan lokasi pribadi). Wajib untuk check-in GPS.
  lat                 double precision CHECK (lat BETWEEN -90 AND 90),
  lng                 double precision CHECK (lng BETWEEN -180 AND 180),
  distance_m          integer CHECK (distance_m BETWEEN 100 AND 100000),
  pace_target_s_per_km integer CHECK (pace_target_s_per_km BETWEEN 150 AND 1200),
  notes               text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 500),
  -- Pengingat push untuk yang RSVP "ikut", dipilih admin per jadwal.
  remind              boolean NOT NULL DEFAULT true,
  active              boolean NOT NULL DEFAULT true,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedules_point CHECK ((lat IS NULL) = (lng IS NULL))
);
CREATE TRIGGER community_schedules_updated_at BEFORE UPDATE ON community_schedules FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX community_schedules_community_idx ON community_schedules (community_id) WHERE active;

-- Sesi = satu kejadian lari (dari jadwal rutin, atau sesi sekali jalan tanpa jadwal).
CREATE TABLE community_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id        uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  schedule_id         uuid REFERENCES community_schedules(id) ON DELETE SET NULL,
  title               text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 80),
  starts_at           timestamptz NOT NULL,
  timezone            text NOT NULL DEFAULT 'Asia/Jakarta' CHECK (timezone IN ('Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura')),
  location_name       text NOT NULL CHECK (char_length(location_name) BETWEEN 2 AND 120),
  lat                 double precision CHECK (lat BETWEEN -90 AND 90),
  lng                 double precision CHECK (lng BETWEEN -180 AND 180),
  distance_m          integer CHECK (distance_m BETWEEN 100 AND 100000),
  pace_target_s_per_km integer CHECK (pace_target_s_per_km BETWEEN 150 AND 1200),
  notes               text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 500),
  remind              boolean NOT NULL DEFAULT true,
  cancelled_at        timestamptz,
  reminder_sent_at    timestamptz,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_point CHECK ((lat IS NULL) = (lng IS NULL))
);
-- Pembentukan sesi dari jadwal idempoten (job worker dan permintaan bisa berjalan bersamaan).
CREATE UNIQUE INDEX community_sessions_schedule_start ON community_sessions (schedule_id, starts_at) WHERE schedule_id IS NOT NULL;
CREATE INDEX community_sessions_community_idx ON community_sessions (community_id, starts_at);
CREATE INDEX community_sessions_reminder_idx ON community_sessions (starts_at) WHERE reminder_sent_at IS NULL AND cancelled_at IS NULL AND remind;

CREATE TABLE session_rsvps (
  session_id  uuid NOT NULL REFERENCES community_sessions(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  going       boolean NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, user_id)
);
CREATE INDEX session_rsvps_user_idx ON session_rsvps (user_id);

-- Absensi (Komunitas Pro). Lokasi check-in GPS TIDAK disimpan: hanya hasil (hadir, cara, waktu).
CREATE TABLE session_attendance (
  session_id  uuid NOT NULL REFERENCES community_sessions(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method      text NOT NULL CHECK (method IN ('qr', 'gps', 'manual')),
  checked_at  timestamptz NOT NULL DEFAULT now(),
  -- Admin yang menandai manual.
  marked_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (session_id, user_id)
);
CREATE INDEX session_attendance_user_idx ON session_attendance (user_id);

-- ---------- Liga antar komunitas (Pro) ----------

-- Snapshot bulanan per komunitas, dihitung worker. Hanya angka agregat (tanpa detail lari atau nama pelari).
CREATE TABLE league_snapshots (
  month           date NOT NULL CHECK (extract(day FROM month) = 1),
  community_id    uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  city_key        text NOT NULL,
  city            text NOT NULL,
  total_m         bigint NOT NULL CHECK (total_m >= 0),
  runs            integer NOT NULL CHECK (runs >= 0),
  active_members  integer NOT NULL CHECK (active_members >= 0),
  -- Skor = total_m / GREATEST(active_members, LEAGUE_MIN_DIVISOR) (meter per anggota aktif).
  score           integer NOT NULL CHECK (score >= 0),
  rank            integer NOT NULL CHECK (rank >= 1),
  computed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (month, community_id)
);
CREATE INDEX league_snapshots_city_idx ON league_snapshots (month, city_key, rank);

-- Indeks untuk agregasi liga/statistik (lari per pengguna per waktu sudah ada: runs_user_started_idx).

-- ---------- Cari teman lari ----------

-- Profil pencarian opt-in (bawaan: tidak ada baris = tidak terlihat). Area = titik yang DIPILIH pengguna sendiri
-- di peta, dibulatkan server ke grid ±2 km (bukan dari rute atau GPS), sehingga aman untuk PostGIS (#61).
CREATE TABLE buddy_profiles (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled         boolean NOT NULL DEFAULT true,
  pace_s_per_km   integer NOT NULL CHECK (pace_s_per_km BETWEEN 180 AND 1200),
  city            text NOT NULL CHECK (char_length(city) BETWEEN 2 AND 60),
  city_key        text NOT NULL,
  area            geography(Point, 4326),
  -- Jam lari favorit (lihat BUDDY_SLOTS di buddies.service.ts).
  slots           text[] NOT NULL DEFAULT '{}' CHECK (slots <@ ARRAY['subuh', 'pagi', 'siang', 'sore', 'malam']::text[]),
  consented_at    timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER buddy_profiles_updated_at BEFORE UPDATE ON buddy_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX buddy_profiles_city_idx ON buddy_profiles (city_key) WHERE enabled;
CREATE INDEX buddy_profiles_area_idx ON buddy_profiles USING gist (area) WHERE enabled;

-- Sapa: harus diterima penerima sebelum chat pribadi terbuka (#85 tetap berlaku untuk orang asing).
CREATE TABLE buddy_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  CHECK (from_user <> to_user),
  UNIQUE (from_user, to_user)
);
CREATE INDEX buddy_requests_to_idx ON buddy_requests (to_user, status);

-- ---------- Kas komunitas + pre-order jersey (Pro, pencatatan saja) ----------

CREATE TABLE community_cash_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('in', 'out')),
  -- Rupiah bulat.
  amount        bigint NOT NULL CHECK (amount BETWEEN 1 AND 1000000000000),
  category      text NOT NULL CHECK (category IN ('iuran', 'sponsor', 'donasi', 'jersey', 'event', 'perlengkapan', 'konsumsi', 'operasional', 'lainnya')),
  occurred_on   date NOT NULL,
  description   text NOT NULL DEFAULT '' CHECK (char_length(description) <= 200),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER community_cash_entries_updated_at BEFORE UPDATE ON community_cash_entries FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX community_cash_entries_idx ON community_cash_entries (community_id, occurred_on DESC, created_at DESC);

CREATE TABLE jersey_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id    uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 80),
  description     text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  price           bigint NOT NULL CHECK (price BETWEEN 0 AND 100000000),
  sizes           text[] NOT NULL CHECK (cardinality(sizes) BETWEEN 1 AND 12),
  order_deadline  timestamptz NOT NULL,
  closed_at       timestamptz,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jersey_items_community_idx ON jersey_items (community_id, created_at DESC);

CREATE TABLE jersey_orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL REFERENCES jersey_items(id) ON DELETE CASCADE,
  -- NULL = pemesan menghapus akun setelah pesanannya ditandai lunas (catatan admin tetap, tanpa identitas).
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  size        text NOT NULL CHECK (char_length(size) BETWEEN 1 AND 10),
  quantity    smallint NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  note        text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  paid        boolean NOT NULL DEFAULT false,
  paid_marked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  paid_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER jersey_orders_updated_at BEFORE UPDATE ON jersey_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE UNIQUE INDEX jersey_orders_one_per_size ON jersey_orders (item_id, user_id, size) WHERE user_id IS NOT NULL;
CREATE INDEX jersey_orders_user_idx ON jersey_orders (user_id) WHERE user_id IS NOT NULL;

-- ---------- Peta spot lari ----------

CREATE TABLE run_spots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL setelah pengirim menghapus akun (spot yang sudah tayang = informasi tempat umum, tetap ada).
  submitted_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 80),
  city          text NOT NULL CHECK (char_length(city) BETWEEN 2 AND 60),
  location      geography(Point, 4326) NOT NULL,
  -- Penerangan: 0 = tidak ada, 1 = sebagian, 2 = terang. NULL = tidak diketahui.
  lighting      smallint CHECK (lighting BETWEEN 0 AND 2),
  toilet        boolean,
  parking       boolean,
  notes         text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 300),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reject_reason text CHECK (reject_reason IS NULL OR char_length(reject_reason) BETWEEN 3 AND 300),
  reviewed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at   timestamptz,
  hidden_at     timestamptz,
  removed_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER run_spots_updated_at BEFORE UPDATE ON run_spots FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX run_spots_location_idx ON run_spots USING gist (location) WHERE status = 'approved' AND removed_at IS NULL;
CREATE INDEX run_spots_status_idx ON run_spots (status, created_at);
CREATE INDEX run_spots_submitter_idx ON run_spots (submitted_by, created_at) WHERE submitted_by IS NOT NULL;

-- Laporan: sasaran baru "spot".
ALTER TABLE reports DROP CONSTRAINT reports_target_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check
  CHECK (target_type IN ('user', 'community', 'message', 'event', 'post', 'comment', 'spot'));

-- Notifikasi: kategori "schedule" (sesi baru, pengingat, dibatalkan) dan "buddy" (sapa cari teman).
-- Persetujuan/penolakan spot memakai kategori "event" (kiriman).
ALTER TABLE notification_prefs DROP CONSTRAINT notification_prefs_disabled_check;
ALTER TABLE notification_prefs ADD CONSTRAINT notification_prefs_disabled_check
  CHECK (disabled <@ ARRAY['chat', 'community', 'run_invite', 'friend_running', 'social', 'achievement', 'event', 'schedule', 'buddy']::text[]);
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('community_invite', 'join_request', 'join_approved', 'run_invite', 'new_follower', 'post_like', 'post_comment', 'badge_earned',
                  'event_submission_approved', 'event_submission_rejected',
                  'session_new', 'session_cancelled', 'buddy_request', 'buddy_accepted', 'spot_approved', 'spot_rejected'));
