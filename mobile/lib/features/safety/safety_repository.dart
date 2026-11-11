import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../core/api/api_error.dart';
import '../../core/http/api_client.dart';
import '../../core/storage/token_storage.dart';

class EmergencyContact {
  const EmergencyContact({required this.id, required this.name, required this.phone});
  final String id;
  final String name;

  /// E.164 (+62…).
  final String phone;

  factory EmergencyContact.fromJson(Map<String, dynamic> j) =>
      EmergencyContact(id: j['id'] as String, name: j['name'] as String, phone: j['phone'] as String);

  Map<String, String> toJson() => {'id': id, 'name': name, 'phone': phone};
}

class SosResult {
  const SosResult({required this.delivered, required this.total, this.rateLimited = false});

  /// Jumlah kontak yang menerima pesan WhatsApp dari server.
  final int delivered;
  final int total;
  final bool rateLimited;
}

/// Teks SMS cadangan (dikirim dari HP pengguna sendiri, tanpa server dan tanpa internet).
String sosSmsText(String name, double lat, double lng) =>
    'SOS dari $name (PaceTara): saya butuh bantuan saat berlari. Lokasi terakhir: '
    'https://maps.google.com/?q=${lat.toStringAsFixed(6)},${lng.toStringAsFixed(6)} . Jika tidak bisa dihubungi, minta bantuan ke 112.';

/// URI SMS ke semua kontak sekaligus. Isi di-encode dengan %20 (bukan "+") agar tampil benar di aplikasi SMS.
Uri sosSmsUri(List<EmergencyContact> contacts, String body) =>
    Uri.parse('sms:${contacts.map((c) => c.phone).join(',')}?body=${Uri.encodeComponent(body)}');

/// Kontak darurat dan SOS. Daftar kontak juga disimpan di Android Keystore (flutter_secure_storage)
/// agar SMS cadangan tetap bisa dikirim saat tidak ada internet.
class SafetyRepository {
  SafetyRepository(this._dio, this._storage);
  final Dio _dio;
  final FlutterSecureStorage _storage;
  static const _cacheKey = TokenStorage.emergencyContactsKey;

  Future<T> _call<T>(Future<T> Function() fn) async {
    try {
      return await fn();
    } catch (e) {
      throw ApiError.from(e);
    }
  }

  Future<List<EmergencyContact>> contacts() async {
    final list = await _call(() async {
      final res = await _dio.get<List<dynamic>>('/v1/me/emergency-contacts');
      return res.data!.map((e) => EmergencyContact.fromJson(e as Map<String, dynamic>)).toList();
    });
    await _saveCache(list);
    return list;
  }

  /// Kontak dari server, atau dari salinan lokal jika server tidak terjangkau.
  Future<List<EmergencyContact>> contactsForSos() async {
    try {
      return await contacts();
    } catch (_) {
      return cachedContacts();
    }
  }

  Future<List<EmergencyContact>> cachedContacts() async {
    try {
      final raw = await _storage.read(key: _cacheKey);
      if (raw == null) return const [];
      return (jsonDecode(raw) as List<dynamic>).map((e) => EmergencyContact.fromJson(e as Map<String, dynamic>)).toList();
    } catch (_) {
      return const [];
    }
  }

  Future<void> _saveCache(List<EmergencyContact> list) async {
    try {
      await _storage.write(key: _cacheKey, value: jsonEncode(list.map((c) => c.toJson()).toList()));
    } catch (_) {
      // Cache opsional.
    }
  }

  Future<void> clearCache() => _storage.delete(key: _cacheKey).catchError((_) {});

  Future<void> add(String name, String phone) => _call(() async {
        await _dio.post<void>('/v1/me/emergency-contacts', data: {'name': name, 'phone': phone});
        await contacts();
      });

  Future<void> remove(String id) => _call(() async {
        await _dio.delete<void>('/v1/me/emergency-contacts/$id');
        await contacts();
      });

  /// Kirim SOS lewat server (WhatsApp ke semua kontak). Lokasi di body, bukan URL.
  Future<SosResult> sos({required double lat, required double lng, double? accuracyM}) async {
    try {
      final res = await _dio.post<Map<String, dynamic>>('/v1/sos', data: {
        'lat': lat,
        'lng': lng,
        'accuracyM': ?accuracyM,
      });
      final results = res.data!['results'] as List<dynamic>;
      return SosResult(delivered: (res.data!['delivered'] as num).toInt(), total: results.length);
    } catch (e) {
      final err = ApiError.from(e);
      if (err.code == 'sos_rate_limited') return const SosResult(delivered: 0, total: 0, rateLimited: true);
      throw err;
    }
  }
}

final safetyRepositoryProvider =
    Provider<SafetyRepository>((ref) => SafetyRepository(ref.watch(dioProvider), const FlutterSecureStorage()));

final emergencyContactsProvider = FutureProvider.autoDispose<List<EmergencyContact>>((ref) => ref.watch(safetyRepositoryProvider).contacts());
