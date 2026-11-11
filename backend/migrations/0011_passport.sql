-- Modul 2.2 Riwayat dan paspor lari.

-- Siapa yang boleh melihat paspor lari (medali, hasil resmi, lencana) pengguna ini.
-- community = sesama anggota aktif satu komunitas (bawaan, sama dengan lari); private = hanya pemilik.
ALTER TABLE users ADD COLUMN passport_visibility text NOT NULL DEFAULT 'community'
  CHECK (passport_visibility IN ('community', 'private'));

-- Rak medali: foto medali fisik (WebP hasil processImage, EXIF/GPS terbuang) + keterangan.
-- Batas jumlah per paket ada di backend/src/plans/plans.ts (MEDAL_LIMIT).
CREATE TABLE passport_medals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  -- Opsional: event di kalender yang ditandai ikut oleh pemilik. Event dihapus = tautan lepas, medali tetap.
  event_id     uuid REFERENCES events(id) ON DELETE SET NULL,
  event_date   date,
  category     text CHECK (category IN ('fun', '5k', '10k', 'hm', 'fm', 'ultra', 'other')),
  storage_key  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX passport_medals_user_idx ON passport_medals (user_id, created_at DESC);

-- Hasil resmi event (diisi pengguna, tidak diverifikasi penyelenggara).
CREATE TABLE passport_results (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id         uuid REFERENCES events(id) ON DELETE SET NULL,
  -- Nama dan tanggal disalin dari event saat ditautkan, agar hasil tetap utuh jika event berubah/dihapus.
  event_name       text NOT NULL CHECK (char_length(event_name) BETWEEN 3 AND 120),
  event_date       date NOT NULL,
  category         text NOT NULL CHECK (category IN ('fun', '5k', '10k', 'hm', 'fm', 'ultra', 'other')),
  distance_m       integer CHECK (distance_m BETWEEN 100 AND 500000),
  official_time_s  integer NOT NULL CHECK (official_time_s BETWEEN 60 AND 604800),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER passport_results_updated_at BEFORE UPDATE ON passport_results FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX passport_results_user_idx ON passport_results (user_id, event_date DESC);
-- Satu hasil per event kalender per pengguna.
CREATE UNIQUE INDEX passport_results_one_per_event ON passport_results (user_id, event_id) WHERE event_id IS NOT NULL;

-- Lencana pencapaian otomatis. Dihitung server (idempoten) saat lari disimpan dan saat paspor dibuka.
-- private_only = hanya tercapai berkat lari impor Strava: tetap milik pemilik, tidak ditampilkan ke orang lain (PRD 2.3).
CREATE TABLE user_badges (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code          text NOT NULL,
  achieved_at   timestamptz NOT NULL,
  private_only  boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, code)
);

-- Notifikasi: kategori "achievement" (lencana baru).
ALTER TABLE notification_prefs DROP CONSTRAINT notification_prefs_disabled_check;
ALTER TABLE notification_prefs ADD CONSTRAINT notification_prefs_disabled_check
  CHECK (disabled <@ ARRAY['chat', 'community', 'run_invite', 'friend_running', 'social', 'achievement']::text[]);
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('community_invite', 'join_request', 'join_approved', 'run_invite', 'new_follower', 'post_like', 'post_comment', 'badge_earned'));
