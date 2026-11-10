import 'package:dio/dio.dart';

/// Galat dari API dengan kode mesin yang stabil (`error`) dan pesan siap tampil (`message`).
class ApiError implements Exception {
  const ApiError(this.status, this.code, this.message, {this.fields = const {}});

  final int status;
  final String code;
  final String message;

  /// Galat validasi per field (`invalid_input`), nama field → pesan.
  final Map<String, String> fields;

  factory ApiError.from(Object error) {
    if (error is ApiError) return error;
    if (error is FormatException) return ApiError(0, 'invalid_input', error.message);
    if (error is DioException) {
      final res = error.response;
      final data = res?.data;
      if (data is Map<String, dynamic>) {
        final fields = <String, String>{};
        final raw = data['fields'];
        if (raw is List) {
          for (final f in raw) {
            if (f is Map<String, dynamic>) fields[f['field'] as String? ?? ''] = f['message'] as String? ?? '';
          }
        }
        final message = data['message'];
        return ApiError(
          res?.statusCode ?? 0,
          data['error'] as String? ?? 'unknown',
          message is String ? message : (fields.values.isNotEmpty ? fields.values.first : 'Terjadi kesalahan'),
          fields: fields,
        );
      }
      if (error.type == DioExceptionType.connectionTimeout ||
          error.type == DioExceptionType.connectionError ||
          error.type == DioExceptionType.receiveTimeout) {
        return const ApiError(0, 'network', 'Tidak bisa terhubung ke server. Periksa koneksi internet');
      }
      if (error.type == DioExceptionType.badCertificate) {
        return const ApiError(0, 'bad_certificate', 'Koneksi tidak aman ditolak');
      }
      // Jawaban tanpa JSON (mis. ditolak proxy/WAF di depan API): tampilkan kode HTTP agar mudah dilacak.
      final status = res?.statusCode;
      if (status != null) {
        return ApiError(status, 'http_$status', 'Permintaan ditolak server (HTTP $status). Coba lagi nanti');
      }
    }
    return const ApiError(0, 'unknown', 'Terjadi kesalahan. Coba lagi');
  }

  @override
  String toString() => 'ApiError($status, $code)';
}
