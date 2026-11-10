# PRD PaceTara

Nov 10, 2026 · @Bima Creative

PaceTara adalah aplikasi Android untuk komunitas lari Indonesia: pelari membuat dan bergabung ke komunitas, melihat siapa yang sedang lari, mengobrol, dan menemukan event. Dokumen ini memuat semua keputusan hasil diskusi, dibagi per fase dan per modul agar tiap modul bisa dikerjakan dalam satu sesi Claude Code.

## Keputusan final

| Hal | Keputusan |
| --- | --- |
| Nama | PaceTara |
| Platform | Android lebih dulu, dibangun dengan Flutter |
| Backend | NestJS, PostgreSQL + PostGIS, Redis, semuanya dalam container Docker di VPS pemilik |
| Domain API | pace-api.bimacreative.tech (aplikasi tidak pernah memanggil alamat IP) |
| Target | Nasional sejak peluncuran |
| Login | Google atau email |
| OTP nomor HP | WhatsApp lewat Baileys dengan nomor khusus, cadangan otomatis ke OTP email, kode mudah dipindah ke API resmi |
| Verifikasi | Bertingkat. Level 1: email + nomor HP. Level 2: KTP (OCR) + selfie, foto tidak disimpan |
| Lari | Tracking GPS langsung di aplikasi, plus impor dari Health Connect, Garmin, dan Strava |
| Status lari | Dinyalakan pengguna, dibagikan per komunitas yang ia pilih, mati secara bawaan |
| Chat | Pribadi dan komunitas, hanya teks dan gambar, tidak ujung-ke-ujung, riwayat tersimpan di server |
| Langganan | Google Play Billing saja. Premium Rp29.000/bulan, Komunitas Pro Rp99.000/bulan |
| Yang membayar | Pelari (Premium) dan admin komunitas (Komunitas Pro) |
| Marketplace | Tiga model: biaya listing, tautan afiliasi, split payment lewat Xendit xenPlatform |
| Payment gateway | Midtrans untuk banner sponsor dan biaya listing; Xendit khusus split payment |
| Iklan | AdMob di awal, iklan internal untuk ajakan upgrade, banner sponsor berbayar |
| Engine event | Hibrida: scraping situs kalender, formulir kirim event, persetujuan admin, arsip otomatis sehari setelah event |
| Moderasi | Semua pengguna bisa melapor; super admin menurunkan konten lewat panel web |
| Uji keamanan | Uji penetrasi mandiri sebelum rilis |

Ide tambahan yang masuk: "Siapa ikut?" per event, jadwal lari rutin + RSVP + absensi, cari teman lari, mode aman/SOS, liga antar komunitas, kas komunitas dan pre-order jersey, paspor lari (rak medali), peta spot lari, dasbor sponsor swalayan, kartu hasil lari untuk dibagikan. Ide jastip ambil race pack dan jual-beli perlengkapan bekas tidak dimasukkan.

## Peran pengguna dan tingkat verifikasi

| Peran | Bisa melakukan |
| --- | --- |
| Pelari | Bergabung ke komunitas, tracking, status lari, chat, feed, melapor konten |
| Admin komunitas | Semua hak pelari, plus mengelola anggota, undangan, jadwal lari, pengumuman, dan moderasi di komunitasnya |
| Penjual | Memasang listing di marketplace (wajib Level 2 untuk split payment) |
| Sponsor | Memasang banner berbayar lewat dasbor web |
| Super admin | Meninjau laporan, menurunkan konten, menangguhkan akun, menyetujui event, lewat panel web |

**Tingkat verifikasi**

- **Level 1, semua pengguna:** email terverifikasi dan nomor HP lewat OTP.
- **Level 2, penjual, pemilik komunitas, dan sponsor:** foto KTP dibaca dengan OCR dan dicocokkan dengan selfie. Lolos verifikasi memberi lencana "Terverifikasi".
- **Penyimpanan Level 2:** hanya status verifikasi dan NIK ter-hash. Foto KTP dan selfie diproses di memori lalu dihapus, tidak ditulis ke disk atau log.

