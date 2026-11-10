#!/bin/sh
# Menulis konfigurasi runtime dari environment, lalu menjalankan nginx.
set -eu

API_PUBLIC_URL="${API_PUBLIC_URL:-}"
# Hanya URL https sederhana (tanpa kutip/spasi) agar tidak bisa menyisipkan JS atau header.
if ! printf '%s' "$API_PUBLIC_URL" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$'; then
  echo "API_PUBLIC_URL wajib berupa https://domain[:port] tanpa path" >&2
  exit 1
fi

mkdir -p /tmp/nginx
printf 'window.__PACETARA__ = { apiBaseUrl: "%s" };\n' "$API_PUBLIC_URL" > /tmp/nginx/config.js

cat > /tmp/nginx/headers.conf <<EOF
add_header Content-Security-Policy "default-src 'self'; connect-src 'self' $API_PUBLIC_URL; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" always;
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy no-referrer always;
add_header X-Robots-Tag "noindex, nofollow" always;
EOF

exec nginx -g 'daemon off;'
