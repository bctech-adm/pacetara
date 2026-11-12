import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_sign_in/google_sign_in.dart';

import '../../core/api/api_error.dart';
import '../../core/config.dart';
import '../../core/http/api_client.dart';
import '../../core/session/session_manager.dart';
import '../chat/chat_outbox.dart';
import 'models.dart';

const _device = 'Android';

final authConfigProvider = FutureProvider<AuthConfig>((ref) async {
  final res = await ref.watch(bareDioProvider).get<Map<String, dynamic>>('/v1/auth/config');
  return AuthConfig.fromJson(res.data!);
});

/// Status login: `null` = belum masuk. Router mengarahkan layar berdasarkan nilai ini.
class AuthController extends AsyncNotifier<MyProfile?> {
  SessionManager get _session => ref.read(sessionManagerProvider);
  Dio get _dio => ref.read(dioProvider);
  Dio get _bare => ref.read(bareDioProvider);

  @override
  Future<MyProfile?> build() async {
    final sub = _session.onExpired.listen((_) => state = const AsyncData(null));
    ref.onDispose(sub.cancel);

    await _session.load();
    if (!_session.hasSession) return null;
    try {
      return await _fetchMe();
    } on ApiError catch (e) {
      if (e.status == 401) {
        await _session.clear();
        return null;
      }
      rethrow;
    }
  }

  Future<MyProfile> _fetchMe() async {
    try {
      final res = await _dio.get<Map<String, dynamic>>('/v1/me');
      return MyProfile.fromJson(res.data!);
    } catch (e) {
      throw ApiError.from(e);
    }
  }

  Future<void> _applyAuthResult(Map<String, dynamic> data) async {
    await _session.save(TokenPair.fromJson(data));
    state = AsyncData(MyProfile.fromJson(data['user'] as Map<String, dynamic>));
  }

  Future<T> _call<T>(Future<T> Function() fn) async {
    try {
      return await fn();
    } catch (e) {
      throw ApiError.from(e);
    }
  }

  // ---------- Masuk & daftar ----------

  Future<void> login(String email, String password) => _call(() async {
        final res = await _bare.post<Map<String, dynamic>>('/v1/auth/login',
            data: {'email': email, 'password': password, 'device': _device});
        await _applyAuthResult(res.data!);
      });

  Future<void> register({
    required String email,
    required String password,
    required String displayName,
    required String privacyVersion,
  }) =>
      _call(() async {
        final res = await _bare.post<Map<String, dynamic>>('/v1/auth/register', data: {
          'email': email,
          'password': password,
          'displayName': displayName,
          'acceptPrivacy': true,
          'privacyVersion': privacyVersion,
          'device': _device,
        });
        await _applyAuthResult(res.data!);
      });

  /// Membuka pemilih akun Google dan mengembalikan ID token (berlaku ±1 jam).
  Future<String> googleIdToken() async {
    try {
      await _ensureGoogleInitialized();
      final account = await GoogleSignIn.instance.authenticate();
      final token = account.authentication.idToken;
      if (token == null) throw const ApiError(0, 'google_failed', 'Login Google gagal, coba lagi');
      return token;
    } on GoogleSignInException catch (e) {
      if (e.code == GoogleSignInExceptionCode.canceled) {
        throw const ApiError(0, 'canceled', 'Login Google dibatalkan');
      }
      throw const ApiError(0, 'google_failed', 'Login Google gagal, coba lagi');
    }
  }

  /// Masuk dengan ID token Google. Jika akun belum ada dan [privacyVersion] null, melempar
  /// ApiError `privacy_required`; layar meminta persetujuan lalu memanggil ulang dengan token
  /// YANG SAMA (pemilih akun tidak dibuka dua kali).
  Future<void> loginWithGoogle({required String idToken, String? privacyVersion}) async {
    await _call(() async {
      final res = await _bare.post<Map<String, dynamic>>('/v1/auth/google', data: {
        'idToken': idToken,
        if (privacyVersion != null) ...{'acceptPrivacy': true, 'privacyVersion': privacyVersion},
        'device': _device,
      });
      await _applyAuthResult(res.data!);
    });
  }