**Lencana**

- Premium: label di avatar dan profil pelari.
- Pro: label di halaman komunitas dan avatar adminnya. Melekat pada komunitas, bukan pada akun admin.
- Terverifikasi: untuk akun Level 2.

## Arsitektur

Seluruh backend berjalan dalam container Docker, sehingga pindah VPS cukup dengan menyalin berkas Compose dan environment, memulihkan cadangan, lalu mengarahkan DNS ke IP baru.

| Container | Fungsi |
| --- | --- |
| Reverse proxy (Caddy atau Traefik) | HTTPS otomatis, pintu masuk tunggal |
| API (NestJS) | REST dan WebSocket untuk chat serta status lari |
| Worker | Tugas latar: engine event, notifikasi, impor Garmin, kedaluwarsa gambar chat |
| WhatsApp OTP (Baileys) | Terpisah dari API agar gangguannya tidak menjatuhkan layanan utama |
| Panel admin web | Super admin dan dasbor sponsor |
| PostgreSQL + PostGIS | Database utama, termasuk rute lari |
| Redis | Cache, antrean, status lari langsung |
| Penyimpanan objek (MinIO) | Foto profil, gambar chat, gambar listing |
| Backup | Cadangan terenkripsi terjadwal ke luar VPS |

**Aturan portabilitas**

- Satu berkas Docker Compose mendefinisikan semuanya; tidak ada yang dipasang langsung di sistem operasi VPS.
- Semua konfigurasi lewat berkas environment. Tidak ada alamat IP di kode.
- Data hanya di volume bernama: database, Redis, berkas, sesi Baileys.
- Image dibangun di GitHub dan ditarik dari registry.
- Skrip cadangan dan pemulihan disertakan dan diuji.
- Stack dan database terpisah dari layanan lain di VPS yang sama; database tidak terbuka ke internet.

**Domain**

- API: pace-api.bimacreative.tech (sudah ditetapkan).
- Panel admin dan dasbor sponsor: usulan pace-admin.bimacreative.tech.
- Halaman publik untuk kebijakan privasi dan kebijakan transaksi: usulan pace.bimacreative.tech.

**Aplikasi Android (Flutter)**

- Tracking GPS berjalan di latar belakang dengan foreground service.
- Token login disimpan di Android Keystore.
- Health Connect dibaca langsung di perangkat.

## Fase 1: inti komunitas

Fase 1 selesai ketika seorang pelari bisa mendaftar, bergabung ke komunitas, merekam lari, terlihat "sedang lari" oleh teman sekomunitas, dan mengobrol. Sepuluh modul, dikerjakan berurutan.

### 1.1 Fondasi

- Repositori, Docker Compose dengan semua container, CI di GitHub (build, tes, pemindaian dependensi dan rahasia).
- Kerangka API NestJS, skema database awal, kerangka aplikasi Flutter.
- Selesai jika: `docker compose up` menjalankan seluruh stack di mesin bersih, dan API menjawab lewat HTTPS di domain.

### 1.2 Akun dan login

- Daftar dan masuk dengan Google atau email + kata sandi.
- Verifikasi email dengan kode. Verifikasi nomor HP dengan OTP WhatsApp (Baileys), otomatis beralih ke OTP email jika pengiriman gagal.
- Kebijakan privasi tampil saat daftar dengan centang persetujuan.
- Profil: nama, foto, kota, pace rata-rata. Menu hapus akun beserta data.
- Selesai jika: pengguna baru bisa daftar sampai Level 1, dan hapus akun benar-benar menghapus data pribadinya.

### 1.3 Komunitas

- Buat komunitas dengan nama, kota, deskripsi, logo, dan jenis: terbuka atau privat.
- Terbuka: siapa pun bisa bergabung. Privat: lewat tautan undangan, kode, atau persetujuan admin.
- Admin mengundang, menyetujui, mengeluarkan anggota, dan mengangkat admin lain.
- Direktori komunitas dengan pencarian per kota.
- Selesai jika: batas paket gratis ditegakkan di server (lihat bagian Gratis vs berbayar).

