-- Modul 2.4 Engine event: hasil scraping dan kiriman penyelenggara masuk antrean, tayang setelah disetujui.

-- Asal dan sumber event yang tayang. Event manual (modul 1.7) = 'admin' tanpa sumber
-- (aplikasi menampilkan "Tim PaceTara" + tautan pendaftaran sebagai halaman resmi).
ALTER TABLE events
  ADD COLUMN origin      text NOT NULL DEFAULT 'admin' CHECK (origin IN ('admin', 'scrape', 'user')),
  ADD COLUMN source_name text CHECK (source_name IS NULL OR char_length(source_name) BETWEEN 2 AND 80),
  ADD COLUMN source_url  text CHECK (source_url IS NULL OR (char_length(source_url) <= 500 AND source_url LIKE 'https://%'));

-- Antrean. Baris di sini TIDAK PERNAH terlihat di /v1/events; hanya baris `events` yang tayang.
CREATE TABLE event_submissions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origin                 text NOT NULL CHECK (origin IN ('scrape', 'user')),
  -- Scraping: id sumber (EVENT_SCRAPE_SOURCES) + kunci event di sumber (URL halaman event / nama+tanggal).
  source_id              text CHECK (source_id IS NULL OR source_id ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  external_key           text CHECK (external_key IS NULL OR char_length(external_key) <= 500),
  -- Kiriman pengguna (Level 1). Hapus akun: kiriman menunggu dihapus, sisanya dianonimkan (NULL).
  submitted_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'merged')),
  name                   text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 120),
  event_date             date NOT NULL,
  start_time             time,
  -- Boleh kosong untuk hasil scraping; super admin wajib mengisinya sebelum menyetujui.
  city                   text NOT NULL DEFAULT '' CHECK (char_length(city) <= 60),
  venue                  text NOT NULL DEFAULT '' CHECK (char_length(venue) <= 160),
  description            text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  categories             text[] NOT NULL CHECK (
    cardinality(categories) BETWEEN 1 AND 7
    AND categories <@ ARRAY['fun', '5k', '10k', 'hm', 'fm', 'ultra', 'other']::text[]
  ),
  registration_url       text NOT NULL CHECK (char_length(registration_url) <= 500 AND registration_url LIKE 'https://%'),
  -- Sumber dan halaman resmi (selalu ada, ikut ke events saat disetujui).
  source_name            text NOT NULL CHECK (char_length(source_name) BETWEEN 2 AND 80),
  source_url             text NOT NULL CHECK (char_length(source_url) <= 500 AND source_url LIKE 'https://%'),
  -- Kontak penyelenggara (email/HP) dari kiriman pengguna: FieldCrypto, AAD event_submissions.contact:<id>.
  organizer_contact_enc  bytea,
  -- Event hasil persetujuan, atau event tujuan penggabungan.
  event_id               uuid REFERENCES events(id) ON DELETE SET NULL,
  reject_reason          text CHECK (reject_reason IS NULL OR char_length(reject_reason) <= 300),
  reviewed_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK ((origin = 'scrape') = (source_id IS NOT NULL AND external_key IS NOT NULL))
);
-- Scraping ulang idempoten: satu baris per (sumber, event di sumber).
CREATE UNIQUE INDEX event_submissions_external_uniq ON event_submissions (source_id, external_key) WHERE origin = 'scrape';
CREATE INDEX event_submissions_status_idx ON event_submissions (status, event_date);
-- Batas kiriman harian per pengguna + daftar "Kiriman saya".
CREATE INDEX event_submissions_user_idx ON event_submissions (submitted_by, created_at DESC) WHERE submitted_by IS NOT NULL;

-- Ringkasan putaran scraping terakhir per sumber (ditampilkan di panel).
CREATE TABLE event_scrape_runs (
  source_id    text PRIMARY KEY,
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz,
  pages        int NOT NULL DEFAULT 0,
  found        int NOT NULL DEFAULT 0,
  created      int NOT NULL DEFAULT 0,
  updated      int NOT NULL DEFAULT 0,
  skipped      int NOT NULL DEFAULT 0,
  -- Hanya kode/pesan galat singkat (host + status), tanpa isi halaman.
  errors       text[] NOT NULL DEFAULT '{}'
);

-- Notifikasi: kategori "event" (kiriman disetujui/ditolak).
ALTER TABLE notification_prefs DROP CONSTRAINT notification_prefs_disabled_check;
ALTER TABLE notification_prefs ADD CONSTRAINT notification_prefs_disabled_check
  CHECK (disabled <@ ARRAY['chat', 'community', 'run_invite', 'friend_running', 'social', 'achievement', 'event']::text[]);
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('community_invite', 'join_request', 'join_approved', 'run_invite', 'new_follower', 'post_like', 'post_comment', 'badge_earned',
                  'event_submission_approved', 'event_submission_rejected'));
