-- Modul 2.1 Feed sosial.

-- Postingan: teks, foto (maks. 4), atau hasil lari (merujuk lari yang sudah ada).
-- Teks terenkripsi FieldCrypto (AAD feed_posts.body:<id>), NULL = tanpa teks.
CREATE TABLE feed_posts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('text', 'photo', 'run')),
  body_enc     bytea,
  -- public = semua pengguna Level 1; community = sesama anggota aktif satu komunitas; followers = pengikut.
  visibility   text NOT NULL CHECK (visibility IN ('public', 'community', 'followers')),
  -- Lari yang dihapus pemiliknya: postingan tetap, kartu lari tampil "tidak tersedia".
  run_id       uuid REFERENCES runs(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Dilaporkan: ditahan (tidak bisa dihapus penulis) sampai laporannya selesai.
  held_at      timestamptz,
  -- Disembunyikan otomatis setelah beberapa pelapor (hanya penulis yang masih melihat).
  hidden_at    timestamptz,
  -- Diturunkan super admin: dianggap tidak ada bagi semua orang. Isi dan foto dihapus.
  removed_at   timestamptz,
  CONSTRAINT feed_posts_removed_is_empty CHECK (removed_at IS NULL OR body_enc IS NULL)
);
CREATE INDEX feed_posts_created_idx ON feed_posts (created_at DESC, id DESC) WHERE removed_at IS NULL;
CREATE INDEX feed_posts_user_idx ON feed_posts (user_id, created_at DESC);
-- Satu lari hanya bisa diposting sekali (mencegah spam postingan ganda).
CREATE UNIQUE INDEX feed_posts_one_per_run ON feed_posts (run_id) WHERE run_id IS NOT NULL;

CREATE TABLE feed_post_photos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id      uuid NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  storage_key  text NOT NULL,
  position     smallint NOT NULL CHECK (position BETWEEN 0 AND 3),
  UNIQUE (post_id, position)
);

-- Komentar. Isi terenkripsi FieldCrypto (AAD feed_comments.body:<id>).
CREATE TABLE feed_comments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id      uuid NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body_enc     bytea,
  created_at   timestamptz NOT NULL DEFAULT now(),
  held_at      timestamptz,
  hidden_at    timestamptz,
  removed_at   timestamptz,
  CONSTRAINT feed_comments_removed_is_empty CHECK (removed_at IS NULL OR body_enc IS NULL)
);
CREATE INDEX feed_comments_post_idx ON feed_comments (post_id, created_at, id);
CREATE INDEX feed_comments_user_idx ON feed_comments (user_id);

CREATE TABLE feed_likes (
  post_id     uuid NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX feed_likes_user_idx ON feed_likes (user_id);

-- Mengikuti (satu arah, tanpa persetujuan). Pengguna bisa menghapus pengikut atau memblokirnya.
CREATE TABLE feed_follows (
  follower_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX feed_follows_followee_idx ON feed_follows (followee_id);

-- Blokir di feed: kedua pihak tidak saling melihat konten feed dan tidak bisa saling mengikuti.
CREATE TABLE feed_blocks (
  blocker_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX feed_blocks_blocked_idx ON feed_blocks (blocked_id);

-- Laporan: postingan dan komentar feed bisa dilaporkan.
ALTER TABLE reports DROP CONSTRAINT reports_target_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check
  CHECK (target_type IN ('user', 'community', 'message', 'event', 'post', 'comment'));

-- Notifikasi: kategori "social" (pengikut baru, suka, komentar).
ALTER TABLE notification_prefs DROP CONSTRAINT notification_prefs_disabled_check;
ALTER TABLE notification_prefs ADD CONSTRAINT notification_prefs_disabled_check
  CHECK (disabled <@ ARRAY['chat', 'community', 'run_invite', 'friend_running', 'social']::text[]);
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('community_invite', 'join_request', 'join_approved', 'run_invite', 'new_follower', 'post_like', 'post_comment'));
