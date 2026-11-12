#!/usr/bin/env sh
# Membuat .env dari .env.example dengan semua rahasia acak.
#   ./scripts/init-env.sh           → konfigurasi produksi
#   ./scripts/init-env.sh --local   → domain localhost untuk mencoba di mesin sendiri
set -eu
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  echo ".env sudah ada; tidak ditimpa." >&2
  exit 1
fi

rand_b64() { openssl rand -base64 32 | tr -d '\n'; }
rand_hex() { openssl rand -hex 24; }

cp .env.example .env
set_var() {
  # Nilai base64 bisa mengandung '/', jadi pakai pemisah '|'.
  sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak
}

set_var POSTGRES_PASSWORD "$(rand_hex)"
set_var REDIS_PASSWORD "$(rand_hex)"
set_var DATA_ENCRYPTION_KEY "$(rand_b64)"
set_var BLIND_INDEX_KEY "$(rand_b64)"
set_var JWT_SECRET "$(rand_b64)"
set_var WA_OTP_SHARED_SECRET "$(rand_hex)"
set_var S3_SECRET_KEY "$(rand_hex)"
# Hanya dipakai jika Garmin dikonfigurasi (modul 2.3); diisi acak agar siap pakai.
set_var GARMIN_PUSH_KEY "$(rand_hex)"
set_var STRAVA_WEBHOOK_VERIFY_TOKEN "$(rand_hex)"
# Langganan Google Play (modul 2.5) tidak punya rahasia acak: GOOGLE_PLAY_PACKAGE_NAME, PLAY_SERVICE_ACCOUNT_B64,
# dan PLAY_RTDN_* diisi manual dari Play Console / Google Cloud (README). Kosong = langganan mati.

if [ "${1:-}" = "--local" ]; then
  set_var API_DOMAIN api.localhost
  set_var ADMIN_DOMAIN admin.localhost
  set_var WEB_DOMAIN web.localhost
  set_var HTTP_PORT 8080
  set_var HTTPS_PORT 8443
  set_var CORS_ORIGINS https://admin.localhost:8443
  echo "API_PUBLIC_URL=https://api.localhost:8443" >> .env
  set_var NODE_ENV development
  set_var REGISTRY local
  set_var SMTP_HOST mailpit
  set_var SMTP_PORT 1025
  # Kunci age sekali pakai untuk lokal saja.
  if command -v age-keygen >/dev/null 2>&1; then
    set_var BACKUP_AGE_RECIPIENT "$(age-keygen 2>/dev/null | grep -o 'age1[0-9a-z]*')"
  fi
fi

echo ".env dibuat. Periksa dan lengkapi nilai yang masih 'GANTI'."
grep -n 'GANTI' .env || true
