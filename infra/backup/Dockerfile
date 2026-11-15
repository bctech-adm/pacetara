# syntax=docker/dockerfile:1
# Cadangan terenkripsi: pg_dump + arsip penyimpanan objek → age → rclone ke lokasi di luar VPS.
# Hanya klien PostgreSQL 16 (bukan image server postgres) agar image kecil dan tanpa biner tambahan.
FROM alpine:3.24
# Versi minimum klien PostgreSQL ditulis eksplisit: perbaikan keamanan wajib terpasang, dan setiap
# kenaikan mengubah baris RUN sehingga cache layer di CI tidak memakai hasil apk lama (KEPUTUSAN #311).
RUN apk upgrade --no-cache && apk add --no-cache \
      "postgresql16-client>=16.16-r0" "libpq>=18.7-r0" age rclone tar tini
COPY --chmod=755 backup.sh restore.sh entrypoint.sh /usr/local/bin/
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
