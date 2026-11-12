import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_error.dart';
import '../../core/http/api_client.dart';

/// Percobaan verifikasi terakhir (tanpa data pribadi: hanya status, alasan, dan catatan peninjau).
class KycAttempt {
  const KycAttempt({required this.status, required this.auto, required this.messages, this.note});
  final String status;
  final bool auto;
  final List<String> messages;
  final String? note;

  factory KycAttempt.fromJson(Map<String, dynamic> j) => KycAttempt(
        status: j['status'] as String,
        auto: j['auto'] as bool? ?? true,
        messages: (j['messages'] as List<dynamic>? ?? const []).cast<String>(),
        note: j['note'] as String?,
      );
}

class KycStatus {
  const KycStatus({
    required this.enabled,
    required this.level,
    required this.verified,
    required this.consentVersion,
    required this.attemptsLeft,
    this.last,
  });
  final bool enabled;
  final int level;
  final bool verified;
  final String consentVersion;
  final int attemptsLeft;
  final KycAttempt? last;

  bool get inReview => last?.status == 'review';

  factory KycStatus.fromJson(Map<String, dynamic> j) => KycStatus(
        enabled: j['enabled'] as bool? ?? false,
        level: (j['level'] as num?)?.toInt() ?? 0,
        verified: j['verified'] as bool? ?? false,
        consentVersion: j['consentVersion'] as String? ?? '',
        attemptsLeft: (j['attemptsLeft'] as num?)?.toInt() ?? 0,
        last: j['last'] is Map<String, dynamic> ? KycAttempt.fromJson(j['last'] as Map<String, dynamic>) : null,
      );
}

/// Hasil satu percobaan: approved (Level 2), review (ditinjau tim), retry (ulangi foto/ketikan).
class KycResult {
  const KycResult(this.status, this.messages);
  final String status;
  final List<String> messages;
}

class KycRepository {
  KycRepository(this._dio);
  final Dio _dio;

  Future<KycStatus> status() async {
    try {
      return KycStatus.fromJson((await _dio.get<Map<String, dynamic>>('/v1/kyc')).data!);
    } catch (e) {
      throw ApiError.from(e);
    }
  }

  /// Foto dikirim dari memori (multipart, lewat koneksi ber-pinning); NIK dan nama di field `data`, tidak di URL.
  /// Server memproses foto di memori lalu membuangnya.
  Future<KycResult> submit({
    required String nik,
    required String name,
    required String consentVersion,
    required Uint8List ktp,
    required Uint8List selfie,
  }) async {
    try {
      final form = FormData.fromMap({
        'data': jsonEncode({'nik': nik, 'name': name, 'consent': true, 'consentVersion': consentVersion}),
        'ktp': MultipartFile.fromBytes(ktp, filename: 'ktp.jpg'),
        'selfie': MultipartFile.fromBytes(selfie, filename: 'selfie.jpg'),
      });
      // Analisis OCR + wajah di server bisa beberapa detik (lebih lama untuk permintaan pertama).
      final res = await _dio.post<Map<String, dynamic>>('/v1/kyc', data: form, options: Options(receiveTimeout: const Duration(seconds: 120)));
      final j = res.data!;
      return KycResult(j['status'] as String, (j['messages'] as List<dynamic>? ?? const []).cast<String>());
    } catch (e) {
      throw ApiError.from(e);
    }
  }
}


final kycRepositoryProvider = Provider<KycRepository>((ref) => KycRepository(ref.watch(dioProvider)));
final kycStatusProvider = FutureProvider.autoDispose<KycStatus>((ref) => ref.watch(kycRepositoryProvider).status());