### 1.4 Tracking lari

- Rekam lari dengan GPS: jarak, durasi, pace, rute di peta. Jeda dan lanjut. Tetap berjalan saat layar mati.
- Simpan lari dengan judul, catatan, dan foto. Atur visibilitas: semua, komunitas, atau hanya saya.
- Zona privasi: titik awal dan akhir disamarkan.
- Selesai jika: lari 5 km terekam utuh dengan layar mati, dan rute tersimpan tanpa memperlihatkan titik rumah.

### 1.5 Status lari

- Saat mulai merekam, pengguna memilih komunitas mana yang boleh melihat statusnya. Bawaan: mati.
- Anggota komunitas melihat daftar "sedang lari" dengan nama, durasi, dan jarak berjalan. Posisi di peta opsional per komunitas.
- Titik lokasi langsung dihapus dari server begitu lari selesai; hanya rute akhir yang disimpan.
- Selesai jika: status muncul ke anggota komunitas terpilih dalam beberapa detik dan tidak terlihat oleh orang di luar komunitas itu.

### 1.6 Chat

- Chat pribadi antar pelari dan chat komunitas. Hanya teks dan gambar.
- Kartu khusus di chat: bagikan event, dan ajakan lari bareng dengan waktu, tempat, serta tombol ikut.
- Riwayat tersimpan di server dan tersinkron antar perangkat, dimuat bertahap.
- Anggota baru melihat riwayat lama atau tidak: dipilih admin saat menambahkan anggota. Untuk komunitas terbuka, ini pengaturan komunitas dengan bawaan "tidak".
- Pengguna bisa menghapus pesannya sendiri. Pesan yang sedang dilaporkan ditahan sampai laporannya selesai.
- Gambar dihapus dari server setelah 6 bulan dan diganti keterangan "Gambar sudah kedaluwarsa". Teks tetap.
- Selesai jika: pesan terkirim langsung, riwayat muncul setelah pasang ulang aplikasi, dan pengguna di luar percakapan tidak bisa mengambilnya lewat API.

### 1.7 Kalender event (manual)

- Super admin memasukkan event: nama, tanggal, kota, kategori jarak, tautan pendaftaran resmi.
- Daftar dan detail event dengan filter kota dan bulan. Event otomatis diarsipkan sehari setelah tanggalnya.
- "Siapa ikut?": pengguna menandai ikut, dan melihat anggota komunitasnya yang juga ikut.

### 1.8 Laporan konten dan panel super admin

- Tombol lapor di profil, komunitas, pesan chat, dan event, dengan pilihan alasan.
- Panel web: antrean laporan, turunkan konten, tangguhkan atau blokir akun, proses banding.
- Konten disembunyikan otomatis setelah beberapa laporan sambil menunggu tinjauan.
- Super admin hanya bisa membuka chat yang dilaporkan. Setiap tindakan admin tercatat di log.
- Login panel wajib verifikasi dua langkah.

### 1.9 Notifikasi

- Push untuk pesan baru, undangan komunitas, ajakan lari, dan teman yang mulai lari.
- Pengaturan per jenis notifikasi.

### 1.10 Mode aman

- Tombol SOS saat lari mengirim lokasi ke kontak darurat yang dipilih pengguna.
- Gratis untuk semua pengguna.

## Fase 2: sosial, riwayat, dan pendapatan pertama

Fase 2 selesai ketika pengguna punya alasan membuka aplikasi setiap hari (feed, medali, event otomatis) dan langganan sudah bisa dibeli.

### 2.1 Feed sosial

- Postingan teks, foto, dan hasil lari. Ikuti pengguna lain, suka, komentar.
- Tab: Mengikuti, Komunitas, Jelajah. Semua konten bisa dilaporkan.
- Kartu hasil lari siap dibagikan ke Instagram Story, dengan logo komunitas.

