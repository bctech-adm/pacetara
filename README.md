# PaceTara

Aplikasi Android untuk komunitas lari Indonesia. Spesifikasi: [docs/PRD.md](docs/PRD.md) · Keputusan teknis: [docs/KEPUTUSAN.md](docs/KEPUTUSAN.md) · Review PRD: [docs/REVIEW-PRD.md](docs/REVIEW-PRD.md)

## Status

| Modul | Status |
| --- | --- |
| 1.1 Fondasi | Selesai. Produksi: https://pace-api.bimacreative.tech/health dan https://pace-admin.bimacreative.tech |
| 1.2 Akun dan login | Selesai dan live (login Google aktif). Email menunggu akun SMTP |
| 1.3 Komunitas | Selesai dan live. Batas paket mengikuti tabel PRD, menunggu keputusan A2/B1 |
| 1.4 Tracking lari | Selesai (backend + aplikasi), teruji lewat simulasi; **uji lapangan 5 km layar mati belum** |
| 1.5 Status lari | Selesai (backend + aplikasi + WebSocket `/v1/ws`), teruji e2e; **uji dua HP sungguhan belum** |
| 1.6 Chat | Selesai (backend + aplikasi), teruji e2e; kartu "bagikan event" ada sejak 1.7 |
| 1.8 Laporan dan panel super admin | Selesai (backend + panel web + aplikasi), teruji e2e; **super admin pertama perlu dibuat dengan CLI** (lihat bawah) |
| 1.7 Kalender event | Selesai (backend + panel web + aplikasi), teruji e2e; event dimasukkan super admin di tab **Event** panel |
| 1.9 Notifikasi | Selesai (backend + worker + aplikasi), teruji e2e. Notifikasi di aplikasi aktif; **push butuh proyek Firebase** (KEPUTUSAN #117) |
| 1.10 Mode aman | Selesai (backend + wa-otp + aplikasi), teruji e2e; **uji lapangan SOS (WhatsApp + SMS) belum** |
| 2.1 Feed sosial | Selesai (backend + aplikasi + panel), teruji e2e; tab Feed menggantikan tab Riwayat (riwayat lewat tab Lari/Profil). **Uji kartu Instagram Story di HP belum** |
| 2.2 Riwayat dan paspor lari | Selesai (backend + aplikasi), teruji e2e: statistik minggu/bulan WIB (+ tahunan/rekor Premium), rak medali (gratis 5), hasil resmi, lencana otomatis. **Uji unggah foto medali dari kamera HP belum** |

## Mencoba aplikasi di HP (APK uji)

1. Buka [Releases](https://github.com/bctech-adm/pacetara/releases) dan unduh `pacetara-<versi>.apk` dari rilis terbaru.
2. Pasang di HP Android (izinkan "Instal aplikasi tidak dikenal" untuk browser/file manager).
3. Aplikasi otomatis terhubung ke server produksi (pace-api.bimacreative.tech).
4. Setiap ada commit baru di `main` yang lolos CI, rilis APK baru terbit otomatis. Aplikasi menawarkan pembaruan saat dibuka, atau lewat Profil → Periksa pembaruan.

Server juga diperbarui otomatis: container `pacetara-deployer` di VPS menarik image baru setiap 5 menit (docs/KEPUTUSAN.md #58). Lihat lognya dengan `sudo docker logs pacetara-deployer`.

## Menjalankan di mesin sendiri

Butuh Docker dan `openssl`.

```sh
./scripts/init-env.sh --local      # membuat .env dengan rahasia acak, port 8080/8443
docker compose up -d --build
curl -k --resolve api.localhost:8443:127.0.0.1 https://api.localhost:8443/health
# {"status":"ok","database":"ok","redis":"ok"}
```

Panel admin: https://admin.localhost:8443 (sertifikat dari CA internal Caddy).

## Deploy ke VPS bersama (Traefik sudah ada) — kondisi saat ini

Stack di `/opt/infra/web/clients/pacetara`, dijalankan dengan:

```sh
sudo docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d
```

Rute Traefik: `infra/traefik/pacetara.yml` → `/opt/infra/traefik/dynamic/clients/`, lalu `sudo docker exec traefik kill -HUP 1`. Detail di docs/KEPUTUSAN.md #18–21.

WAF CrowdSec (OWASP CRS) di VPS menolak PATCH/PUT/DELETE secara bawaan. Pengecualian PaceTara ada di `infra/crowdsec/pacetara-api-exclusions.yaml`; pasang ke `/opt/infra/security/crowdsec/appsec-configs/` dan daftarkan di `acquis.d/appsec.yaml` (detail: docs/KEPUTUSAN.md #103).

## Deploy ke VPS khusus (Caddy)

1. Arahkan DNS `pace-api.bimacreative.tech` dan `pace-admin.bimacreative.tech` ke VPS.
2. Salin `docker-compose.yml`, folder `infra/`, dan `.env` (dari `./scripts/init-env.sh`, lalu lengkapi `BACKUP_AGE_RECIPIENT` dan `BACKUP_REMOTE`).
3. Isi `infra/backup/config/rclone.conf` (contoh di `rclone.conf.example`).
4. `docker compose pull && docker compose up -d`
5. Tautkan nomor WhatsApp OTP: `docker compose logs -f wa-otp`, pindai QR dari WhatsApp > Perangkat tertaut.

Jika port 80/443 sudah dipakai layanan lain di VPS, ubah `HTTP_PORT`/`HTTPS_PORT` dan teruskan kedua domain dari proxy yang sudah ada ke Caddy PaceTara.

## Super admin (panel https://pace-admin.bimacreative.tech)

Super admin tidak bisa dibuat dari web. Daftarkan akun biasa di aplikasi **dengan email dan kata sandi** (akun Google: atur kata sandi lewat "Lupa kata sandi?"), lalu di server:

```sh
# VPS bersama (stack di /opt/infra/web/clients/pacetara), bisa dari folder mana pun:
sudo docker exec pacetara-api node dist/scripts/admin.js promote email@contoh.com
# VPS khusus / lokal, dari folder repo:
docker compose exec api node dist/scripts/admin.js promote email@contoh.com
```

Perintah mencetak URI `otpauth://` dan kunci manual satu kali. Pindai dengan aplikasi authenticator (Google Authenticator, Aegis, 1Password), lalu bersihkan layar terminal. Login panel memakai email + kata sandi + kode 6 digit. HP hilang: `reset-totp <email>`. Mencabut: `demote <email>`. Setiap perintah dan tindakan di panel tercatat di log (tab Log).

## Cadangan dan pemulihan

- Otomatis setiap hari 02:30 WIB (`BACKUP_CRON`), terenkripsi `age`, diunggah ke `BACKUP_REMOTE`.
- Manual: `docker compose exec backup backup.sh`
- Pulihkan (di mesin yang memegang private key age):

  ```sh
  docker compose stop api worker s3
  docker compose run --rm -v /path/kunci-age.txt:/key.txt:ro -e AGE_IDENTITY=/key.txt backup restore.sh <STAMP>
  docker compose up -d
  ```

## Struktur

| Folder | Isi |
| --- | --- |
| `backend/` | API NestJS, worker BullMQ, migrasi SQL |
| `wa-otp/` | Layanan OTP WhatsApp (Baileys) |
| `admin/` | Panel super admin dan dasbor sponsor |
| `mobile/` | Aplikasi Flutter (lihat `mobile/README.md`) |
| `infra/` | Caddy, image cadangan |
