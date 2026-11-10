# syntax=docker/dockerfile:1
# Cadangan terenkripsi: pg_dump + arsip MinIO → age → rclone ke lokasi di luar VPS.
FROM postgres:16-alpine
RUN apk add --no-cache age rclone tar tini busybox-suid
COPY backup.sh restore.sh entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/*.sh
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
