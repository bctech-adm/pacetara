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

# App Links Android: /.well-known/assetlinks.json hanya jika ANDROID_CERT_SHA256 diisi (sidik jari SHA-256 sertifikat
# penandatangan APK, format AA:BB:..., boleh beberapa dipisah koma: kunci unggah + kunci Play App Signing).
# Tanpa nilai: 404, sehingga Android tidak memverifikasi dan tautan /j/KODE tetap membuka halaman cadangan.
mkdir -p /tmp/app-ads/.well-known
rm -f /tmp/app-ads/.well-known/assetlinks.json
certs="${ANDROID_CERT_SHA256:-}"
pkg="${ANDROID_PACKAGE:-tech.bimacreative.pacetara}"
if [ -n "$certs" ]; then
  list=""
  ok=1
  for c in $(printf '%s' "$certs" | tr ',' ' '); do
    if printf '%s' "$c" | grep -Eq '^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$'; then
      list="${list:+$list,}\"$(printf '%s' "$c" | tr 'a-f' 'A-F')\""
    else
      ok=0
    fi
  done
  if [ "$ok" = 1 ] && printf '%s' "$pkg" | grep -Eq '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'; then
    printf '[{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app","package_name":"%s","sha256_cert_fingerprints":[%s]}}]\n' \
      "$pkg" "$list" > /tmp/app-ads/.well-known/assetlinks.json
  else
    echo "ANDROID_CERT_SHA256/ANDROID_PACKAGE tidak valid; assetlinks.json tidak ditayangkan" >&2
  fi
fi
exec nginx -e /dev/stderr -g 'daemon off;'
