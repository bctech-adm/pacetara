#!/bin/sh
# Memulihkan cadangan. Jalankan di mesin target dengan private key age:
#   docker compose run --rm -v /path/key.txt:/key.txt:ro -e AGE_IDENTITY=/key.txt \
#     backup restore.sh 20261110T193000Z
# Hentikan layanan yang menulis data lebih dulu: docker compose stop api worker s3
# Sumber: BACKUP_REMOTE (jika diisi) atau /backups lokal.
set -eu

STAMP="${1:?pakai: restore.sh <STAMP>}"
: "${AGE_IDENTITY:?AGE_IDENTITY (path private key age) wajib diisi}"
SRC="/backups/${STAMP}"

if [ ! -d "$SRC" ] && [ -n "${BACKUP_REMOTE:-}" ]; then
  echo "Mengunduh $STAMP dari $BACKUP_REMOTE..."
  mkdir -p "$SRC"
  rclone copy "$BACKUP_REMOTE/$STAMP" "$SRC" --config /config/rclone.conf
fi
[ -d "$SRC" ] || { echo "Cadangan $STAMP tidak ditemukan"; exit 1; }

( cd "$SRC" && sha256sum -c SHA256SUMS )

echo "Memulihkan PostgreSQL (database $PGDATABASE akan ditimpa)..."
age -d -i "$AGE_IDENTITY" "$SRC/postgres.dump.age" \
  | pg_restore --clean --if-exists --no-owner --no-acl --single-transaction -d "$PGDATABASE"

if [ -f "$SRC/s3.tar.age" ] && [ -d /s3-data ]; then
  echo "Memulihkan berkas penyimpanan objek..."
  age -d -i "$AGE_IDENTITY" "$SRC/s3.tar.age" | tar -C /s3-data -xf -
fi
echo "Pemulihan selesai. Jalankan ulang: docker compose up -d"
