-- Modul 1.7 Kalender event (manual). Event dimasukkan super admin lewat panel.

CREATE TABLE events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 120),
  -- Tanggal event (waktu setempat penyelenggara). Diarsipkan otomatis sehari setelahnya.
  event_date        date NOT NULL,
  -- Jam mulai (opsional, waktu setempat).
  start_time        time,
  city              text NOT NULL CHECK (char_length(city) BETWEEN 2 AND 60),
  venue             text NOT NULL DEFAULT '' CHECK (char_length(venue) <= 160),
  description       text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  -- Kategori jarak; minimal satu.
  categories        text[] NOT NULL CHECK (
    cardinality(categories) BETWEEN 1 AND 7
    AND categories <@ ARRAY['fun', '5k', '10k', 'hm', 'fm', 'ultra', 'other']::text[]
  ),
  -- Tautan pendaftaran resmi; hanya https.
  registration_url  text NOT NULL CHECK (char_length(registration_url) <= 500 AND registration_url LIKE 'https://%'),
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Diisi job worker `event-archive` sehari setelah event_date.
  archived_at       timestamptz,
  -- Modul 1.8: disembunyikan otomatis setelah beberapa laporan, atau diturunkan super admin.
  hidden_at         timestamptz,
  removed_at        timestamptz
);
-- Mencegah event yang sama dimasukkan dua kali.
CREATE UNIQUE INDEX events_name_date_uniq ON events (lower(name), event_date);
CREATE INDEX events_upcoming_idx ON events (event_date, id) WHERE archived_at IS NULL AND removed_at IS NULL;
CREATE INDEX events_city_idx ON events (lower(city)) WHERE archived_at IS NULL AND removed_at IS NULL;

-- "Siapa ikut?": pengguna yang menandai ikut. Nama hanya terlihat oleh sesama anggota aktif satu komunitas.
CREATE TABLE event_participants (
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX event_participants_user_idx ON event_participants (user_id);

-- Kartu "bagikan event" di chat (ditunda dari modul 1.6).
ALTER TABLE chat_messages DROP CONSTRAINT chat_messages_kind_check;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_kind_check CHECK (kind IN ('text', 'image', 'run_invite', 'event'));