  static Future<void>? _googleInit;
  Future<void> _ensureGoogleInitialized() => _googleInit ??= GoogleSignIn.instance.initialize(
        serverClientId: AppConfig.googleServerClientId.isEmpty ? null : AppConfig.googleServerClientId,
      );

  Future<void> logout() async {
    final refresh = _session.refreshToken;
    try {
      await _dio.post<void>('/v1/auth/logout', data: {'refreshToken': ?refresh});
    } catch (_) {
      // Tetap keluar di perangkat walau server tidak terjangkau.
    }
    await _session.clear();
    if (_googleInit != null) unawaited(GoogleSignIn.instance.signOut().catchError((_) {}));
    state = const AsyncData(null);
  }

  // ---------- Verifikasi ----------

  Future<void> sendEmailCode() => _call(() => _dio.post<void>('/v1/auth/email/send-code'));

  Future<void> verifyEmail(String code) => _call(() async {
        final res = await _dio.post<Map<String, dynamic>>('/v1/auth/email/verify', data: {'code': code});
        state = AsyncData(MyProfile.fromJson(res.data!));
      });

  Future<OtpChannel> sendPhoneCode(String phone) => _call(() async {
        final res = await _dio.post<Map<String, dynamic>>('/v1/auth/phone/send-code', data: {'phone': phone});
        return res.data!['channel'] == 'email' ? OtpChannel.email : OtpChannel.whatsapp;
      });

  Future<void> verifyPhone(String code) => _call(() async {
        final res = await _dio.post<Map<String, dynamic>>('/v1/auth/phone/verify', data: {'code': code});
        state = AsyncData(MyProfile.fromJson(res.data!));
      });

  // ---------- Kata sandi ----------

  Future<void> forgotPassword(String email) =>
      _call(() => _bare.post<void>('/v1/auth/password/forgot', data: {'email': email}));

  Future<void> resetPassword(String email, String code, String newPassword) => _call(() => _bare.post<void>(
        '/v1/auth/password/reset',
        data: {'email': email, 'code': code, 'newPassword': newPassword},
      ));

  // ---------- Profil ----------

  Future<void> updateProfile({String? displayName, String? city, int? avgPaceSecPerKm, bool clearPace = false}) =>
      _call(() async {
        final res = await _dio.patch<Map<String, dynamic>>('/v1/me', data: {
          'displayName': ?displayName,
          if (city != null) 'city': city.isEmpty ? null : city,
          if (avgPaceSecPerKm != null || clearPace) 'avgPaceSecPerKm': avgPaceSecPerKm,
        });
        state = AsyncData(MyProfile.fromJson(res.data!));
      });

  Future<void> uploadAvatar(String path) => _call(() async {
        final form = FormData.fromMap({'file': await MultipartFile.fromFile(path, filename: 'avatar')});
        final res = await _dio.post<Map<String, dynamic>>('/v1/me/avatar', data: form);
        state = AsyncData(MyProfile.fromJson(res.data!));
      });

  Future<void> deleteAccount({String? password}) => _call(() async {
        final id = state.value?.id;
        await _dio.post<void>('/v1/me/delete', data: {'confirm': 'HAPUS', 'password': ?password});
        // Pesan chat yang belum terkirim milik akun ini ikut dihapus dari perangkat.
        if (id != null) await ChatOutbox.clear(const SecureOutboxStore(), id).catchError((_) {});
        await _session.clear();
        state = const AsyncData(null);
      });

  Future<void> reload() async {
    state = AsyncData(await _fetchMe());
  }
}

final authControllerProvider = AsyncNotifierProvider<AuthController, MyProfile?>(AuthController.new);

/// Byte foto profil, diambil lewat Dio ber-pinning dan bertoken (bukan Image.network).
final avatarBytesProvider = FutureProvider.family<List<int>?, String>((ref, path) async {
  try {
    final res = await ref.watch(dioProvider).get<List<int>>(path, options: Options(responseType: ResponseType.bytes));
    return res.data;
  } catch (_) {
    return null;
  }
});
