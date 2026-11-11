import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_error.dart';
import '../../core/http/api_client.dart';

/// Kategori jarak event, sama dengan server.
const eventCategories = <String, String>{
  '5k': '5K',
  '10k': '10K',
  'hm': 'Half marathon',
  'fm': 'Marathon',
  'ultra': 'Ultra',
  'fun': 'Fun run',
  'other': 'Lainnya',
};

String categoryText(String? c) => c == null ? '' : (eventCategories[c] ?? c);

/// Satu periode statistik (minggu/bulan/tahun, dihitung server dalam WIB).
class StatsBucket {
  const StatsBucket({required this.start, required this.runs, required this.distanceM, required this.movingTimeS, required this.avgPaceSPerKm});
  final DateTime start;
  final int runs;
  final int distanceM;
  final int movingTimeS;
  final int? avgPaceSPerKm;

  factory StatsBucket.fromJson(Map<String, dynamic> j) => StatsBucket(
        start: DateTime.parse(j['start'] as String),
        runs: (j['runs'] as num).toInt(),
        distanceM: (j['distanceM'] as num).toInt(),
        movingTimeS: (j['movingTimeS'] as num).toInt(),
        avgPaceSPerKm: (j['avgPaceSPerKm'] as num?)?.toInt(),
      );
}

class PersonalRecord {
  const PersonalRecord({required this.runId, required this.timeS, required this.avgPaceSPerKm});
  final String runId;
  final int timeS;
  final int avgPaceSPerKm;
}

class RunStats {
  const RunStats({
    required this.period,
    required this.full,
    required this.historyDays,
    required this.buckets,
    required this.totalRuns,
    required this.totalDistanceM,
    required this.totalMovingTimeS,
    required this.totalAvgPace,
    required this.longestRunM,
    required this.records,
  });
  final String period;

  /// true = statistik lengkap (Premium).
  final bool full;
  final int? historyDays;
  final List<StatsBucket> buckets;
  final int totalRuns;
  final int totalDistanceM;
  final int totalMovingTimeS;
  final int? totalAvgPace;
  final int longestRunM;

  /// Null untuk paket gratis. Kunci: 5k, 10k, hm, fm.
  final Map<String, PersonalRecord?>? records;

  factory RunStats.fromJson(Map<String, dynamic> j) {
    final t = j['totals'] as Map<String, dynamic>;
    final rec = j['records'] as Map<String, dynamic>?;
    return RunStats(
      period: j['period'] as String,
      full: j['full'] as bool? ?? false,
      historyDays: ((j['historyLimit'] as Map<String, dynamic>?)?['days'] as num?)?.toInt(),
      buckets: (j['buckets'] as List<dynamic>).map((e) => StatsBucket.fromJson(e as Map<String, dynamic>)).toList(),
      totalRuns: (t['runs'] as num).toInt(),
      totalDistanceM: (t['distanceM'] as num).toInt(),
      totalMovingTimeS: (t['movingTimeS'] as num).toInt(),
      totalAvgPace: (t['avgPaceSPerKm'] as num?)?.toInt(),
      longestRunM: (t['longestRunM'] as num?)?.toInt() ?? 0,
      records: rec?.map((k, v) {
        final m = v as Map<String, dynamic>?;
        return MapEntry(
          k,
          m == null
              ? null
              : PersonalRecord(runId: m['runId'] as String, timeS: (m['timeS'] as num).toInt(), avgPaceSPerKm: (m['avgPaceSPerKm'] as num).toInt()),
        );
      }),
    );
  }
}

class Medal {
  const Medal({required this.id, required this.title, required this.eventDate, required this.category, required this.photoUrl});
  final String id;
  final String title;
  final String? eventDate;
  final String? category;
  final String photoUrl;

  factory Medal.fromJson(Map<String, dynamic> j) => Medal(
        id: j['id'] as String,
        title: j['title'] as String,
        eventDate: j['eventDate'] as String?,
        category: j['category'] as String?,
        photoUrl: j['photoUrl'] as String,
      );
}

