import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_error.dart';
import '../../core/http/api_client.dart';
import 'models.dart';

/// Panggilan API modul 2.6. Lokasi (area cari teman, check-in GPS, area peta spot) selalu di body, bukan URL.
class CommunityPlusRepository {
  CommunityPlusRepository(this._dio);
  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() fn) async {
    try {
      return await fn();
    } catch (e) {
      throw ApiError.from(e);
    }
  }

  Future<Map<String, dynamic>> _get(String path, [Map<String, dynamic>? query]) =>
      _call(() async => (await _dio.get<Map<String, dynamic>>(path, queryParameters: query)).data!);
  Future<Map<String, dynamic>> _post(String path, [Object? data]) =>
      _call(() async => (await _dio.post<Map<String, dynamic>>(path, data: data)).data ?? const {});

  // ---------- Jadwal + sesi ----------

  Future<List<RunSchedule>> schedules(String communityId) async =>
      [for (final e in (await _get('/v1/communities/$communityId/schedules'))['items'] as List<dynamic>) RunSchedule.fromJson(e as Map<String, dynamic>)];

  Future<void> createSchedule(String communityId, Map<String, dynamic> body) => _post('/v1/communities/$communityId/schedules', body);
  Future<void> deleteSchedule(String communityId, String id) => _call(() => _dio.delete<void>('/v1/communities/$communityId/schedules/$id'));

  Future<({List<RunSession> items, bool attendanceEnabled})> sessions(String communityId, {bool past = false}) async {
    final j = await _get('/v1/communities/$communityId/sessions', {'scope': past ? 'past' : 'upcoming'});
    return (
      items: [for (final e in j['items'] as List<dynamic>) RunSession.fromJson(e as Map<String, dynamic>)],
      attendanceEnabled: j['attendanceEnabled'] as bool? ?? false,
    );
  }

  Future<void> createSession(String communityId, Map<String, dynamic> body) => _post('/v1/communities/$communityId/sessions', body);
  Future<RunSession> session(String id) async => RunSession.fromJson(await _get('/v1/sessions/$id'));
  Future<RunSession> rsvp(String id, bool going) async => RunSession.fromJson(await _post('/v1/sessions/$id/rsvp', {'going': going}));
  Future<void> cancelSession(String id) => _post('/v1/sessions/$id/cancel');

  Future<({String token, int refreshAfterS})> qr(String sessionId) async {
    final j = await _get('/v1/sessions/$sessionId/qr');
    return (token: j['token'] as String, refreshAfterS: (j['refreshAfterS'] as num?)?.toInt() ?? 30);
  }

  Future<bool> checkInQr(String sessionId, String token) async => (await _post('/v1/sessions/$sessionId/check-in/qr', {'token': token}))['alreadyCheckedIn'] == true;

  /// Posisi hanya dikirim untuk dibandingkan dengan titik kumpul; server tidak menyimpannya.
  Future<void> checkInGps(String sessionId, {required double lat, required double lng, required double accuracyM, required bool mocked}) =>
      _post('/v1/sessions/$sessionId/check-in/gps', {'lat': lat, 'lng': lng, 'accuracyM': accuracyM, 'mocked': mocked});

  Future<({int present, List<AttendanceRow> members})> attendance(String sessionId) async {
    final j = await _get('/v1/sessions/$sessionId/attendance');
    return (
      present: (j['present'] as num).toInt(),
      members: [for (final m in j['members'] as List<dynamic>) AttendanceRow.fromJson(m as Map<String, dynamic>)],
    );
  }

  Future<void> markAttendance(String sessionId, String userId, bool present) => _post('/v1/sessions/$sessionId/attendance/$userId', {'present': present});

  // ---------- Liga + statistik ----------

  Future<League> league({String? month, String? city}) async => League.fromJson(await _get('/v1/league', {'month': ?month, 'city': ?city}));

  Future<List<StatsPoint>> stats(String communityId, {String period = 'week'}) async {
    final j = await _get('/v1/communities/$communityId/stats', {'period': period, 'count': period == 'week' ? 12 : 6});
    return [for (final p in j['series'] as List<dynamic>) StatsPoint.fromJson(p as Map<String, dynamic>)];
  }

  // ---------- Cari teman ----------

  Future<({BuddyProfile? profile, bool filters})> buddyProfile() async {
    final j = await _get('/v1/buddies/profile');
    final p = j['profile'];
    return (profile: p is Map<String, dynamic> ? BuddyProfile.fromJson(p) : null, filters: j['filters'] as bool? ?? false);
  }

  Future<void> saveBuddyProfile(Map<String, dynamic> body) => _call(() => _dio.put<void>('/v1/buddies/profile', data: body));
  Future<void> deleteBuddyProfile() => _call(() => _dio.delete<void>('/v1/buddies/profile'));

  Future<List<BuddyResult>> searchBuddies(Map<String, dynamic> filters) async =>
      [for (final e in (await _post('/v1/buddies/search', filters))['items'] as List<dynamic>) BuddyResult.fromJson(e as Map<String, dynamic>)];

  Future<({List<BuddyResult> incoming, List<BuddyResult> outgoing, List<BuddyResult> connected})> buddyRequests() async {
    final j = await _get('/v1/buddies/requests');
    List<BuddyResult> list(String k) => [for (final e in j[k] as List<dynamic>) BuddyResult.fromJson(e as Map<String, dynamic>)];
    return (incoming: list('incoming'), outgoing: list('outgoing'), connected: list('connected'));
  }

  Future<void> greet(String userId) => _post('/v1/buddies/requests', {'userId': userId});
  Future<void> respondBuddy(String requestId, bool accept) => _post('/v1/buddies/requests/$requestId/${accept ? 'accept' : 'decline'}');
  /// Blokir feed (modul 2.1); server juga memutus sapaan/teman lari.
  Future<void> blockUser(String userId) => _call(() => _dio.post<void>('/v1/feed/users/$userId/block'));
  Future<void> disconnectBuddy(String userId) => _call(() => _dio.delete<void>('/v1/buddies/connections/$userId'));

  // ---------- Kas + jersey ----------

  Future<CashBook> cash(String communityId) async => CashBook.fromJson(await _get('/v1/communities/$communityId/cash'));
  Future<void> addCash(String communityId, Map<String, dynamic> body) => _post('/v1/communities/$communityId/cash', body);
  Future<void> deleteCash(String communityId, String id) => _call(() => _dio.delete<void>('/v1/communities/$communityId/cash/$id'));

  Future<JerseyBoard> jersey(String communityId) async => JerseyBoard.fromJson(await _get('/v1/communities/$communityId/jersey'));
  Future<void> createJersey(String communityId, Map<String, dynamic> body) => _post('/v1/communities/$communityId/jersey', body);
  Future<void> closeJersey(String itemId) => _call(() => _dio.patch<void>('/v1/jersey/items/$itemId', data: {'closed': true}));
  Future<void> orderJersey(String itemId, String size, int quantity, String note) =>
      _post('/v1/jersey/items/$itemId/orders', {'size': size, 'quantity': quantity, if (note.isNotEmpty) 'note': note});
  Future<void> cancelOrder(String orderId) => _call(() => _dio.delete<void>('/v1/jersey/orders/$orderId'));

  Future<List<JerseyOrder>> jerseyOrders(String itemId) async =>
      [for (final o in (await _get('/v1/jersey/items/$itemId/orders'))['orders'] as List<dynamic>) JerseyOrder.fromJson(o as Map<String, dynamic>)];
  Future<void> markPaid(String orderId, bool paid) => _post('/v1/jersey/orders/$orderId/paid', {'paid': paid});

  // ---------- Spot ----------

  Future<List<RunSpot>> spotsInBox({required double minLat, required double minLng, required double maxLat, required double maxLng}) async => [
        for (final e in (await _post('/v1/spots/query', {
          'bbox': {'minLat': minLat, 'minLng': minLng, 'maxLat': maxLat, 'maxLng': maxLng},
        }))['items'] as List<dynamic>)
          RunSpot.fromJson(e as Map<String, dynamic>),
      ];

  Future<void> submitSpot(Map<String, dynamic> body) => _post('/v1/spots', body);
  Future<List<RunSpot>> mySpots() async => [for (final e in (await _get('/v1/spots/mine'))['items'] as List<dynamic>) RunSpot.fromJson(e as Map<String, dynamic>)];
}

