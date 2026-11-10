-- Modul 1.6 Chat.

-- Sejak kapan anggota boleh melihat riwayat chat komunitas. NULL = seluruh riwayat.
-- Diisi saat bergabung: komunitas terbuka mengikuti new_members_see_history (bawaan: tidak),
-- persetujuan admin memakai pilihan admin. Anggota yang sudah ada melihat seluruh riwayat.
ALTER TABLE community_members ADD COLUMN history_from timestamptz;

CREATE TABLE conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('direct', 'community')),
  community_id     uuid UNIQUE REFERENCES communities(id) ON DELETE CASCADE,
  -- Chat pribadi: pasangan pengguna terurut (user_a < user_b), satu percakapan per pasangan.
  user_a           uuid REFERENCES users(id) ON DELETE CASCADE,
  user_b           uuid REFERENCES users(id) ON DELETE CASCADE,
  last_message_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_a, user_b),
  CONSTRAINT conversations_shape CHECK (
    (kind = 'community' AND community_id IS NOT NULL AND user_a IS NULL AND user_b IS NULL) OR
    (kind = 'direct' AND community_id IS NULL AND user_a IS NOT NULL AND user_b IS NOT NULL AND user_a < user_b)
  )
);
CREATE INDEX conversations_user_a_idx ON conversations (user_a) WHERE kind = 'direct';
CREATE INDEX conversations_user_b_idx ON conversations (user_b) WHERE kind = 'direct';

CREATE TABLE chat_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Urutan global untuk paging dan sinkronisasi ("pesan setelah seq X").
  seq              bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Dibuat aplikasi; kirim ulang (sinyal putus) tidak membuat pesan ganda.
  client_msg_id    uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('text', 'image', 'run_invite')),
  -- Teks atau JSON ajakan lari, terenkripsi FieldCrypto (AAD chat_messages.body:<id>).
  body_enc         bytea,
  image_key        text,
  -- Gambar dihapus dari penyimpanan setelah 6 bulan; teks tetap.
  image_expired_at timestamptz,
  deleted_at       timestamptz,
  -- Modul 1.8: pesan yang sedang dilaporkan ditahan (tidak bisa dihapus pengirim) sampai laporan selesai.
  held_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sender_id, client_msg_id),
  CONSTRAINT chat_deleted_is_empty CHECK (deleted_at IS NULL OR (body_enc IS NULL AND image_key IS NULL))
);
CREATE INDEX chat_messages_conv_seq_idx ON chat_messages (conversation_id, seq DESC);
CREATE INDEX chat_messages_image_age_idx ON chat_messages (created_at) WHERE image_key IS NOT NULL;

-- Posisi baca per peserta (jumlah belum dibaca).
CREATE TABLE chat_reads (
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_seq    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);

-- Tombol "Ikut" pada kartu ajakan lari bareng.
CREATE TABLE chat_run_invite_rsvps (
  message_id  uuid NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