### 2.2 Riwayat dan paspor lari

- Riwayat lari dengan statistik mingguan dan bulanan.
- Paspor lari: rak medali digital dari foto medali fisik dan hasil resmi event yang diikuti.
- Lencana pencapaian otomatis: jarak pertama, total jarak, konsistensi mingguan.

### 2.3 Impor data lari

- **Health Connect (jalur utama):** dibaca di perangkat, dengan izin pengguna.
- **Garmin:** lewat Garmin Connect Developer Program, data dikirim secara push ke endpoint di server.
- **Strava:** hanya tampil sebagai riwayat pribadi pemiliknya. Tidak boleh muncul di feed, papan peringkat, atau statistik komunitas.
- Lari hasil impor ditandai sumbernya dan dicegah terhitung ganda dengan lari yang direkam di aplikasi.

### 2.4 Engine event

- Scraping terjadwal dari situs kalender lari yang mengizinkannya, ditambah formulir kirim event untuk penyelenggara.
- Semua hasil masuk antrean dan baru tayang setelah disetujui super admin. Duplikat digabung.
- Arsip otomatis sehari setelah event. Sumber dan tautan resmi selalu ditampilkan.

### 2.5 Langganan

- Premium dan Komunitas Pro dibeli lewat Google Play Billing.
- Aplikasi mengirim token pembelian ke server; server memverifikasinya ke Google Play Developer API, baru kemudian mengubah status.
- Real-time Developer Notifications menangani perpanjangan, pembatalan, gagal bayar, dan refund secara otomatis.
- Status tidak pernah diubah oleh aplikasi sendiri. Pembelian Komunitas Pro ditautkan ke ID komunitas.
- Iklan internal: ajakan upgrade di titik pengguna menyentuh batas paket gratis.

### 2.6 Fitur komunitas lanjutan

- Jadwal lari rutin dengan RSVP. Absensi lewat QR atau check-in GPS (Komunitas Pro).
- Liga antar komunitas: papan peringkat bulanan per kota. Hanya menghitung lari yang direkam di aplikasi atau dari sumber yang mengizinkan.
- Cari teman lari berdasarkan pace, lokasi, dan jam.
- Kas komunitas dan pre-order jersey: pencatatan saja di fase ini, tanpa aliran dana lewat aplikasi.
- Peta spot lari lokal dengan info penerangan, toilet, dan parkir.

### 2.7 Iklan AdMob

- Banner dan iklan native di feed dan daftar event untuk pengguna gratis. Tidak ada iklan saat tracking berlangsung atau di chat.
- Pengguna Premium tidak melihat iklan.

## Fase 3: marketplace dan sponsor

Fase 3 selesai ketika penjual bisa memasang barang, sponsor bisa membeli banner sendiri, dan aplikasi mendapat margin tanpa menampung dana pengguna.

### 3.1 Verifikasi Level 2

- Unggah foto KTP dan selfie, OCR membaca NIK dan nama, lalu dicocokkan.
- Layar persetujuan terpisah sebelum unggah. Foto dihapus setelah diproses; hanya status dan NIK ter-hash yang disimpan.
- Kasus yang gagal otomatis masuk antrean tinjauan manual super admin.

### 3.2 Marketplace

Tiga model berjalan berdampingan, dipilih penjual per listing:

| Model | Cara kerja | Pendapatan aplikasi | Aliran dana |
| --- | --- | --- | --- |
| Biaya listing | Penjual membayar untuk memasang atau menaikkan iklan; transaksi terjadi di luar aplikasi | Biaya pasang dan boost, lewat Midtrans | Tidak ada dana pembeli lewat aplikasi |
| Afiliasi | Listing mengarah ke toko penjual di marketplace lain | Komisi afiliasi | Tidak ada |
| Split payment | Pembeli membayar di aplikasi; Xendit xenPlatform membagi otomatis ke penjual dan ke aplikasi | Komisi flat atau persen per transaksi | Dipegang Xendit, bukan pemilik aplikasi |

