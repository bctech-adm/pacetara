import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../storage/token_storage.dart';

class TokenPair {
  const TokenPair({required this.accessToken, required this.refreshToken});
  final String accessToken;
  final String refreshToken;

  factory TokenPair.fromJson(Map<String, dynamic> json) => TokenPair(
        accessToken: json['accessToken'] as String,
        refreshToken: json['refreshToken'] as String,
      );
}

/// Menyimpan token di memori + Keystore dan melakukan refresh.
///
/// Refresh dijalankan satu per satu (single-flight): server mencabut seluruh sesi jika token
/// penyegar yang sudah dirotasi dipakai lagi, jadi dua refresh paralel akan memutus sesi sendiri.
class SessionManager {
  SessionManager(this._storage);

  final TokenStorage _storage;
  String? _access;
  String? _refresh;
  Future<bool>? _refreshing;
  final _expired = StreamController<void>.broadcast();

  /// Dipancarkan saat sesi tidak bisa diperpanjang (harus masuk lagi).
  Stream<void> get onExpired => _expired.stream;

  String? get accessToken => _access;
  String? get refreshToken => _refresh;
  bool get hasSession => _refresh != null;

  Future<void> load() async {
    _access = await _storage.readAccess();
    _refresh = await _storage.readRefresh();
  }

  Future<void> save(TokenPair pair) async {
    _access = pair.accessToken;
    _refresh = pair.refreshToken;
    await _storage.save(access: pair.accessToken, refresh: pair.refreshToken);
  }

  Future<void> clear() async {
    _access = null;
    _refresh = null;
    await _storage.clear();
  }

  /// Memperpanjang sesi memakai [bare] (Dio tanpa interceptor auth). Mengembalikan false jika gagal.
  Future<bool> refresh(Dio bare) {
    return _refreshing ??= _doRefresh(bare).whenComplete(() => _refreshing = null);
  }

  Future<bool> _doRefresh(Dio bare) async {
    final token = _refresh;
    if (token == null) return false;
    try {
      final res = await bare.post<Map<String, dynamic>>('/v1/auth/refresh', data: {'refreshToken': token});
      await save(TokenPair.fromJson(res.data!));
      return true;
    } on DioException catch (e) {
      // Hanya akhiri sesi jika server menolak tokennya; galat jaringan → coba lagi nanti.
      if (e.response?.statusCode == 401) {
        await clear();
        _expired.add(null);
      }
      return false;
    }
  }

  void notifyExpired() => _expired.add(null);
}

final sessionManagerProvider = Provider<SessionManager>(
  (ref) => SessionManager(ref.watch(tokenStorageProvider)),
);
