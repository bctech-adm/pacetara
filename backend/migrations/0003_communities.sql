-- Modul 1.3 Komunitas.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Paket berbayar. Hanya diubah server (verifikasi Google Play di modul 2.5), tidak pernah oleh aplikasi.
ALTER TABLE users ADD COLUMN plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'premium'));

CREATE TABLE communities (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 60),
  city                      text NOT NULL CHECK (char_length(city) BETWEEN 2 AND 60),
  description               text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  logo_key                  text,
  logo_updated_at           timestamptz,
  visibility                text NOT NULL DEFAULT 'open' CHECK (visibility IN ('open', 'private')),
  -- Melekat pada komunitas, bukan pada akun admin (PRD: lencana Pro).
  plan                      text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'pro_unlimited')),
  -- Modul 1.6: apakah anggota baru di komunitas terbuka melihat riwayat chat lama. Bawaan: tidak.
  new_members_see_history   boolean NOT NULL DEFAULT false,
  owner_id                  uuid NOT NULL REFERENCES users(id),
  -- Jumlah anggota aktif (termasuk pemilik), dijaga di transaksi yang sama dengan perubahan anggota.
  member_count              integer NOT NULL DEFAULT 0 CHECK (member_count >= 0),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER communities_updated_at BEFORE UPDATE ON communities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX communities_city_idx ON communities (lower(city));
CREATE INDEX communities_name_trgm_idx ON communities USING gin (lower(name) gin_trgm_ops);
CREATE INDEX communities_city_trgm_idx ON communities USING gin (lower(city) gin_trgm_ops);
CREATE INDEX communities_owner_idx ON communities (owner_id);
CREATE INDEX communities_directory_idx ON communities (member_count DESC, id);

CREATE TABLE community_members (
  community_id   uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role           text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  -- pending = menunggu persetujuan admin (komunitas privat); banned = dikeluarkan dan diblokir.
  status         text NOT NULL CHECK (status IN ('active', 'pending', 'banned')),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  joined_at      timestamptz,
  decided_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (community_id, user_id),
  CONSTRAINT member_owner_is_active CHECK (role <> 'owner' OR status = 'active'),
  CONSTRAINT member_staff_is_active CHECK (role = 'member' OR status = 'active')
);
CREATE INDEX community_members_user_idx ON community_members (user_id, status);
CREATE INDEX community_members_pending_idx ON community_members (community_id, requested_at) WHERE status = 'pending';
-- Tepat satu pemilik per komunitas.
CREATE UNIQUE INDEX community_one_owner ON community_members (community_id) WHERE role = 'owner';

CREATE TABLE community_invites (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id   uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  code           text NOT NULL UNIQUE CHECK (code ~ '^[A-Z2-9]{8}$'),
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at     timestamptz NOT NULL,
  max_uses       integer CHECK (max_uses IS NULL OR max_uses > 0),
  uses           integer NOT NULL DEFAULT 0,
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX community_invites_community_idx ON community_invites (community_id) WHERE revoked_at IS NULL;