- Split payment hanya untuk penjual Level 2, karena ada biaya per akun penjual aktif per bulan.
- Listing: foto, harga, kategori, kondisi, kota. Pembeli menghubungi penjual lewat chat aplikasi.
- Kebijakan transaksi ditampilkan dan disetujui sebelum memasang atau membeli: barang terlarang, posisi aplikasi sebagai perantara, biaya layanan, alur sengketa dan refund, sanksi penjual.
- Listing dan penjual bisa dilaporkan.

### 3.3 Banner sponsor dan dasbor swalayan

- Sponsor (Level 2) mengunggah banner di dasbor web, memilih slot, kota sasaran, dan periode, lalu membayar lewat Midtrans.
- Banner tayang setelah disetujui super admin dan turun otomatis saat periode habis.
- Dasbor menampilkan jumlah tayangan dan klik.
- Slot banner: beranda, daftar event, halaman detail event. Banner event tertaut ke event di kalender.

## Gratis vs berbayar

Semua batas ditegakkan di server, bukan di aplikasi.

**Pelari**

| Fitur | Gratis | Premium (Rp29.000/bulan) |
| --- | --- | --- |
| Bergabung ke komunitas | Maksimal 3 | Tak terbatas |
| Tracking, status lari, chat, feed | Ya | Ya |
| Mode aman / SOS | Tidak | Ya |
| Riwayat lari | 3 bulan terakhir | Penuh, dengan statistik lengkap |
| Rak medali | 5 medali | Tak terbatas |
| Cari teman lari | Dasar | Dengan filter pace, lokasi, dan jam |
| Iklan | Ada | Tanpa iklan |
| Lencana | Tidak ada | Lencana Premium di avatar dan profil |

**Admin komunitas**

| Fitur | Gratis | Komunitas Pro (Rp99.000/bulan) |
| --- | --- | --- |
| Jumlah komunitas yang dibuat | 1 | Sesuai langganan per komunitas |
| Anggota | Maksimal 3 | Maksimal 30, lebih dari 30 contact dev dan harga langganan berubah 150ribu dan unlimited |
| Jadwal lari + RSVP | Ya | Ya |
| Absensi QR / GPS | Tidak | Ya |
| Kas komunitas dan pre-order jersey | Tidak | Ya |
| Statistik komunitas | Tidak | Ya |
| Liga antar komunitas | Tidak | Ya |
| Multi-admin | Tidak | Ya |
| Lencana | Tidak ada | Lencana Pro di halaman komunitas dan avatar admin |

Saat langganan berakhir, data tidak dihapus. Riwayat di luar batas disembunyikan, dan komunitas di atas 50 anggota tidak bisa menerima anggota baru sampai berlangganan lagi.

## Keamanan dan privasi

Syarat di bawah berlaku untuk setiap modul. Sebuah modul belum selesai jika salah satunya belum terpenuhi.

**Data dalam perjalanan**

- HTTPS (TLS 1.2 ke atas) untuk semua permintaan, termasuk WebSocket. Permintaan tanpa enkripsi ditolak.
- Certificate pinning di aplikasi.
- Data pribadi tidak pernah masuk ke URL atau query string.

**Data tersimpan**

- Kata sandi di-hash dengan Argon2.
- Kolom sensitif dienkripsi di database: nomor HP, email, NIK ter-hash, rute lari, isi chat.
- Foto KTP dan selfie tidak pernah ditulis ke disk atau log.
- Token login di ponsel disimpan di Android Keystore.
- Cadangan database dienkripsi dan disimpan di luar VPS.

**Akses**

- Token akses berumur pendek, token penyegar dirotasi, logout mencabut semuanya.
- Hak akses diperiksa di server pada setiap permintaan: pengguna hanya bisa mengambil data miliknya atau komunitas tempat ia terdaftar.
- Pembatasan laju pada login, OTP, pencarian, dan unggahan.
- Panel super admin: verifikasi dua langkah dan log tindakan.

