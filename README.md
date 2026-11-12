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
| 2.3 Impor data lari | Kode selesai (backend + worker + aplikasi), teruji e2e dengan penyedia palsu: Health Connect (pilih sesi di HP), Garmin (OAuth2 PKCE + push/ping), Strava (OAuth + webhook, selalu privat), dedup antar-sumber. Garmin/Strava **mati sampai env diisi**. Pemilik perlu: (1) daftar Garmin Connect Developer Program atas nama PT → isi `GARMIN_CLIENT_ID/SECRET`, `GARMIN_PUSH_KEY`, daftarkan endpoint `https://<api>/v1/imports/garmin/push/<GARMIN_PUSH_KEY>` (Activity Details) dan callback `https://<api>/v1/imports/garmin/callback`, lalu cek ulang alamat OAuth Garmin (KEPUTUSAN #160–#176); (2) buat aplikasi di strava.com/settings/api (Callback Domain = domain API) → isi `STRAVA_CLIENT_ID/SECRET`, opsional buat langganan webhook ke `https://<api>/v1/imports/strava/webhook` dengan `STRAVA_WEBHOOK_VERIFY_TOKEN` lalu isi `STRAVA_WEBHOOK_SUBSCRIPTION_ID`; (3) pasang `API_PUBLIC_URL`. **Uji Health Connect di HP sungguhan dan build APK (minSdk 26, plugin `health`) belum**; deklarasi izin Health Connect di Play Console diperlukan saat rilis |
| 2.4 Engine event | Kode selesai (backend + worker + panel + aplikasi), teruji e2e dengan HTTP palsu: kirim event dari aplikasi (Level 1, maks. 5/hari), antrean di tab **Antrean event** panel (setujui dengan koreksi / tolak dengan alasan / gabung duplikat, semua di log), kandidat duplikat otomatis, scraping terjadwal idempoten (parser JSON-LD schema.org, robots.txt, anti-SSRF), sumber + halaman resmi di detail event, notifikasi ke pengirim. **Scraping mati sampai pemilik mengaktifkan sumber** (lihat "Mengaktifkan sumber scraping event"); belum diuji terhadap situs sungguhan (KEPUTUSAN #177–#191) |
| 2.5 Langganan | Kode selesai (backend + worker + panel + aplikasi), teruji e2e dengan Google Play dan Pub/Sub palsu: Premium (akun) dan Komunitas Pro / Pro Unlimited (per komunitas, hanya pemilik) lewat Google Play Billing, diverifikasi server (`subscriptionsv2.get`) + acknowledge di server, RTDN dengan verifikasi token OIDC, rekonsiliasi berkala, lencana Premium/Pro, ajakan upgrade di setiap batas paket, tab **Langganan** panel (status + pemberian paket manual ber-log). **Mati sampai env diisi** (lihat "Mengaktifkan langganan Google Play"); **pembelian sungguhan belum diuji** — hanya bisa dari aplikasi yang dipasang lewat track uji Play, bukan APK GitHub (KEPUTUSAN #192–#209) |
| 2.6 Fitur komunitas lanjutan | Kode selesai (backend + worker + panel + aplikasi), teruji e2e: jadwal lari rutin + RSVP (gratis, sesi dibentuk 28 hari ke depan, pengingat 2 jam), absensi QR berputar 30 detik / check-in GPS radius 200 m tanpa menyimpan lokasi (Pro), liga bulanan per kota dari snapshot worker (Pro, tanpa Strava/unverified/privat) + statistik komunitas (Pro), cari teman lari opt-in (gratis per kota, filter pace/jarak/jam Premium, sapa harus diterima sebelum chat), kas + pre-order jersey pencatatan saja (Pro), peta spot lari dengan antrean persetujuan di tab **Antrean spot** panel + laporan. Kebijakan privasi naik ke versi 2026-11-12. **Belum diuji di HP sungguhan:** pemindai QR (kamera), check-in GPS di lapangan, build APK dengan `mobile_scanner` (hanya CI) (KEPUTUSAN #210–#234) |
| 2.7 Iklan AdMob | Kode selesai (aplikasi + flag `ads` di `/v1/me` + app-ads.txt di situs publik), teruji dengan pemuat iklan palsu: iklan native di tab Feed (setelah postingan ke-4, lalu tiap 8) dan banner adaptif di daftar event (setelah event ke-5, lalu tiap 10) hanya untuk pengguna gratis menurut server; Premium tanpa iklan dan SDK iklan tidak dijalankan; tidak ada iklan layar penuh, saat merekam lari, di chat, SOS, langganan, atau profil orang lain; iklan tidak dipersonalisasi. **Tanpa iklan sampai variabel repo diisi** (lihat "Mengaktifkan iklan AdMob"); **iklan sungguhan dan build APK dengan plugin belum diuji** (hanya CI) (KEPUTUSAN #235–#244) |
| 3.1 Verifikasi Level 2 | Kode selesai (backend + worker + panel + aplikasi), teruji e2e dengan mesin palsu + uji mesin asli (`scripts/kyc-smoke`) pada KTP sintetis: layar persetujuan terpisah → NIK + nama → foto KTP + selfie dari kamera → OCR (tesseract.js) + pencocokan wajah/anti-spoof (Human) **self-hosted di memori API**, foto tidak disimpan; lolos otomatis, ulangi, atau antrean tab **Verifikasi KTP** panel (skor + nama, setujui/tolak/cabut, semua di log). Membuat komunitas baru kini wajib Level 2 (komunitas lama tidak terdampak). **Ambang wajah perlu dikalibrasi dengan foto sukarelawan** sebelum dibuka luas (lihat "Kalibrasi verifikasi KTP"); belum diuji dengan KTP dan HP sungguhan (KEPUTUSAN #246–#258) |
| 3.2 Marketplace | Kode selesai (backend + worker + panel + dasbor web + aplikasi + situs publik), teruji e2e dengan Xendit dan Midtrans palsu: tiga model per listing — **tautan afiliasi** (gratis, template afiliasi opsional), **listing berbayar** (biaya pasang/boost dibayar di **dasbor web `/dasbor`** lewat Midtrans, bukan di aplikasi), **bayar di aplikasi** (split payment Xendit xenPlatform ke akun penjual MANAGED, wajib Level 2, komisi otomatis); hubungi penjual lewat chat, pesanan → kirim → selesai/sengketa, kebijakan transaksi berversi di `/kebijakan-transaksi`, laporan listing, tab **Marketplace** panel. **Pembayaran mati sampai env diisi** (lihat "Mengaktifkan marketplace"); belum diuji terhadap Midtrans sandbox/Xendit test mode (KEPUTUSAN #259–#272) |
| 3.3 Banner sponsor dan dasbor swalayan | Kode selesai (backend + worker + panel + dasbor web + aplikasi), teruji e2e dengan Midtrans palsu: sponsor Level 2 mengunggah banner 3:1 di **`/dasbor` → Banner sponsor**, memilih slot (beranda/tab Komunitas, daftar event, detail event — wajib tertaut ke event), kota sasaran, dan periode, membayar lewat Midtrans; tayang setelah disetujui di tab **Banner sponsor** panel dan turun otomatis saat periode habis; dasbor menampilkan tayangan dan klik unik per hari. Premium tidak melihat banner. **Tarif belum diputuskan pemilik** (`BANNER_PRICE_*`); pembayaran mati sampai Midtrans diisi (KEPUTUSAN #273–#282). **Fase 3 selesai di tingkat kode** |

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

## Mengaktifkan sumber scraping event (modul 2.4)

Tidak ada sumber yang aktif secara bawaan. Untuk setiap situs kalender lari yang ingin dibaca:

1. **Periksa ketentuan layanan** situs itu (Terms of Service / Syarat dan Ketentuan): pastikan tidak melarang pengambilan data otomatis atau penggunaan ulang jadwal event. Jika ragu, minta izin tertulis ke pengelolanya. Simpan bukti (tangkapan layar/email) dan catat di KEPUTUSAN.md.
2. **Periksa `https://<situs>/robots.txt`**: halaman jadwal tidak boleh di-`Disallow` untuk `*` atau `PaceTaraBot`. Scraper tetap memeriksa robots.txt setiap 24 jam dan berhenti sendiri jika dilarang.
3. **Pastikan halaman memuat data terstruktur** schema.org `Event` (JSON-LD): buka sumber halaman, cari `application/ld+json` berisi `"@type":"Event"`/`"SportsEvent"`. Tanpa itu parser `jsonld` tidak menemukan apa pun; parser khusus situs perlu ditambahkan di `backend/src/event-engine/sources.ts` (beserta tes).
4. **Isi `.env`** (satu baris JSON), lalu jalankan ulang worker:
   ```
   EVENT_SCRAPE_SOURCES=[{"id":"kalender-contoh","name":"Kalender Contoh","urls":["https://kalender.contoh.id/lari"]}]
   ```
   `id` tetap (huruf kecil/angka/strip; jangan diganti, dipakai untuk idempotensi), `name` tampil sebagai "Sumber: …", `urls` maks. 20 halaman https (host-nya menjadi allowlist). Nonaktifkan sementara dengan `"enabled":false`. Jarak putaran `EVENT_SCRAPE_INTERVAL_HOURS` (bawaan 24), jeda per permintaan `EVENT_SCRAPE_DELAY_MS` (bawaan 5000).
5. Periksa hasil di panel → **Antrean event** → kartu "Sumber scraping" (putaran terakhir, galat seperti `robots_disallowed`), lalu tinjau kiriman. Tidak ada event yang tayang tanpa disetujui.

Bot memperkenalkan diri sebagai `PaceTaraBot/1.0 (+<PUBLIC_WEB_URL>/bot)`; halaman `web/site/bot/` menjelaskan cara memblokirnya.

## Mengaktifkan langganan Google Play (modul 2.5)

Langganan mati sampai langkah ini selesai (aplikasi menampilkan "Langganan belum tersedia").

1. **Play Console → Monetisasi → Langganan**: buat tiga langganan dengan product ID sama dengan `.env` (bawaan `pacetara_premium`, `pacetara_community_pro`, `pacetara_community_pro_unlimited`), masing-masing satu base plan bulanan perpanjangan otomatis. Harga (Rp29.000 / Rp99.000 / Rp150.000) diatur di sini, tidak di kode; aplikasi menampilkan harga dari Play. Periksa potongan biaya layanan Play untuk Indonesia sebelum menetapkan harga (PRD "Yang harus diverifikasi").
2. **Google Cloud** (proyek yang sama dengan login Google): aktifkan *Google Play Android Developer API*, buat akun layanan, unduh kunci JSON → `PLAY_SERVICE_ACCOUNT_B64=$(base64 -w0 sa.json)`. **Play Console → Pengguna dan izin**: undang email akun layanan itu dengan izin *Lihat data keuangan* dan *Kelola pesanan dan langganan* (akses aplikasi PaceTara). Izin baru bisa butuh hingga 24 jam. Isi `GOOGLE_PLAY_PACKAGE_NAME=tech.bimacreative.pacetara`.
3. **Real-time Developer Notifications**: di Google Cloud buat topik Pub/Sub (mis. `play-rtdn`), beri `google-play-developer-notifications@system.gserviceaccount.com` peran *Pub/Sub Publisher* di topik itu, lalu buat **push subscription** ke `https://<api>/v1/subscriptions/play/rtdn` dengan **autentikasi aktif**: pilih akun layanan push (boleh akun layanan baru tanpa peran lain) dan isi *audience* (mis. URL endpoint itu). Isi `PLAY_RTDN_AUDIENCE` = audience tersebut dan `PLAY_RTDN_SERVICE_ACCOUNT_EMAIL` = email akun layanan push. Di Play Console → Monetisasi → Penyiapan monetisasi, isi nama topik dan tekan *Kirim notifikasi uji* (server membalas 204 dan mengabaikannya).
4. Jalankan ulang `api` dan `worker` (`docker compose up -d api worker`). Tanpa RTDN, rekonsiliasi berkala (tiap 30 menit) tetap menurunkan paket yang berakhir, tetapi refund/perpanjangan baru terlihat lebih lambat.
5. **Uji dengan license tester**: Play Console → Pengaturan → Pengujian lisensi, tambahkan akun Google penguji. Unggah AAB ke track uji (internal/tertutup) dan pasang aplikasi **dari Play Store** lewat tautan uji. **APK dari GitHub Release tidak bisa membeli** (Play Billing hanya untuk aplikasi yang dipasang dari Play). Langganan uji diperpanjang tiap beberapa menit, sehingga perpanjangan, pembatalan, dan kedaluwarsa bisa diamati di panel → **Langganan**.
6. Tanpa Play pun fitur Premium/Pro bisa diuji: panel → **Langganan** → beri paket manual berbatas waktu (tercatat di log).

Saat rilis di Play Store, izin `REQUEST_INSTALL_PACKAGES` dan pembaruan mandiri wajib dihapus (KEPUTUSAN #57, #207).

## Mengaktifkan iklan AdMob (modul 2.7)

Selama variabel di bawah kosong, APK rilis tidak menampilkan iklan sama sekali (manifest memakai ID aplikasi uji Google agar build tetap jalan).

1. **Buat akun AdMob** (atas nama PT, data pembayaran dan pajak), lalu **Aplikasi → Tambah aplikasi** Android `tech.bimacreative.pacetara` (boleh sebelum aplikasi terbit di Play; tautkan ke listing Play setelah terbit). Catat **ID aplikasi** (`ca-app-pub-…~…`).
2. **Buat unit iklan**: *Native* untuk feed dan *Banner* untuk daftar event (opsional *Banner* kedua untuk feed bila tidak ingin native). Di setelan unit/aplikasi, batasi rating konten maks. **PG** dan biarkan iklan tidak dipersonalisasi (aplikasi sudah memintanya).
3. **GitHub → Settings → Secrets and variables → Actions → Variables** (bukan Secrets; nilai ini ikut di APK): `ADMOB_APP_ID`, `ADMOB_NATIVE_FEED`, `ADMOB_BANNER_EVENTS`, opsional `ADMOB_BANNER_FEED`. Jalankan ulang workflow CI agar APK baru dibangun dengan ID itu.
4. **app-ads.txt**: isi `ADMOB_PUBLISHER_ID=pub-…` (AdMob → Pengaturan → Informasi akun) di `.env` VPS, lalu `docker compose up -d web`. Cek `https://pace.bimacreative.tech/app-ads.txt`. Pastikan kolom *Situs web* developer di Play Console menunjuk ke domain itu; jika AdMob memeriksa domain induk, taruh baris yang sama di `bimacreative.tech/app-ads.txt` (KEPUTUSAN #243).
5. **Play Console**: *Konten aplikasi → ID iklan* = ya, untuk iklan; *Keamanan Data*: ID perangkat atau ID lainnya, info dan performa aplikasi, interaksi aplikasi, dikumpulkan dan dibagikan ke Google untuk iklan, analitik, dan pencegahan penipuan; *Berisi iklan* = ya.
6. **Negara distribusi**: batasi ke Indonesia selama formulir persetujuan UMP belum ada; membuka EEA/UK/Swiss mewajibkan UMP lebih dulu (KEPUTUSAN #240).
7. Saat menguji di HP sendiri, daftarkan HP sebagai **perangkat uji** di AdMob (Pengaturan → Perangkat uji) dan jangan mengeklik iklan sungguhan.

## Mengaktifkan marketplace (modul 3.2)

Tanpa konfigurasi, listing afiliasi tetap berjalan; listing berbayar (dasbor web) dan bayar di aplikasi menjawab "belum tersedia".

1. **Kebijakan transaksi**: tinjau naskah `web/site/kebijakan-transaksi/index.html` (sebaiknya bersama konsultan hukum). Setiap perubahan naskah wajib menaikkan `MARKET_POLICY_VERSION` agar pengguna menyetujui ulang.
2. **Midtrans** (biaya listing, boost, banner sponsor): akun Midtrans atas nama PT → *Settings → Access Keys* → `MIDTRANS_SERVER_KEY`; mulai dengan sandbox (`MIDTRANS_PRODUCTION=false`, server key `SB-Mid-server-…`). *Settings → Payment → Notification URL* = `https://<api>/v1/payments/midtrans/notification`. Finish URL tidak perlu diisi (dikirim per transaksi ke `DASHBOARD_URL`).
3. **Xendit xenPlatform** (bayar di aplikasi): aktifkan xenPlatform di akun Xendit PT. Isi `XENDIT_SECRET_KEY` (izin Money-in write + xenPlatform), `XENDIT_CALLBACK_TOKEN` (*Settings → Callbacks → verification token*), `XENDIT_MASTER_ACCOUNT_ID` (Business ID akun PaceTara, tujuan komisi). Daftarkan callback **Invoices paid** → `https://<api>/v1/market/xendit/invoice` dan **xenPlatform account status** → `https://<api>/v1/market/xendit/account`. Cek ulang alamat API di `backend/src/market/xendit.ts` terhadap dokumentasi Xendit terbaru dan konfirmasi biaya per akun penjual (KEPUTUSAN #262).
4. **Biaya**: `MARKET_LISTING_FEE`, `MARKET_LISTING_DAYS`, `MARKET_BOOST_FEE`, `MARKET_BOOST_DAYS`, `MARKET_FEE_PERCENT`, `MARKET_FEE_FLAT`. Opsional `AFFILIATE_TEMPLATES` setelah terdaftar di program afiliasi marketplace.
5. `docker compose up -d api worker`. Uji dengan akun sandbox: pasang listing berbayar di `https://pace-admin.bimacreative.tech/dasbor`, bayar dengan simulator Midtrans, pastikan listing tayang di aplikasi; untuk split, aktifkan akun penjual dari aplikasi (akun Level 2), selesaikan undangan Xendit test mode, beli dari akun lain.
6. **Refund**: pesanan bayar di aplikasi direfund dari dasbor Xendit (akun penjual), biaya listing/banner dari dasbor Midtrans; catat keputusan di panel → **Marketplace**.

## Banner sponsor (modul 3.3)

1. Tetapkan tarif di `.env`: `BANNER_PRICE_HOME`, `BANNER_PRICE_EVENTS`, `BANNER_PRICE_EVENT_DETAIL` (rupiah per hari per kota) dan `BANNER_NATIONAL_FACTOR` (pengali untuk banner nasional). Midtrans harus sudah aktif (lihat "Mengaktifkan marketplace" langkah 2).
2. Sponsor: verifikasi KTP di aplikasi (Level 2), lalu masuk ke `https://pace-admin.bimacreative.tech/dasbor` → **Banner sponsor** → Pasang banner (gambar 1200×400 px) → bayar.
3. Super admin: panel → **Banner sponsor** → periksa gambar, teks, dan tautan → Setujui/Tolak. Banner yang ditolak direfund manual di dasbor Midtrans.
4. Sediakan pedoman konten iklan untuk sponsor dan peninjau (produk terlarang mengikuti kebijakan transaksi, tanpa klaim kesehatan menyesatkan).

## Kalibrasi verifikasi KTP (modul 3.1)

Mesin verifikasi berjalan di dalam container `api` (tanpa konfigurasi tambahan, tanpa pihak ketiga). Ambang bawaan (`KYC_FACE_PASS=0.6`, `KYC_FACE_REJECT=0.45`, `KYC_LIVENESS_MIN=0.5`) baru diuji pada beberapa foto potret, jadi kalibrasi dulu sebelum dibuka luas:

1. Kumpulkan foto KTP + selfie dari **sukarelawan yang setuju** (mis. tim sendiri, 10–20 orang), plus pasangan silang (KTP orang A dengan selfie orang B) sebagai contoh "beda orang".
2. Di mesin lokal (bukan di VPS, agar foto tidak berpindah ke server): `cd backend && npm run build && node dist/scripts/kyc-smoke.js ktp.jpg selfie.jpg <nik> "<nama>"`. Skrip mencetak skor dan keputusan tanpa menulis berkas; NIK dicetak tersamar.
3. Pilih `KYC_FACE_PASS` di atas skor tertinggi pasangan "beda orang", dan `KYC_FACE_REJECT` di bawah skor terendah pasangan "orang sama". Kasus di antara keduanya masuk tinjauan manual. Isi di `.env` VPS lalu `docker compose up -d api`. Hapus foto sukarelawan setelah selesai.
4. Panel → **Verifikasi KTP** menampilkan skor setiap percobaan (tanpa foto) untuk memantau tingkat lolos/tinjauan setelah rilis.
5. Darurat (mesin bermasalah): `KYC_ENGINE=off` mematikan verifikasi, dan `COMMUNITY_OWNER_MIN_LEVEL=1` membuka kembali pembuatan komunitas untuk Level 1.

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
