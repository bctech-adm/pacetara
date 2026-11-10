# Review PRD PaceTara

10 November 2026. Temuan dari membaca `docs/PRD.md`, diurutkan dari yang paling perlu diputuskan pemilik.

## A. Kontradiksi di dalam PRD (perlu diputuskan)

| # | Temuan | Lokasi | Usulan |
| --- | --- | --- | --- |
| A1 | Mode aman/SOS disebut "Gratis untuk semua pengguna" di modul 1.10, tetapi tabel Gratis vs berbayar menulis Gratis: **Tidak**, Premium: Ya. | 1.10 vs tabel Pelari | Tetap gratis. Fitur keselamatan di balik paywall berisiko reputasi dan etika. |
| A2 | Batas anggota komunitas gratis 3, Pro 30, >30 = Rp150.000 tanpa batas. Tetapi paragraf penutup menyebut "komunitas di atas **50** anggota tidak bisa menerima anggota baru". | Tabel Admin komunitas vs paragraf setelahnya | Samakan. Usulan teknis: tier `free=3`, `pro=30`, `pro_unlimited=∞`; saat langganan berakhir, komunitas di atas batas tier-nya tidak menerima anggota baru. |
| A3 | Modul 1.3 menyebut admin bisa "mengangkat admin lain", tetapi multi-admin hanya untuk Komunitas Pro. | 1.3 vs tabel Admin | Endpoint angkat admin ditolak server bila komunitas bukan Pro. |
| A4 | Tier Rp150.000 "contact dev" tidak punya produk Play Billing. | Tabel Admin | Buat produk langganan Play ketiga (`community_pro_unlimited`) agar tidak ada jalur bayar manual. |

## B. Risiko bisnis

- **B1. Komunitas gratis maksimal 3 anggota terlalu kecil.** Komunitas dengan 3 orang hampir tidak bisa dipakai, sehingga efek jaringan (orang mengajak teman) mati sebelum mulai. Pertimbangkan 15–20 anggota gratis, dan jual Pro lewat fitur (absensi, kas, statistik, liga, multi-admin).
- **B2. Liga antar komunitas khusus Pro** berarti papan peringkat per kota akan sangat sepi di awal.

## C. Kepatuhan platform dan hukum

- **C1. Biaya listing/boost lewat Midtrans di dalam aplikasi berisiko melanggar kebijakan Google Play.** Boost listing adalah layanan digital yang dipakai di dalam aplikasi, sehingga kemungkinan wajib Play Billing. Barang fisik (split payment Xendit) boleh di luar Play Billing. Usulan: bayar listing/boost lewat web (pace.bimacreative.tech) atau lewat Play Billing.
- **C2. NIK ter-hash biasa bisa dibalik dengan brute force.** NIK hanya 16 digit dengan struktur yang mudah ditebak (kode wilayah + tanggal lahir). Gunakan **HMAC dengan kunci rahasia** (pepper), bukan SHA-256 biasa. Ini sudah diterapkan di utilitas kripto modul 1.1.
- **C3. OCR KTP + pencocokan wajah.** Mesin self-hosted (Tesseract + face match open-source) akurasinya rendah untuk KTP. Penyedia pihak ketiga berarti data dikirim ke prosesor lain dan butuh perjanjian pemrosesan data menurut UU PDP. Putuskan sebelum 3.1.
- **C4. Hapus akun vs. kewajiban menyimpan catatan transaksi.** Data transaksi marketplace dan pembayaran biasanya wajib disimpan untuk keperluan pajak dan sengketa. Kebijakan privasi perlu menyebut pengecualian ini.
- **C5. Izin Android sensitif.** Lokasi latar belakang, foreground service jenis `location`, dan Health Connect masing-masing butuh deklarasi di Play Console (lokasi latar belakang butuh video demo). Masukkan ke daftar persiapan rilis.
- **C6. Baileys melanggar ketentuan WhatsApp.** Risiko ini sudah tercatat di PRD. Pastikan alur OTP email diuji sebagai jalur utama kedua, bukan sekadar cadangan.

## D. Catatan teknis (sudah dijawab di docs/KEPUTUSAN.md)

- **D1. Email dan nomor HP terenkripsi tetap harus bisa dicari** untuk login dan cek duplikat. Solusinya *blind index*: HMAC-SHA256 dari nilai yang dinormalisasi, disimpan di kolom terpisah yang unik.
- **D2. Certificate pinning + Let's Encrypt.** Sertifikat Caddy berganti otomatis setiap ±60–90 hari. Pin ke sertifikat leaf akan membuat aplikasi mati saat sertifikat diperbarui. Diputuskan: pin ke root ISRG X1/X2 dan kunci Caddy ke Let's Encrypt (KEPUTUSAN #11).
- **D6. MinIO tidak lagi merilis image Docker.** Diganti SeaweedFS (API S3) tanpa mengubah desain (KEPUTUSAN #14). Tabel arsitektur di PRD masih menyebut MinIO.
- **D3. Isi chat terenkripsi di database** berarti pencarian teks di server tidak mungkin. Ini sesuai PRD (tidak ada fitur cari pesan), tetapi perlu diketahui sejak awal.
- **D4. VPS bersama.** Jika port 80/443 sudah dipakai reverse proxy lain di VPS, Caddy PaceTara tidak bisa langsung mengikatnya. Port dibuat bisa diatur lewat `.env`; alternatifnya proxy yang sudah ada meneruskan domain ke Caddy PaceTara.
- **D5. Urutan 1.7 setelah 1.8** wajar (tombol lapor event butuh sistem laporan), tetapi panel super admin di 1.8 juga menjadi tempat input event manual 1.7, jadi keduanya memakai satu aplikasi web.

## E. Hal kecil

- "Siapa ikut?" juga perlu pengaturan privasi: apakah tanda ikut terlihat oleh semua anggota komunitas, atau hanya teman.
- Riwayat 3 bulan untuk akun gratis: pastikan lari yang lebih lama hanya disembunyikan, tidak dihapus (sesuai paragraf "data tidak dihapus").
- Lari hasil impor Strava dikecualikan dari statistik komunitas, sementara liga hanya menghitung "sumber yang mengizinkan". Daftar sumber yang diizinkan perlu ditulis eksplisit (usulan: in-app, Health Connect, Garmin).
