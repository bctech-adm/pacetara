# PaceTara — aplikasi Android (Flutter)

Folder platform (`android/`) belum ada karena dihasilkan oleh Flutter. Jalankan sekali:

```sh
cd mobile
flutter create --platforms=android --org tech.bimacreative --project-name pacetara .
flutter pub get
```

Lalu tambahkan atribut berikut ke elemen `<application>` di `android/app/src/main/AndroidManifest.xml`:

```xml
android:usesCleartextTraffic="false"
android:allowBackup="false"
android:fullBackupContent="false"
```

Izin lokasi latar belakang dan foreground service ditambahkan di modul 1.4, bersama deklarasi Play Console yang dibutuhkan.

## Menjalankan

```sh
# Ke API produksi
flutter run --dart-define=API_BASE_URL=https://pace-api.bimacreative.tech

# Ke stack lokal (docker compose, CA internal Caddy)
flutter run --dart-define=API_BASE_URL=https://api.localhost:8443 --dart-define=ALLOW_DEV_CA=true
```

`ALLOW_DEV_CA` hanya berlaku di build debug; build rilis selalu mewajibkan sertifikat Let's Encrypt.

## Keamanan

- **Certificate pinning ke CA:** hanya root ISRG X1/X2 (`assets/certs/`) yang dipercaya. Kedua root berlaku sampai 2035 dan 2040.
- **Token** di Android Keystore (`flutter_secure_storage`), lihat `lib/core/storage/token_storage.dart`.
- **Tanpa cleartext:** `usesCleartextTraffic=false` dan `allowBackup=false` di manifest.
