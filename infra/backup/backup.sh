#!/bin/sh
# Cadangan terenkripsi PostgreSQL + penyimpanan objek.
# Wajib: PGHOST PGUSER PGPASSWORD PGDATABASE AGE_RECIPIENT
# Opsional: BACKUP_REMOTE (remote rclone, mis. "b2:pacetara-backup"), BACKUP_KEEP_DAYS (bawaan 30)
# Private key age TIDAK pernah disimpan di VPS; hanya public key (AGE_RECIPIENT).
set -eu

: "${AGE_RECIPIENT:?AGE_RECIPIENT wajib diisi}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="/backups/${STAMP}"
mkdir -p "$OUT"
umask 077

echo "[$STAMP] pg_dump..."
pg_dump --format=custom --no-owner --no-acl | age -r "$AGE_RECIPIENT" -o "$OUT/postgres.dump.age"

if [ -d /s3-data ]; then
  echo "[$STAMP] arsip penyimpanan objek..."
  tar -C /s3-data -cf - . | age -r "$AGE_RECIPIENT" -o "$OUT/s3.tar.age"
fi

( cd "$OUT" && sha256sum ./*.age > SHA256SUMS )

if [ -n "${BACKUP_REMOTE:-}" ]; then
  echo "[$STAMP] unggah ke $BACKUP_REMOTE..."
  rclone copy "$OUT" "$BACKUP_REMOTE/$STAMP" --config /config/rclone.conf
  rclone delete "$BACKUP_REMOTE" --min-age "${BACKUP_KEEP_DAYS:-30}d" --config /config/rclone.conf || true
else
  echo "PERINGATAN: BACKUP_REMOTE kosong, cadangan hanya ada di VPS (tidak memenuhi PRD)."
fi

# Simpan salinan lokal 3 hari terakhir saja.
find /backups -mindepth 1 -maxdepth 1 -type d -mtime +3 -exec rm -rf {} +
echo "[$STAMP] selesai"
