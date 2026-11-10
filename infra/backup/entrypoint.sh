#!/bin/sh
# Menjadwalkan backup.sh dengan cron (BACKUP_CRON, bawaan 02:30 WIB = 19:30 UTC).
set -eu
SCHEDULE="${BACKUP_CRON:-30 19 * * *}"
env | grep -E '^(PG|BACKUP_|AGE_|RCLONE_)' | sed 's/^/export /; s/=\(.*\)$/="\1"/' > /etc/backup.env
chmod 600 /etc/backup.env
echo "$SCHEDULE . /etc/backup.env && /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1" > /etc/crontabs/root
echo "Cadangan dijadwalkan: $SCHEDULE (UTC)"
exec crond -f -l 8
