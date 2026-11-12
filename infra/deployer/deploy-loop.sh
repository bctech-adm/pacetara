#!/bin/sh
# Deploy otomatis berbasis tarik (pull): VPS memantau GHCR, GitHub tidak punya akses ke VPS.
#
# Setiap INTERVAL detik: tarik image `latest` layanan PaceTara. `docker compose up -d` hanya membuat
# ulang container yang image-nya berubah; service `migrate` ikut jalan ulang sehingga migrasi
# database terpasang sebelum API naik (depends_on: service_completed_successfully).
#
# Rollback otomatis: sebelum memasang, image yang sedang dipakai setiap layanan dicatat. Jika API tidak sehat
# dalam 2 menit, tag lokal dikembalikan ke image lama dan layanan dijalankan ulang tanpa menarik image. Image API
# yang gagal diingat (BAD_FILE), sehingga putaran berikutnya tidak memasangnya lagi sampai CI menerbitkan `latest`
# yang baru. Migrasi database TIDAK dibatalkan (hanya maju, dan dibuat aditif agar image lama tetap berjalan).
#
# Tag `latest` hanya dipasang CI setelah SEMUA tes dan pemindaian Trivy lolos (job `promote`).
# Perubahan berkas Compose/Traefik TIDAK ikut otomatis; itu tetap deploy manual.
set -u

STACK_DIR="${STACK_DIR:?STACK_DIR wajib}"
INTERVAL="${INTERVAL:-300}"
HEALTH_TRIES="${HEALTH_TRIES:-24}"
HEALTH_SLEEP="${HEALTH_SLEEP:-5}"
SERVICES="migrate api worker wa-otp admin web backup"
# Layanan yang berjalan terus (migrate selesai lalu berhenti, tidak di-rollback).
RUNNING="api worker wa-otp admin web backup"
BAD_FILE="${BAD_FILE:-/tmp/pacetara-bad-images}"
cd "$STACK_DIR"
C="docker compose -f docker-compose.yml -f docker-compose.vps.yml"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# Image (id) dan referensi tag yang dipakai container layanan; kosong jika container belum ada.
container_of() { $C ps -q "$1" 2>/dev/null | head -n1; }
image_id_of() { c=$(container_of "$1"); [ -n "$c" ] && docker inspect --format '{{.Image}}' "$c" 2>/dev/null; }
image_ref_of() { c=$(container_of "$1"); [ -n "$c" ] && docker inspect --format '{{.Config.Image}}' "$c" 2>/dev/null; }
api_health() { c=$(container_of api); [ -n "$c" ] && docker inspect --format '{{.State.Health.Status}}' "$c" 2>/dev/null || echo missing; }

wait_healthy() {
  i=0
  status=unknown
  while [ "$i" -lt "$HEALTH_TRIES" ]; do
    status=$(api_health)
    [ "$status" = healthy ] && return 0
    i=$((i + 1))
    sleep "$HEALTH_SLEEP"
  done
  return 1
}

if ! grep -q '^IMAGE_TAG=latest$' .env; then
  log "PERINGATAN: IMAGE_TAG di .env bukan 'latest'; deployer hanya menarik ulang tag yang terpasang."
fi
touch "$BAD_FILE"

log "deployer mulai (interval ${INTERVAL} dtk, layanan: $SERVICES)"
while true; do
  # Catat keadaan sebelum menarik: "layanan referensi id" per baris.
  snapshot=""
  for s in $RUNNING; do
    id=$(image_id_of "$s")
    ref=$(image_ref_of "$s")
    [ -n "$id" ] && [ -n "$ref" ] && snapshot="${snapshot}${s} ${ref} ${id}
"
  done

  if $C pull --quiet $SERVICES >/tmp/pull.log 2>&1; then
    api_ref=$(printf '%s' "$snapshot" | awk '$1 == "api" { print $2 }')
    pulled_api=""
    [ -n "$api_ref" ] && pulled_api=$(docker image inspect --format '{{.Id}}' "$api_ref" 2>/dev/null || true)
    if [ -n "$pulled_api" ] && grep -qx "$pulled_api" "$BAD_FILE"; then
      # Image API yang sama dengan yang gagal sebelumnya: jangan pasang lagi (tag lokal dikembalikan).
      printf '%s' "$snapshot" | while read -r s ref id; do [ -n "$s" ] && docker tag "$id" "$ref"; done
      sleep "$INTERVAL"
      continue
    fi

    out=$($C up -d --no-build $SERVICES 2>&1)
    if echo "$out" | grep -qE 'Recreated|Created'; then
      log "image baru dipasang:"
      echo "$out" | grep -E 'Recreated|Created' | sed 's/^/  /'
      if wait_healthy; then
        log "deploy selesai, API sehat (image $(image_id_of api | sed 's/^sha256://'))"
      else
        bad=$(image_id_of api)
        log "GAGAL: API tidak sehat setelah deploy (status: $(api_health)). Rollback ke image sebelumnya."
        [ -n "$bad" ] && echo "$bad" >>"$BAD_FILE"
        changed=""
        # `while read` di subshell: kumpulkan layanan yang berubah lewat berkas sementara.
        : >/tmp/rollback.list
        printf '%s' "$snapshot" | while read -r s ref id; do
          [ -z "$s" ] && continue
          now=$(image_id_of "$s")
          if [ "$now" != "$id" ]; then
            docker tag "$id" "$ref" && echo "$s" >>/tmp/rollback.list
          fi
        done
        changed=$(tr '\n' ' ' </tmp/rollback.list)
        if [ -n "$changed" ]; then
          # --no-deps: jangan jalankan ulang migrate (migrasi hanya maju).
          rb=$($C up -d --no-build --no-deps --pull never $changed 2>&1) || true
          echo "$rb" | grep -E 'Recreated|Created|Error' | sed 's/^/  /'
          if wait_healthy; then
            log "rollback selesai, API sehat kembali (layanan: $changed). Periksa log image yang gagal: docker logs pacetara-api"
          else
            log "ROLLBACK GAGAL: API tetap tidak sehat (status: $(api_health)). Perlu tindakan manual."
          fi
        else
          log "tidak ada image sebelumnya untuk dikembalikan (deploy pertama?). Perlu tindakan manual."
        fi
      fi
    fi
  else
    log "gagal menarik image:"
    sed 's/^/  /' /tmp/pull.log | tail -5
  fi
  sleep "$INTERVAL"
done