**Server dan rahasia**

- Kunci API (Midtrans, Xendit, Google, Garmin, sesi Baileys) disimpan di luar kode dan tidak masuk ke GitHub.
- Webhook pembayaran dan notifikasi Google Play diverifikasi tanda tangannya sebelum diproses.
- Pemindaian otomatis di CI untuk celah dependensi dan rahasia yang bocor.
- Unggahan gambar diperiksa jenis dan ukurannya; metadata lokasi di foto dihapus.

**Privasi lokasi dan chat**

- Status lari mati secara bawaan dan hanya tampil ke komunitas yang dipilih.
- Titik lokasi langsung dihapus begitu lari selesai.
- Zona privasi menyamarkan titik awal dan akhir rute.
- Chat terenkripsi dalam perjalanan dan di database, tidak ujung-ke-ujung. Super admin hanya bisa membuka chat yang dilaporkan.
- Hapus akun: pesan di chat pribadi ikut terhapus; di chat komunitas nama diganti "Pengguna dihapus".

**Sebelum rilis**

- Uji penetrasi mandiri dengan daftar periksa OWASP untuk API dan aplikasi mobile, plus pemindaian otomatis (misalnya OWASP ZAP) di CI.
- Uji pemulihan cadangan di mesin bersih.

**Risiko yang diketahui**

- Baileys adalah klien WhatsApp tidak resmi; nomor pengirim bisa diblokir. Cadangan OTP email wajib berfungsi.
- VPS dipakai bersama layanan lain. Stack harus terisolasi, dan pindah ke VPS khusus direncanakan saat pengguna bertambah.

## Yang harus diverifikasi dan disiapkan

**Diverifikasi sebelum modul terkait dibangun**

| Hal | Yang diketahui per 10 November 2026 | Modul |
| --- | --- | --- |
| Biaya layanan Google Play | Langganan wajib lewat Play Billing. Besaran potongan untuk Indonesia belum dicek di Play Console | 2.5 |
| Jenis akun developer | Akun saat ini pribadi. Akun organisasi atas nama PT disarankan; syarat D-U-N-S dan uji tertutup untuk akun pribadi baru belum dicek ulang | Rilis |
| Garmin | Gratis untuk developer bisnis yang disetujui. Akses Starter: push saja, tanpa data historis, maksimal 1.000 pengguna terhubung | 2.3 |
| Strava | Data hanya boleh ditampilkan ke pemiliknya | 2.3 |
| Xendit xenPlatform | Rp25.000 per akun penjual aktif per bulan menurut satu sumber; apakah dana bisa ditahan sampai barang diterima belum dipastikan | 3.2 |
| Biaya Xendit | Sumber berbeda soal biaya proses tambahan Rp4.000; konfirmasi ke sales | 3.2 |
| Scraping event | Periksa ketentuan tiap situs sumber sebelum di-scrape | 2.4 |
| Nama PaceTara | Pencarian cepat tidak menemukan nama yang sama; cek merek di PDKI dan Play Store belum dilakukan | Rilis |
| Kepatuhan data pribadi | Kebijakan privasi dan alur KTP perlu ditinjau terhadap UU PDP, sebaiknya oleh konsultan hukum | 1.2, 3.1 |

**Disiapkan pemilik**

- [ ] Arahkan DNS pace-api.bimacreative.tech ke VPS, dan tentukan subdomain panel admin serta halaman publik
- [ ] Nomor WhatsApp khusus untuk OTP (bukan nomor pribadi)
- [ ] Proyek Google Cloud: login Google, Play Developer API, Pub/Sub untuk notifikasi langganan
- [ ] Akun Midtrans atas nama PT
- [ ] Akun Xendit dengan xenPlatform (sebelum Fase 3)
- [ ] Akun AdMob (sebelum modul 2.7)
- [ ] Pendaftaran Garmin Connect Developer Program atas nama PT, setelah kebijakan privasi tayang
- [ ] Naskah kebijakan privasi dan kebijakan transaksi marketplace
- [ ] Lokasi cadangan di luar VPS

