import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Token login disimpan di Android Keystore lewat flutter_secure_storage.
/// Jangan pernah menyimpan token di SharedPreferences biasa atau menuliskannya ke log.
class TokenStorage {
  TokenStorage(this._storage);
  final FlutterSecureStorage _storage;

  static const _access = 'access_token';
  static const _refresh = 'refresh_token';

  Future<String?> readAccess() => _storage.read(key: _access);
  Future<String?> readRefresh() => _storage.read(key: _refresh);

  Future<void> save({required String access, required String refresh}) async {
    await _storage.write(key: _access, value: access);
    await _storage.write(key: _refresh, value: refresh);
  }

  Future<void> clear() async {
    await _storage.delete(key: _access);
    await _storage.delete(key: _refresh);
  }
}

final tokenStorageProvider = Provider<TokenStorage>(
  (ref) => TokenStorage(const FlutterSecureStorage()),
);
