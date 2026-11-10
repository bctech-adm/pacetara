import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:latlong2/latlong.dart';

import '../../core/api/api_error.dart';
import '../../core/http/api_client.dart';

/// Satu pelari di daftar "sedang lari" sebuah komunitas.
class LiveRunner {
  const LiveRunner({
    required this.userId,
    required this.displayName,
    required this.avatarUrl,
    required this.isMe,
    required this.startedAt,
    required this.updatedAt,
    required this.distanceM,
    required this.movingTimeS,
    required this.paused,
    required this.position,
    required this.positionHidden,
  });

  final String userId;
  final String displayName;
  final String? avatarUrl;
  final bool isMe;
  final DateTime startedAt;
  final DateTime updatedAt;
  final double distanceM;
  final int movingTimeS;
  final bool paused;
  final LatLng? position;

  /// Pelari membagikan posisi, tetapi sedang di zona privasi (dekat titik mulai).
  final bool positionHidden;

  factory LiveRunner.fromJson(Map<String, dynamic> j) {
    final p = j['position'] as Map<String, dynamic>?;
    return LiveRunner(
      userId: j['userId'] as String,
      displayName: j['displayName'] as String,
      avatarUrl: j['avatarUrl'] as String?,
      isMe: j['isMe'] as bool? ?? false,
      startedAt: DateTime.parse(j['startedAt'] as String),
      updatedAt: DateTime.parse(j['updatedAt'] as String),
      distanceM: (j['distanceM'] as num).toDouble(),
      movingTimeS: (j['movingTimeS'] as num).toInt(),
      paused: j['paused'] as bool? ?? false,
      position: p == null ? null : LatLng((p['lat'] as num).toDouble(), (p['lng'] as num).toDouble()),
      positionHidden: j['positionHidden'] as bool? ?? false,
    );
  }

  /// Durasi berjalan diperkirakan di HP antara dua pembaruan (tiap ±10 detik), agar terus berdetak.
  int durationAt(DateTime now) {
    if (paused) return movingTimeS;
    final extra = now.difference(updatedAt).inSeconds.clamp(0, 60);
    return movingTimeS + extra;
  }

  /// Pembaruan terakhir sudah lama (sinyal pelari hilang atau aplikasinya dimatikan sistem).
  bool isStale(DateTime now) => now.difference(updatedAt).inSeconds > 45;
}

/// Pilihan berbagi untuk satu komunitas.
class LiveShare {
  const LiveShare({required this.communityId, required this.showLocation});
  final String communityId;
  final bool showLocation;
  Map<String, Object> toJson() => {'id': communityId, 'showLocation': showLocation};
}

class LiveUpdate {
  const LiveUpdate({
    required this.clientRunId,
    required this.shares,
    required this.startedAt,
    required this.distanceM,
    required this.movingTimeS,
    required this.paused,
    this.position,
    this.origin,
  });

  final String clientRunId;
  final List<LiveShare> shares;
  final DateTime startedAt;
  final double distanceM;
  final int movingTimeS;
  final bool paused;
  final LatLng? position;
  final LatLng? origin;

  bool get sharesLocation => shares.any((s) => s.showLocation);

  /// Posisi dan titik awal hanya dikirim jika minimal satu komunitas boleh melihat posisi.
  Map<String, Object?> toJson() => {
        'clientRunId': clientRunId,
        'communities': [for (final s in shares) s.toJson()],
        'startedAt': startedAt.toUtc().toIso8601String(),
        'distanceM': double.parse(distanceM.toStringAsFixed(1)),
        'movingTimeS': movingTimeS,
        'paused': paused,
        if (sharesLocation && position != null) 'position': _ll(position!),
        if (sharesLocation && origin != null) 'origin': _ll(origin!),
      };

  static Map<String, double> _ll(LatLng p) => {'lat': p.latitude, 'lng': p.longitude};
}

/// API status lari. Abstrak agar bisa dipalsukan di tes.
abstract class LiveApi {
  Future<void> update(LiveUpdate u);
  Future<void> end(String clientRunId);
  Future<List<LiveRunner>> community(String communityId);
}

class LiveRepository implements LiveApi {
  LiveRepository(this._dio);
  final Dio _dio;

  @override
  Future<void> update(LiveUpdate u) => _call(() => _dio.put<dynamic>('/v1/live', data: u.toJson()));

  @override
  Future<void> end(String clientRunId) => _call(() => _dio.delete<dynamic>('/v1/live', data: {'clientRunId': clientRunId}));

  @override
  Future<List<LiveRunner>> community(String communityId) => _call(() async {
        final res = await _dio.get<Map<String, dynamic>>('/v1/communities/$communityId/live');
        return (res.data!['items'] as List<dynamic>).map((e) => LiveRunner.fromJson(e as Map<String, dynamic>)).toList();
      });

  Future<T> _call<T>(Future<T> Function() fn) async {
    try {
      return await fn();
    } catch (e) {
      throw ApiError.from(e);
    }
  }
}

final liveApiProvider = Provider<LiveApi>((ref) => LiveRepository(ref.watch(dioProvider)));
