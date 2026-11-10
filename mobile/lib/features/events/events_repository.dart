import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_error.dart';
import '../../core/http/api_client.dart';

/// Kategori jarak, sama dengan server (EVENT_CATEGORIES).
const eventCategories = <String, String>{
  'fun': 'Fun run',
  '5k': '5K',
  '10k': '10K',
  'hm': 'Half marathon',
  'fm': 'Marathon',
  'ultra': 'Ultra',
  'other': 'Jarak lain',
};

const _days = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const monthNames = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

/// Tanggal event (YYYY-MM-DD, waktu setempat) → "Sen, 14 Des 2026 · 05:00".
String formatEventDate(String date, String? startTime) {
  final d = DateTime.parse(date);
  final base = '${_days[d.weekday - 1]}, ${d.day} ${_months[d.month - 1]} ${d.year}';
  return startTime == null ? base : '$base · $startTime';
}

String categoryLabels(List<String> categories) => categories.map((c) => eventCategories[c] ?? c).join(' · ');

class EventSummary {
  const EventSummary({
    required this.id,
    required this.name,
    required this.date,
    required this.startTime,
    required this.city,
    required this.venue,
    required this.categories,
    required this.archived,
    required this.goingCount,
    required this.iAmGoing,
    required this.friendsGoing,
  });

  final String id;
  final String name;

  /// YYYY-MM-DD (waktu setempat penyelenggara).
  final String date;
  final String? startTime;
  final String city;
  final String venue;
  final List<String> categories;
  final bool archived;
  final int goingCount;
  final bool iAmGoing;

  /// Jumlah anggota komunitasku yang ikut.
  final int friendsGoing;

  factory EventSummary.fromJson(Map<String, dynamic> j) => EventSummary(
        id: j['id'] as String,
        name: j['name'] as String,
        date: j['date'] as String,
        startTime: j['startTime'] as String?,
        city: j['city'] as String,
        venue: j['venue'] as String? ?? '',
        categories: (j['categories'] as List<dynamic>? ?? const []).map((e) => e as String).toList(),
        archived: j['archived'] as bool? ?? false,
        goingCount: (j['goingCount'] as num?)?.toInt() ?? 0,
        iAmGoing: j['iAmGoing'] as bool? ?? false,
        friendsGoing: (j['friendsGoing'] as num?)?.toInt() ?? 0,
      );
}

class Participant {
  const Participant({required this.id, required this.displayName, required this.avatarUrl, required this.communities});
  final String id;
  final String displayName;
  final String? avatarUrl;

  /// Komunitas yang sama dengan saya (maks. 3).
  final List<String> communities;

  factory Participant.fromJson(Map<String, dynamic> j) => Participant(
        id: j['id'] as String,
        displayName: j['displayName'] as String,
        avatarUrl: j['avatarUrl'] as String?,
        communities: (j['communities'] as List<dynamic>? ?? const []).map((e) => e as String).toList(),
      );
}

class EventDetail {
  const EventDetail({required this.summary, required this.description, required this.registrationUrl, required this.friendsPreview});
  final EventSummary summary;
  final String description;
  final String registrationUrl;
  final List<Participant> friendsPreview;

  factory EventDetail.fromJson(Map<String, dynamic> j) => EventDetail(
        summary: EventSummary.fromJson(j),
        description: j['description'] as String? ?? '',
        registrationUrl: j['registrationUrl'] as String,
        friendsPreview: (j['friendsPreview'] as List<dynamic>? ?? const []).map((e) => Participant.fromJson(e as Map<String, dynamic>)).toList(),
      );
}

class EventPage {
  const EventPage(this.items, this.nextCursor);
  final List<EventSummary> items;
  final String? nextCursor;
}

/// Semua panggilan API kalender event. Galat dilempar sebagai [ApiError].
class EventsRepository {
  EventsRepository(this._dio);
  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() fn) async {
    try {
      return await fn();
    } catch (e) {
      throw ApiError.from(e);
    }
  }

  /// [month] format YYYY-MM.
  Future<EventPage> list({String? city, String? month, bool going = false, String? cursor}) => _call(() async {
        final res = await _dio.get<Map<String, dynamic>>('/v1/events', queryParameters: {
          if (city != null && city.isNotEmpty) 'city': city,
          'month': ?month,
          if (going) 'going': 'true',
          'cursor': ?cursor,
        });
        final data = res.data!;
        return EventPage(
          (data['items'] as List<dynamic>).map((e) => EventSummary.fromJson(e as Map<String, dynamic>)).toList(),
          data['nextCursor'] as String?,
        );
      });

  Future<List<String>> cities() => _call(() async {
        final res = await _dio.get<List<dynamic>>('/v1/events/cities');
        return res.data!.map((e) => (e as Map<String, dynamic>)['city'] as String).toList();
      });

  Future<EventDetail> detail(String id) => _detail(() => _dio.get<Map<String, dynamic>>('/v1/events/$id'));

  Future<EventDetail> setGoing(String id, {required bool going}) => _detail(
      () => going ? _dio.post<Map<String, dynamic>>('/v1/events/$id/going') : _dio.delete<Map<String, dynamic>>('/v1/events/$id/going'));

  Future<List<Participant>> participants(String id) => _call(() async {
        final res = await _dio.get<Map<String, dynamic>>('/v1/events/$id/participants');
        return (res.data!['items'] as List<dynamic>).map((e) => Participant.fromJson(e as Map<String, dynamic>)).toList();
      });

  Future<EventDetail> _detail(Future<Response<Map<String, dynamic>>> Function() fn) => _call(() async => EventDetail.fromJson((await fn()).data!));
}

final eventsRepositoryProvider = Provider<EventsRepository>((ref) => EventsRepository(ref.watch(dioProvider)));

final eventCitiesProvider = FutureProvider.autoDispose<List<String>>((ref) => ref.watch(eventsRepositoryProvider).cities());

final eventDetailProvider = FutureProvider.autoDispose.family<EventDetail, String>((ref, id) => ref.watch(eventsRepositoryProvider).detail(id));

final eventParticipantsProvider =
    FutureProvider.autoDispose.family<List<Participant>, String>((ref, id) => ref.watch(eventsRepositoryProvider).participants(id));
