import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pacetara/app.dart';
import 'package:pacetara/core/api/api_error.dart';
import 'package:pacetara/features/auth/models.dart';

MyProfile profile({bool email = true, bool phone = true}) => MyProfile.fromJson({
      'id': 'u1',
      'displayName': 'Budi',
      'email': 'budi@example.com',
      'emailVerified': email,
      'phone': phone ? '+6281234567890' : null,
      'phoneVerified': phone,
      'hasPassword': true,
      'googleLinked': false,
      'avatarUrl': null,
      'city': 'Bandung',
      'avgPaceSecPerKm': 390,
      'verificationLevel': email && phone ? 1 : 0,
      'badges': <String>[],
    });

void main() {
  group('authRedirect', () {
    test('memuat atau server tak terjangkau → tetap di splash', () {
      expect(authRedirect(const AsyncLoading(), '/'), '/splash');
      expect(authRedirect(AsyncError<MyProfile?>(Exception('x'), StackTrace.empty), '/splash'), isNull);
    });

    test('belum masuk → login, kecuali halaman publik', () {
      expect(authRedirect(const AsyncData(null), '/'), '/login');
      expect(authRedirect(const AsyncData(null), '/profile'), '/login');
      expect(authRedirect(const AsyncData(null), '/register'), isNull);
      expect(authRedirect(const AsyncData(null), '/forgot-password'), isNull);
    });

    test('email belum terverifikasi → verifikasi email dulu', () {
      expect(authRedirect(AsyncData(profile(email: false, phone: false)), '/'), '/verify-email');
    });

    test('email sudah, HP belum → verifikasi HP', () {
      expect(authRedirect(AsyncData(profile(phone: false)), '/'), '/verify-phone');
      expect(authRedirect(AsyncData(profile(phone: false)), '/verify-email'), '/verify-phone');
    });

    test('Level 1 → beranda, tidak bisa kembali ke layar login/verifikasi', () {
      expect(authRedirect(AsyncData(profile()), '/login'), '/');
      expect(authRedirect(AsyncData(profile()), '/verify-phone'), '/');
      expect(authRedirect(AsyncData(profile()), '/profile'), isNull);
    });
  });

  group('pace', () {
    test('format dan urai', () {
      expect(formatPace(390), '6:30');
      expect(parsePace('6:30'), 390);
      expect(parsePace(' 12:05 '), 725);
    });

    test('menolak format salah atau di luar 2:00–30:00', () {
      // Keyboard angka banyak HP tidak punya ":".
      expect(parsePace('6.30'), 390);
      expect(parsePace('6,30'), 390);
      expect(parsePace('630'), 390);
      expect(parsePace('1230'), 750);
      expect(parsePace('6.3'), isNull);
      expect(parsePace('abc'), isNull);
      expect(parsePace('1:59'), isNull);
      expect(parsePace('30:01'), isNull);
      expect(parsePace('6:60'), isNull);
    });

    test('dua kolom terpisah: menit dan detik', () {
      expect(paceFieldsError('', ''), isNull);
      expect(paceFromFields('', ''), isNull);
      expect(paceFromFields('6', '30'), 390);
      expect(paceFromFields('6', ''), 360);
      expect(paceFromFields('06', '05'), 365);
      expect(paceFieldsError('', '30'), 'Isi menit');
      expect(paceFieldsError('6', '75'), 'Detik 0–59');
      expect(paceFieldsError('1', '59'), 'Pace antara 2:00 dan 30:00');
      expect(paceFieldsError('31', '0'), 'Pace antara 2:00 dan 30:00');
      expect(paceFromFields('31', '0'), isNull);
    });
  });

  test('MyProfile.fromJson', () {
    final p = profile();
    expect(p.isLevel1, isTrue);
    expect(p.avgPaceSecPerKm, 390);
  });

  group('ApiError.from', () {
    test('membaca kode dan pesan dari respons API', () {
      final e = ApiError.from(DioException(
        requestOptions: RequestOptions(path: '/v1/auth/login'),
        response: Response(
          requestOptions: RequestOptions(path: '/v1/auth/login'),
          statusCode: 401,
          data: {'statusCode': 401, 'error': 'invalid_credentials', 'message': 'Email atau kata sandi salah'},
        ),
      ));
      expect(e.status, 401);
      expect(e.code, 'invalid_credentials');
      expect(e.message, 'Email atau kata sandi salah');
    });

    test('galat validasi per field', () {
      final e = ApiError.from(DioException(
        requestOptions: RequestOptions(path: '/x'),
        response: Response(requestOptions: RequestOptions(path: '/x'), statusCode: 400, data: {
          'error': 'invalid_input',
          'fields': [
            {'field': 'email', 'message': 'Email tidak valid'},
          ],
        }),
      ));
      expect(e.fields['email'], 'Email tidak valid');
      expect(e.message, 'Email tidak valid');
    });

    test('galat jaringan', () {
      final e = ApiError.from(DioException(
        requestOptions: RequestOptions(path: '/x'),
        type: DioExceptionType.connectionError,
      ));
      expect(e.code, 'network');
    });
  });
}
