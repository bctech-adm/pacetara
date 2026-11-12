import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_error.dart';
import '../../core/http/api_client.dart';

class ProviderStatus {
  const ProviderStatus({required this.enabled, required this.connected, required this.runs, this.connectedAt, this.lastSyncAt});
  final bool enabled;
  final bool connected;
  final int runs;
  final DateTime? connectedAt;
  final DateTime? lastSyncAt;

  factory ProviderStatus.fromJson(Map<String, dynamic>? j) => ProviderStatus(
        enabled: j?['enabled'] as bool? ?? false,
        connected: j?['connected'] as bool? ?? false,
        runs: (j?['runs'] as num?)?.toInt() ?? 0,
        connectedAt: _date(j?['connectedAt']),
        lastSyncAt: _date(j?['lastSyncAt']),
      );
}

DateTime? _date(Object? v) => v is String ? DateTime.parse(v).toLocal() : null;

class ImportStatus {
  const ImportStatus({required this.healthConnectRuns, required this.garmin, required this.strava});
  final int healthConnectRuns;
  final ProviderStatus garmin;
  final ProviderStatus strava;

  factory ImportStatus.fromJson(Map<String, dynamic> j) => ImportStatus(
        healthConnectRuns: ((j['healthConnect'] as Map<String, dynamic>?)?['runs'] as num?)?.toInt() ?? 0,
        garmin: ProviderStatus.fromJson(j['garmin'] as Map<String, dynamic>?),
        strava: ProviderStatus.fromJson(j['strava'] as Map<String, dynamic>?),
      );
}

/// Hasil impor satu sesi: imported | updated | duplicate | already_imported | skipped.
class ImportOutcome {
  const ImportOutcome(this.status, this.runId);
  final String status;
  final String? runId;
}

class ImportsRepository {
  ImportsRepository(this._dio);
  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() fn) async {
    try {
      return await fn();
    } catch (e) {
      throw ApiError.from(e);
    }
  }

  Future<ImportStatus> status() => _call(() async => ImportStatus.fromJson((await _dio.get<Map<String, dynamic>>('/v1/imports')).data!));

  /// URL otorisasi penyedia (dibuka di browser luar). `provider` = garmin | strava.
  Future<Uri> connect(String provider) => _call(() async {
        final res = await _dio.post<Map<String, dynamic>>('/v1/imports/$provider/connect');
        final url = Uri.parse(res.data!['url'] as String);
        if (url.scheme != 'https') throw const ApiError(0, 'invalid_url', 'Alamat otorisasi tidak aman');
        return url;
      });

  /// `provider` = garmin | strava | health-connect. Mengembalikan jumlah lari yang dihapus.
  Future<int> disconnect(String provider, {required bool deleteRuns}) => _call(() async {
        final res = await _dio.delete<Map<String, dynamic>>('/v1/imports/$provider', queryParameters: {'deleteRuns': '$deleteRuns'});
        return (res.data?['deletedRuns'] as num?)?.toInt() ?? 0;
      });

  Future<void> syncStrava() => _call(() => _dio.post<void>('/v1/imports/strava/sync'));

  Future<ImportOutcome> importHealthConnect(Map<String, dynamic> body) => _call(() async {
        final d = (await _dio.post<Map<String, dynamic>>('/v1/imports/health-connect', data: body)).data!;
        return ImportOutcome(d['status'] as String, d['runId'] as String?);
      });

  /// Id sesi yang sudah pernah diimpor (atau dikenali sebagai duplikat).
  Future<Set<String>> known(List<String> ids) => _call(() async {
        if (ids.isEmpty) return <String>{};
        final known = <String>{};
        for (var i = 0; i < ids.length; i += 200) {
          final chunk = ids.sublist(i, i + 200 > ids.length ? ids.length : i + 200);
          final d = (await _dio.post<Map<String, dynamic>>('/v1/imports/health-connect/check', data: {'ids': chunk})).data!;
          known.addAll((d['known'] as List<dynamic>).cast<String>());
        }
        return known;
      });
}

final importsRepositoryProvider = Provider<ImportsRepository>((ref) => ImportsRepository(ref.watch(dioProvider)));

final importStatusProvider = FutureProvider.autoDispose<ImportStatus>((ref) => ref.watch(importsRepositoryProvider).status());