## Cara memakai dokumen ini di Claude Code

Satu modul dikerjakan dalam satu sesi, supaya tiap sesi tetap kecil dan hemat batas pemakaian.

1. Simpan dokumen ini sebagai `docs/PRD.md` di repositori (ekspor ke Markdown dari menu dokumen).
2. Buat `CLAUDE.md` di akar repositori yang memuat: stack, aturan portabilitas container, dan seluruh bagian Keamanan dan privasi. Berkas ini dibaca di setiap sesi.
3. Mulai tiap sesi dengan satu modul, misalnya: "Kerjakan modul 1.3 Komunitas sesuai docs/PRD.md. Baca hanya bagian itu dan bagian Keamanan."
4. Minta rencana singkat dulu, setujui, baru minta kode. Tiap modul diakhiri dengan tes dan satu commit.
5. Catat keputusan teknis yang muncul di `docs/KEPUTUSAN.md`, agar sesi berikutnya tidak mengulang diskusi.
6. Jangan lanjut ke modul berikutnya sebelum kriteria "Selesai jika" terpenuhi.

**Urutan pengerjaan**

| Urutan | Modul | Bergantung pada |
| --- | --- | --- |
| 1 | 1.1 Fondasi | – |
| 2 | 1.2 Akun dan login | 1.1 |
| 3 | 1.3 Komunitas | 1.2 |
| 4 | 1.4 Tracking lari | 1.2 |
| 5 | 1.5 Status lari | 1.3, 1.4 |
| 6 | 1.6 Chat | 1.3 |
| 7 | 1.8 Laporan dan panel super admin | 1.3, 1.6 |
| 8 | 1.7 Kalender event | 1.8 |
| 9 | 1.9 Notifikasi, 1.10 Mode aman | 1.5, 1.6 |
| 10 | Uji penetrasi mandiri, lalu rilis uji tertutup | Seluruh Fase 1 |
| 11 | Fase 2, urut 2.1 sampai 2.7 | Fase 1 |
| 12 | Fase 3, urut 3.1 sampai 3.3 | Fase 2 |

## Sumber

Halaman yang dibuka selama riset, per 10 November 2026. Angka harga dan kebijakan bisa berubah.

- [Map My Run di ScreensDesign](https://screensdesign.com/apps/map-my-run-gps-running-tracker/?id=370&av=2709) (referensi awal)
- [Midtrans: daftar harga](https://midtrans.com/pricing)
- [Midtrans vs Xendit, paymentreview.com](https://paymentreview.com/comparisons/midtrans-vs-xendit/)
- [Xendit: split payments](https://docs.xendit.co/docs/split-payments)
- [Xendit: Platform Fee](https://www.xendit.co/en/blog/introducing-platform-fee-a-split-payment-system-for-platforms-and-marketplaces/)
- [Perbandingan payment gateway, iPaymu](https://ipaymu.com/id/price-comparison/)
- [Play Console Help: user choice billing](https://support.google.com/googleplay/android-developer/answer/13821247?hl=en)
- [Google Play Help: sistem pembayaran alternatif](https://support.google.com/googleplay/answer/11174377?hl=en)
- [Garmin Connect Developer Program: akses Starter dan Enterprise](https://developerportal.garmin.com/developer-programs/connect-developer-api)
- [Garmin: Activity API](https://developer.garmin.com/gc-developer-program/activity-api)
- [Syarat aplikasi Garmin, dokumentasi Terra](https://docs.tryterra.co/unified-api/garmin)
- [Perubahan API Strava, road.cc](https://road.cc/content/news/strava-users-cant-publicly-share-data-third-party-apps-311329)
- [Baileys vs WhatsApp Cloud API, wiki Zaileys](https://github.com/zeative/zaileys/wiki)