class RaceResult {
  const RaceResult({
    required this.id,
    required this.eventId,
    required this.eventName,
    required this.eventDate,
    required this.category,
    required this.distanceM,
    required this.officialTimeS,
    required this.avgPaceSPerKm,
  });
  final String id;
  final String? eventId;
  final String eventName;
  final String eventDate;
  final String category;
  final int? distanceM;
  final int officialTimeS;
  final int? avgPaceSPerKm;

  factory RaceResult.fromJson(Map<String, dynamic> j) => RaceResult(
        id: j['id'] as String,
        eventId: j['eventId'] as String?,
        eventName: j['eventName'] as String,
        eventDate: j['eventDate'] as String,
        category: j['category'] as String,
        distanceM: (j['distanceM'] as num?)?.toInt(),
        officialTimeS: (j['officialTimeS'] as num).toInt(),
        avgPaceSPerKm: (j['avgPaceSPerKm'] as num?)?.toInt(),
      );
}

class AchievementBadge {
  const AchievementBadge({required this.code, required this.group, required this.title, required this.description, required this.earnedAt, required this.privateOnly});
  final String code;

  /// distance, total, streak.
  final String group;
  final String title;
  final String description;
  final DateTime? earnedAt;

  /// Hanya tercapai berkat lari impor Strava: tidak terlihat oleh orang lain.
  final bool privateOnly;

  bool get earned => earnedAt != null;

  factory AchievementBadge.fromJson(Map<String, dynamic> j) => AchievementBadge(
        code: j['code'] as String,
        group: j['group'] as String,
        title: j['title'] as String,
        description: j['description'] as String,
        earnedAt: j['earnedAt'] == null ? null : DateTime.parse(j['earnedAt'] as String).toLocal(),
        privateOnly: j['privateOnly'] as bool? ?? false,
      );
}

class Passport {
  const Passport({
    required this.userId,
    required this.isMe,
    required this.displayName,
    required this.visibility,
    required this.medalLimit,
    required this.medalsUsed,
    required this.medals,
    required this.results,
    required this.badges,
    required this.streakWeeks,
  });
  final String userId;
  final bool isMe;
  final String? displayName;

  /// Hanya untuk pemilik: community / private.
  final String? visibility;

  /// Null = tanpa batas (Premium) atau bukan paspor sendiri.
  final int? medalLimit;
  final int medalsUsed;
  final List<Medal> medals;
  final List<RaceResult> results;
  final List<AchievementBadge> badges;
  final int streakWeeks;

  bool get canAddMedal => medalLimit == null || medalsUsed < medalLimit!;

  factory Passport.fromJson(Map<String, dynamic> j) {
    final limit = j['medalLimit'] as Map<String, dynamic>?;
    final badges = j['badges'] as Map<String, dynamic>? ?? const {};
    final medals = (j['medals'] as List<dynamic>).map((e) => Medal.fromJson(e as Map<String, dynamic>)).toList();
    return Passport(
      userId: j['userId'] as String,
      isMe: j['isMe'] as bool? ?? false,
      displayName: j['displayName'] as String?,
      visibility: j['visibility'] as String?,
      medalLimit: (limit?['limit'] as num?)?.toInt(),
      medalsUsed: (limit?['used'] as num?)?.toInt() ?? medals.length,
      medals: medals,
      results: (j['results'] as List<dynamic>).map((e) => RaceResult.fromJson(e as Map<String, dynamic>)).toList(),
      badges: (badges['items'] as List<dynamic>? ?? const []).map((e) => AchievementBadge.fromJson(e as Map<String, dynamic>)).toList(),
      streakWeeks: (badges['currentStreakWeeks'] as num?)?.toInt() ?? 0,
    );
  }
}

