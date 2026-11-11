-- Modul 1.9 Notifikasi.

-- Token FCM per perangkat. Terikat ke sesi login (family token penyegar): logout/pencabutan sesi
-- menghapus tokennya sehingga perangkat yang sudah keluar tidak menerima push lagi.
CREATE TABLE push_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  uuid NOT NULL,
  -- SHA-256 token untuk keunikan; token asli terenkripsi FieldCrypto (AAD push_tokens.token:<id>).
  token_hash  bytea NOT NULL UNIQUE,
  token_enc   bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_tokens_user_idx ON push_tokens (user_id);
CREATE INDEX push_tokens_session_idx ON push_tokens (session_id);

-- Pengaturan push per jenis. Disimpan yang dimatikan saja (bawaan: semua menyala).
CREATE TABLE notification_prefs (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  disabled    text[] NOT NULL DEFAULT '{}' CHECK (disabled <@ ARRAY['chat', 'community', 'run_invite', 'friend_running']::text[]),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Kotak notifikasi di aplikasi. Hanya id (tanpa isi pesan atau data pribadi); nama ditampilkan saat dibaca,
-- sehingga akun yang dihapus otomatis tampil "Pengguna dihapus".
CREATE TABLE notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          text NOT NULL CHECK (type IN ('community_invite', 'join_request', 'join_approved', 'run_invite')),
  actor_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  community_id  uuid REFERENCES communities(id) ON DELETE CASCADE,
  data          jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- Undangan langsung admin komunitas ke pengguna tertentu (ditunda dari modul 1.3, KEPUTUSAN #51).
CREATE TABLE community_invitations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz
);
CREATE UNIQUE INDEX community_invitations_one_pending ON community_invitations (community_id, user_id) WHERE status = 'pending';
CREATE INDEX community_invitations_user_idx ON community_invitations (user_id) WHERE status = 'pending';
