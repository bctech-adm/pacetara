#!/bin/sh
# app-ads.txt (modul 2.7): ditayangkan di /app-ads.txt hanya jika ADMOB_PUBLISHER_ID (pub-XXXXXXXXXXXXXXXX dari
# AdMob → Pengaturan → Informasi akun) diisi di .env. Tanpa nilai: 404, bukan berkas kosong/palsu, karena berkas
# app-ads.txt yang tidak mencantumkan penerbit kita justru membuat AdMob berhenti menayangkan iklan.
# Ditulis ke /tmp (tmpfs) karena filesystem container read-only.
set -eu
mkdir -p /tmp/app-ads
rm -f /tmp/app-ads/app-ads.txt
pub="${ADMOB_PUBLISHER_ID:-}"
if [ -n "$pub" ]; then
  if printf '%s' "$pub" | grep -Eq '^pub-[0-9]{10,20}$'; then
    # f08c47fec0942fa0 = ID otoritas sertifikasi (TAG) Google, sama untuk semua penerbit AdMob.
    printf 'google.com, %s, DIRECT, f08c47fec0942fa0\n' "$pub" > /tmp/app-ads/app-ads.txt
  else
    echo "ADMOB_PUBLISHER_ID tidak valid (format pub-<16 digit>); app-ads.txt tidak ditayangkan" >&2
  fi
fi
exec nginx -e /dev/stderr -g 'daemon off;'
