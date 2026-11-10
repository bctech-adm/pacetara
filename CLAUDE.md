# PaceTara

Aplikasi Android komunitas lari Indonesia. Spesifikasi lengkap: `docs/PRD.md`. Keputusan teknis: `docs/KEPUTUSAN.md` (baca sebelum memulai modul, tambahkan keputusan baru di sana).

Kerjakan **satu modul per sesi** sesuai urutan di PRD. Mulai dengan rencana singkat, akhiri dengan tes dan satu commit. Jangan lanjut ke modul berikutnya sebelum kriteria "Selesai jika" terpenuhi.

## Stack dan struktur repo

| Folder | Isi |
| --- | --- |
| `backend/` | NestJS 12 (TypeScript, ESM, tes Vitest). Satu basis kode, tiga entrypoint: `main.ts` (API REST + WebSocket), `worker.ts` (BullMQ), `scripts/migrate.ts` |
| `backend/migrations/` | Migrasi SQL berurutan (`NNNN_nama.sql`), dijalankan service `migrate` sebelum API naik |
| `wa-otp/` | Layanan OTP WhatsApp (Baileys) di balik antarmuka `OtpProvider`, hanya di jaringan internal |
| `admin/` | Panel super admin + dasbor sponsor (Vite + React), disajikan sebagai file statis |
| `mobile/` | Aplikasi Flutter (Android) |
| `infra/` | Caddyfile, image backup, skrip cadangan/pemulihan |

Database: PostgreSQL 16 + PostGIS. Redis untuk cache, antrean (BullMQ), dan status lari langsung. SeaweedFS (API S3) untuk berkas; MinIO tidak lagi merilis image (lihat KEPUTUSAN.md).

Perintah:
- `./scripts/init-env.sh --local && docker compose up -d --build` — seluruh stack lokal, cek di https://api.localhost:8443/health
- `cd backend && npm test` — tes unit backend
- `cd backend && npm run lint && npm run build`

## Aturan portabilitas container

- Satu `docker-compose.yml` mendefinisikan semuanya; tidak ada yang dipasang langsung di OS VPS.
- Semua konfigurasi lewat `.env`. Tidak ada alamat IP atau domain yang di-hardcode di kode.
- Data hanya di volume bernama: `pgdata`, `redisdata`, `s3data`, `baileys_session`, `caddy_data`, `backups`.
- Image dibangun di GitHub Actions dan ditarik dari GHCR.
- Database, Redis, S3, dan wa-otp tidak mem-publish port; hanya Caddy yang terbuka.
- Skrip `infra/backup/backup.sh` dan `restore.sh` harus tetap berfungsi setiap ada perubahan skema.

## Keamanan dan privasi (berlaku untuk setiap modul)

Sebuah modul belum selesai jika salah satu syarat ini belum terpenuhi.

**Data dalam perjalanan**
- HTTPS (TLS 1.2+) untuk semua permintaan, termasuk WebSocket. Permintaan tanpa enkripsi ditolak.
- Certificate pinning di aplikasi: hanya root ISRG X1/X2 dan Root YE/YR yang dipercaya, TLS dari Let's Encrypt (lihat KEPUTUSAN.md).
- Data pribadi tidak pernah masuk ke URL atau query string.

**Data tersimpan**
- Kata sandi di-hash dengan Argon2id.
- Kolom sensitif dienkripsi di aplikasi dengan `FieldCrypto` (AES-256-GCM): nomor HP, email, rute lari, isi chat. Pencarian lewat blind index (`FieldCrypto.blindIndex`). NIK disimpan sebagai HMAC berkunci, bukan hash biasa.
- Foto KTP dan selfie tidak pernah ditulis ke disk atau log.
- Token login di ponsel disimpan di Android Keystore (`flutter_secure_storage`).
- Cadangan database dienkripsi (age) dan disimpan di luar VPS.

**Akses**
- Token akses berumur pendek, token penyegar dirotasi (deteksi pemakaian ulang per family), logout mencabut semuanya.
- Hak akses diperiksa di server pada setiap permintaan: pengguna hanya bisa mengambil data miliknya atau komunitas tempat ia terdaftar.
- Pembatasan laju pada login, OTP, pencarian, dan unggahan.
- Semua batas paket gratis/berbayar ditegakkan di server.
- Panel super admin: verifikasi dua langkah dan log tindakan (`admin_audit_log`).

**Server dan rahasia**
- Kunci API dan sesi Baileys di luar kode, tidak pernah di-commit. `.env` ada di `.gitignore`.
- Webhook pembayaran dan notifikasi Google Play diverifikasi tanda tangannya sebelum diproses.
- CI memindai celah dependensi (npm audit, Trivy) dan rahasia bocor (gitleaks).
- Unggahan gambar diperiksa jenis (magic bytes) dan ukurannya; metadata EXIF/lokasi dihapus.
- Jangan pernah me-log isi chat, token, kata sandi, OTP, email, atau nomor HP.

**Privasi lokasi dan chat**
- Status lari mati secara bawaan dan hanya tampil ke komunitas yang dipilih.
- Titik lokasi langsung dihapus begitu lari selesai (Redis dengan TTL, dihapus eksplisit saat selesai).
- Zona privasi menyamarkan titik awal dan akhir rute.
- Chat terenkripsi dalam perjalanan dan di database, tidak ujung-ke-ujung. Super admin hanya bisa membuka chat yang dilaporkan.
- Hapus akun: pesan di chat pribadi ikut terhapus; di chat komunitas nama diganti "Pengguna dihapus".
