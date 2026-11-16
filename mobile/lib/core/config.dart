import 'package:flutter/foundation.dart';

/// Konfigurasi dari `--dart-define`. Tidak ada alamat IP di kode.
///   flutter run --dart-define=API_BASE_URL=https://pace-api.bimacreative.tech
class AppConfig {
  static const apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'https://pace-api.bimacreative.tech',
  );

  /// Client ID OAuth tipe "Web" dari Google Cloud (bukan yang Android). Dipakai agar ID token
  /// ber-`aud` client ini dan bisa diverifikasi server. Kosong = tombol Google disembunyikan.
  static const googleServerClientId = String.fromEnvironment('GOOGLE_SERVER_CLIENT_ID');

  /// Sumber tile peta: server tile sendiri (tileserver-gl + data OpenStreetMap, KEPUTUSAN #315) di domain API,
  /// open source, gratis, tanpa kunci API, dan area yang dilihat pengguna tidak dikirim ke pihak ketiga.
  static const mapTileUrl = String.fromEnvironment(
    'MAP_TILE_URL',
    defaultValue: '$apiBaseUrl/tiles/styles/basic-preview/{z}/{x}/{y}.png',
  );

  /// Dipakai hanya jika tile utama gagal dimuat (mis. server tile belum dinyalakan). Kosong = tanpa cadangan.
  /// Server OSM publik tidak boleh dipakai berat, jadi ini hanya jaring pengaman masa transisi.
  static const mapTileFallbackUrl = String.fromEnvironment(
    'MAP_TILE_FALLBACK_URL',
    defaultValue: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  );

  static const mapAttribution = String.fromEnvironment('MAP_ATTRIBUTION', defaultValue: 'OpenMapTiles · OpenStreetMap contributors');
  static const mapAttributionUrl = String.fromEnvironment('MAP_ATTRIBUTION_URL', defaultValue: 'https://www.openstreetmap.org/copyright');

  /// Firebase Cloud Messaging untuk push (modul 1.9). Diisi CI dari variabel repo; kosong = push mati,
  /// notifikasi di dalam aplikasi tetap berjalan. Nilai ini bukan rahasia (ikut di setiap APK).
  static const firebaseApiKey = String.fromEnvironment('FIREBASE_API_KEY');
  static const firebaseAppId = String.fromEnvironment('FIREBASE_APP_ID');
  static const firebaseSenderId = String.fromEnvironment('FIREBASE_SENDER_ID');
  static const firebaseProjectId = String.fromEnvironment('FIREBASE_PROJECT_ID');
  static bool get pushConfigured =>
      firebaseApiKey.isNotEmpty && firebaseAppId.isNotEmpty && firebaseSenderId.isNotEmpty && firebaseProjectId.isNotEmpty;

  /// ID unit iklan AdMob (modul 2.7). Diisi CI dari variabel repo; bukan rahasia (ikut di setiap APK).
  /// Kosong di build rilis = tidak ada iklan sama sekali; di build debug memakai unit uji resmi Google.
  /// ID aplikasi AdMob (`ADMOB_APP_ID`) tidak dibaca Dart: Gradle menaruhnya di manifest.
  static const admobNativeFeed = String.fromEnvironment('ADMOB_NATIVE_FEED');
  static const admobBannerFeed = String.fromEnvironment('ADMOB_BANNER_FEED');
  static const admobBannerEvents = String.fromEnvironment('ADMOB_BANNER_EVENTS');

  /// Hanya untuk development dengan Caddy lokal (CA internal). Diabaikan di build rilis.
  static const allowDevCa = bool.fromEnvironment('ALLOW_DEV_CA');

  static void validate() => validateUrl(apiBaseUrl, release: kReleaseMode);

  @visibleForTesting
  static void validateUrl(String url, {required bool release}) {
    final uri = Uri.tryParse(url);
    if (uri == null || uri.scheme != 'https' || uri.host.isEmpty) {
      throw StateError('API_BASE_URL harus berupa URL https');
    }
    final isIp = RegExp(r'^\d{1,3}(\.\d{1,3}){3}$').hasMatch(uri.host) || uri.host.contains(':');
    if (release && isIp) {
      throw StateError('Build rilis tidak boleh memanggil alamat IP');
    }
  }
}