class JoinedEvent {
  const JoinedEvent({required this.id, required this.name, required this.eventDate, required this.categories, required this.hasResult});
  final String id;
  final String name;
  final String eventDate;
  final List<String> categories;
  final bool hasResult;

  factory JoinedEvent.fromJson(Map<String, dynamic> j) => JoinedEvent(
        id: j['id'] as String,
        name: j['name'] as String,
        eventDate: j['eventDate'] as String,
        categories: (j['categories'] as List<dynamic>).cast<String>(),
        hasResult: j['hasResult'] as bool? ?? false,
      );
}

class PassportRepository {
  PassportRepository(this._dio);
  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() fn) async {
    try {
      return await fn();
    } catch (e) {
      throw ApiError.from(e);
    }
  }

  Future<RunStats> stats(String period) => _call(() async =>
      RunStats.fromJson((await _dio.get<Map<String, dynamic>>('/v1/runs/mine/stats', queryParameters: {'period': period})).data!));

  Future<Passport> passport(String? userId) => _call(() async =>
      Passport.fromJson((await _dio.get<Map<String, dynamic>>(userId == null ? '/v1/passport/me' : '/v1/passport/users/$userId')).data!));

  Future<void> setVisibility(String visibility) => _call(() => _dio.put<void>('/v1/passport/settings', data: {'visibility': visibility}));

  /// Foto dikirim multipart; keterangan di field `data` (JSON), tidak di URL.
  Future<Medal> addMedal({required String title, required String photoPath, String? eventId, String? eventDate, String? category}) => _call(() async {
        final data = {'title': title.trim(), 'eventId': ?eventId, 'eventDate': ?eventDate, 'category': ?category};
        final form = FormData.fromMap({'data': jsonEncode(data), 'photo': await MultipartFile.fromFile(photoPath, filename: 'medal')});
        return Medal.fromJson((await _dio.post<Map<String, dynamic>>('/v1/passport/medals', data: form)).data!);
      });

  Future<void> deleteMedal(String id) => _call(() => _dio.delete<void>('/v1/passport/medals/$id'));

  Future<RaceResult> addResult(Map<String, dynamic> body) =>
      _call(() async => RaceResult.fromJson((await _dio.post<Map<String, dynamic>>('/v1/passport/results', data: body)).data!));

  Future<void> deleteResult(String id) => _call(() => _dio.delete<void>('/v1/passport/results/$id'));

  Future<List<JoinedEvent>> joinedEvents() => _call(() async {
        final res = await _dio.get<Map<String, dynamic>>('/v1/passport/events');
        return (res.data!['items'] as List<dynamic>).map((e) => JoinedEvent.fromJson(e as Map<String, dynamic>)).toList();
      });
}

final passportRepositoryProvider = Provider<PassportRepository>((ref) => PassportRepository(ref.watch(dioProvider)));

/// null = paspor sendiri.
final passportProvider = FutureProvider.autoDispose.family<Passport, String?>((ref, id) => ref.watch(passportRepositoryProvider).passport(id));

final runStatsProvider = FutureProvider.autoDispose.family<RunStats, String>((ref, period) => ref.watch(passportRepositoryProvider).stats(period));

final joinedEventsProvider = FutureProvider.autoDispose<List<JoinedEvent>>((ref) => ref.watch(passportRepositoryProvider).joinedEvents());

/// Parsing "j:mm:ss" / "mm:ss" menjadi detik. Null jika tidak valid.
int? parseDuration(String raw) {
  final parts = raw.trim().split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  final nums = parts.map(int.tryParse).toList();
  if (nums.any((n) => n == null || n < 0)) return null;
  final n = nums.cast<int>();
  if (n.length == 3 && (n[1] > 59 || n[2] > 59)) return null;
  if (n.length == 2 && n[1] > 59) return null;
  final s = n.length == 3 ? n[0] * 3600 + n[1] * 60 + n[2] : n[0] * 60 + n[1];
  return s > 0 ? s : null;
}
