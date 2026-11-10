#!/bin/sh
# Deploy otomatis berbasis tarik (pull): VPS memantau GHCR, GitHub tidak punya akses ke VPS.
#
# Setiap INTERVAL detik: tarik image `latest` layanan PaceTara. `docker compose up -d` hanya membuat
# ulang container yang image-nya berubah; service `migrate` ikut jalan ulang sehingga migrasi
# database terpasang sebelum API naik (depends_on: service_completed_successfully).
#
# Tag `latest` hanya dipasang CI setelah SEMUA tes dan pemindaian Trivy lolos (job `promote`).
# Perubahan berkas Compose/Traefik TIDAK ikut otomatis; itu tetap deploy manual.
set -u

STACK_DIR="${STACK_DIR:?STACK_DIR wajib}"
INTERVAL="${INTERVAL:-300}"
SERVICES="migrate api worker wa-otp admin web backup"
cd "$STACK_DIR"
C="docker compose -f docker-compose.yml -f docker-compose.vps.yml"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

if ! grep -q '^IMAGE_TAG=latest$' .env; then
  log "PERINGATAN: IMAGE_TAG di .env bukan 'latest'; deployer hanya menarik ulang tag yang terpasang."
fi

log "deployer mulai (interval ${INTERVAL} dtk, layanan: $SERVICES)"
while true; do
  before=$(docker inspect --format '{{.Image}}' pacetara-api 2>/dev/null || echo none)
  if $C pull --quiet $SERVICES >/tmp/pull.log 2>&1; then
    out=$($C up -d --no-build $SERVICES 2>&1)
    after=$(docker inspect --format '{{.Image}}' pacetara-api 2>/dev/null || echo none)
    if echo "$out" | grep -qE 'Recreated|Created'; then
      log "image baru dipasang:"
      echo "$out" | grep -E 'Recreated|Created' | sed 's/^/  /'
      # Tunggu API sehat (healthcheck container), maksimal 2 menit.
      i=0
      status=unknown
      while [ $i -lt 24 ]; do
        status=$(docker inspect --format '{{.State.Health.Status}}' pacetara-api 2>/dev/null || echo missing)
        [ "$status" = healthy ] && break
        i=$((i + 1))
        sleep 5
      done
      if [ "$status" = healthy ]; then
        log "deploy selesai, API sehat (image ${after#sha256:})"
      else
        log "GAGAL: API tidak sehat setelah deploy (status: $status, image sebelumnya ${before#sha256:}). Periksa: docker logs pacetara-api"
      fi
    fi
  else
    log "gagal menarik image:"
    sed 's/^/  /' /tmp/pull.log | tail -5
  fi
  sleep "$INTERVAL"
done
