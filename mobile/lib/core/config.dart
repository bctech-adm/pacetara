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

  /// Sumber tile peta. Bawaan OpenStreetMap hanya untuk uji: kebijakan OSM melarang pemakaian berat
  /// oleh aplikasi, jadi sebelum rilis ganti ke penyedia tile berbayar (lihat KEPUTUSAN.md).
  static const mapTileUrl = String.fromEnvironment(
    'MAP_TILE_URL',
    defaultValue: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  );
  static const mapAttribution = String.fromEnvironment('MAP_ATTRIBUTION', defaultValue: '© OpenStreetMap contributors');

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
