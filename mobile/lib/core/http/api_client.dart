import 'package:dio/dio.dart';
import 'package:dio/io.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config.dart';
import '../session/session_manager.dart';
import 'pinned_security_context.dart';

Dio _baseDio(Ref ref) {
  final ctx = ref.watch(securityContextProvider);
  final dio = Dio(
    BaseOptions(
      baseUrl: AppConfig.apiBaseUrl,
      connectTimeout: const Duration(seconds: 10),
      receiveTimeout: const Duration(seconds: 20),
      headers: {'Accept': 'application/json'},
    ),
  );
  dio.httpClientAdapter = IOHttpClientAdapter(createHttpClient: () => createPinnedHttpClient(ctx));
  return dio;
}

/// Dio tanpa token, untuk endpoint publik dan refresh.
final bareDioProvider = Provider<Dio>(_baseDio);

/// Dio dengan token akses otomatis. Jika token akses kedaluwarsa, sesi diperpanjang sekali lalu
/// permintaan diulang. Semua koneksi memakai certificate pinning.
final dioProvider = Provider<Dio>((ref) {
  final dio = _baseDio(ref);
  final session = ref.watch(sessionManagerProvider);
  final bare = ref.watch(bareDioProvider);

  dio.interceptors.add(
    QueuedInterceptorsWrapper(
      onRequest: (options, handler) {
        final token = session.accessToken;
        if (token != null) options.headers['Authorization'] = 'Bearer $token';
        handler.next(options);
      },
      onError: (error, handler) async {
        final res = error.response;
        final data = res?.data;
        final code = data is Map<String, dynamic> ? data['error'] : null;
        final alreadyRetried = error.requestOptions.extra['retried'] == true;

        if (res?.statusCode == 401 && code == 'invalid_access_token' && !alreadyRetried && session.hasSession) {
          if (await session.refresh(bare)) {
            final opts = error.requestOptions
              ..extra['retried'] = true
              ..headers['Authorization'] = 'Bearer ${session.accessToken}';
            try {
              return handler.resolve(await dio.fetch<dynamic>(opts));
            } on DioException catch (e) {
              return handler.next(e);
            }
          }
        } else if (res?.statusCode == 401 && (code == 'session_revoked' || code == 'token_reused')) {
          await session.clear();
          session.notifyExpired();
        }
        handler.next(error);
      },
    ),
  );
  return dio;
});

class ApiHealth {
  const ApiHealth({required this.status, required this.database, required this.redis});
  final String status;
  final String database;
  final String redis;

  factory ApiHealth.fromJson(Map<String, dynamic> json) => ApiHealth(
        status: json['status'] as String? ?? 'unknown',
        database: json['database'] as String? ?? 'unknown',
        redis: json['redis'] as String? ?? 'unknown',
      );
}