final communityPlusRepositoryProvider = Provider<CommunityPlusRepository>((ref) => CommunityPlusRepository(ref.watch(dioProvider)));

final sessionsProvider = FutureProvider.autoDispose.family<({List<RunSession> items, bool attendanceEnabled}), String>(
  (ref, communityId) => ref.watch(communityPlusRepositoryProvider).sessions(communityId),
);
final schedulesProvider =
    FutureProvider.autoDispose.family<List<RunSchedule>, String>((ref, communityId) => ref.watch(communityPlusRepositoryProvider).schedules(communityId));
final sessionProvider = FutureProvider.autoDispose.family<RunSession, String>((ref, id) => ref.watch(communityPlusRepositoryProvider).session(id));
final cashProvider = FutureProvider.autoDispose.family<CashBook, String>((ref, id) => ref.watch(communityPlusRepositoryProvider).cash(id));
final jerseyProvider = FutureProvider.autoDispose.family<JerseyBoard, String>((ref, id) => ref.watch(communityPlusRepositoryProvider).jersey(id));
final buddyProfileProvider = FutureProvider.autoDispose<({BuddyProfile? profile, bool filters})>((ref) => ref.watch(communityPlusRepositoryProvider).buddyProfile());
final buddyRequestsProvider = FutureProvider.autoDispose((ref) => ref.watch(communityPlusRepositoryProvider).buddyRequests());
