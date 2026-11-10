import 'package:dio/dio.dart';
import 'package:dio/io.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config.dart';
import 'pinned_security_context.dart';

final dioProvider = Provider<Dio>((ref) {
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
  // Token akses dipasang oleh interceptor di modul 1.2 (dibaca dari TokenStorage).
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

final apiHealthProvider = FutureProvider.autoDispose<ApiHealth>((ref) async {
  final res = await ref.watch(dioProvider).get<Map<String, dynamic>>('/health');
  return ApiHealth.fromJson(res.data ?? const {});
});
