#!/bin/sh
# Bangun (atau perbarui) data tile peta Indonesia, lalu nyalakan/muat ulang tileserver. Jalankan dari folder stack:
#   ./infra/tiles/build-tiles.sh            # VPS bersama (docker-compose.vps.yml ikut dipakai)
#   LOCAL=1 ./infra/tiles/build-tiles.sh    # lokal (hanya docker-compose.yml)
# Data: OpenStreetMap (ODbL) via Geofabrik, diolah Planetiler ke skema OpenMapTiles. Butuh ±4 GB disk sementara dan
# RAM sesuai TILES_BUILD_JAVA_OPTS (bawaan -Xmx2g); ±15–40 menit. Perbarui sebulan sekali sudah cukup.
# Berkas ditulis ke nama sementara dan baru menggantikan yang lama setelah selesai, jadi peta tidak padam saat build.
set -eu

if [ "${LOCAL:-}" = "1" ]; then
  C="docker compose"
else
  C="docker compose -f docker-compose.yml -f docker-compose.vps.yml"
fi

echo "[tiles] membangun indonesia.new.mbtiles dengan Planetiler..."
$C --profile tiles-build run --rm tiles-build

echo "[tiles] memasang berkas baru dan membersihkan unduhan sementara..."
$C --profile tiles-build run --rm --no-deps --entrypoint sh tiles-build -c \
  'test -s /data/indonesia.new.mbtiles && mv -f /data/indonesia.new.mbtiles /data/indonesia.mbtiles && rm -rf /data/sources /data/tmp'

echo "[tiles] menjalankan ulang tileserver..."
$C --profile tiles up -d --force-recreate tiles
echo "[tiles] selesai. Cek: https://<API_DOMAIN>/tiles/styles/basic-preview/5/25/16.png"
