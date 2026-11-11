import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pacetara/core/http/api_client.dart';
import 'package:pacetara/features/notifications/notifications_repository.dart';
import 'package:pacetara/features/passport/passport_repository.dart';
import 'package:pacetara/features/passport/passport_screens.dart';

Map<String, dynamic> statsJson({bool full = false, String period = 'week'}) => {
      'period': period,
      'timezone': 'Asia/Jakarta',
      'weekStartsOn': 'monday',
      'full': full,
      'historyLimit': {'days': full ? null : 90},
      'buckets': [
        {'start': '2026-10-26', 'runs': 0, 'distanceM': 0, 'movingTimeS': 0, 'avgPaceSPerKm': null},
        {'start': '2026-11-02', 'runs': 2, 'distanceM': 8000, 'movingTimeS': 2880, 'avgPaceSPerKm': 360},
        {'start': '2026-11-09', 'runs': 1, 'distanceM': 5000, 'movingTimeS': 1650, 'avgPaceSPerKm': 330},
      ],
      'totals': {'runs': 3, 'distanceM': 13000, 'movingTimeS': 4530, 'avgPaceSPerKm': 348, 'longestRunM': 5000},
      'records': full
          ? {
              '5k': {'runId': 'r1', 'startedAt': '2026-11-10T00:00:00.000Z', 'timeS': 1650, 'avgPaceSPerKm': 330},
              '10k': null,
              'hm': null,
              'fm': null,
            }
          : null,
    };

final passportJson = {
  'userId': 'me',
  'isMe': true,
  'visibility': 'community',
  'medalLimit': {'limit': 5, 'used': 5, 'reached': true},
  'medals': [
    {'id': 'm1', 'title': 'Jakarta Marathon', 'eventId': null, 'eventDate': '2026-10-26', 'category': 'fm', 'photoUrl': '/v1/passport/medals/m1/photo', 'createdAt': '2026-11-01T00:00:00.000Z'},
  ],
  'results': [
    {'id': 'x1', 'eventId': 'e1', 'eventName': 'Bandung Half Marathon', 'eventDate': '2026-11-01', 'category': 'hm', 'distanceM': 21097, 'officialTimeS': 7200, 'avgPaceSPerKm': 341},
  ],
  'badges': {
    'items': [
      {'code': 'first_run', 'group': 'distance', 'title': 'Lari pertama', 'description': 'd', 'earned': true, 'earnedAt': '2026-11-01T00:00:00.000Z', 'privateOnly': false},
      {'code': 'first_hm', 'group': 'distance', 'title': 'Half marathon pertama', 'description': 'd', 'earned': true, 'earnedAt': '2026-11-02T00:00:00.000Z', 'privateOnly': true},
      {'code': 'total_50', 'group': 'total', 'title': '50 km', 'description': 'd', 'earned': false, 'earnedAt': null, 'privateOnly': false},
    ],
    'currentStreakWeeks': 3,
  },
};

Dio fakeDio(List<RequestOptions> seen) => Dio()
  ..interceptors.add(InterceptorsWrapper(onRequest: (o, h) {
    seen.add(o);
    final Object? data = switch (o.path) {
      '/v1/runs/mine/stats' => statsJson(period: o.queryParameters['period'] as String),
      '/v1/passport/me' => passportJson,
      _ => null,
    };
    if (data == null) return h.reject(DioException(requestOptions: o, response: Response(requestOptions: o, statusCode: 404)));
    h.resolve(Response(requestOptions: o, statusCode: 200, data: data));
  }));

Widget host(List<RequestOptions> seen, Widget child) => ProviderScope(
      overrides: [dioProvider.overrideWithValue(fakeDio(seen))],
      child: MaterialApp(home: child),
    );

void main() {
  test('model statistik dan paspor', () {
    final free = RunStats.fromJson(statsJson());
    expect(free.full, isFalse);
    expect(free.records, isNull);
    expect(free.buckets[1].distanceM, 8000);
    final full = RunStats.fromJson(statsJson(full: true));
    expect(full.records!['5k']!.timeS, 1650);
    expect(full.records!['10k'], isNull);

    final p = Passport.fromJson(passportJson);
    expect(p.canAddMedal, isFalse);
    expect(p.badges.where((b) => b.earned), hasLength(2));
    expect(p.badges[1].privateOnly, isTrue);
    expect(p.streakWeeks, 3);
    expect(bucketLabel('month', DateTime(2026, 11)), 'Nov');
  });

  test('format catatan waktu', () {
    expect(parseDuration('1:58:30'), 7110);
    expect(parseDuration('25:10'), 1510);
    expect(parseDuration('1:75:00'), isNull);
    expect(parseDuration('abc'), isNull);
    expect(parseDuration('0:00'), isNull);
  });

  test('notifikasi lencana', () {
    expect(routeForPush({'type': 'badge_earned'}), '/passport');
    expect(notificationCategories.keys, contains('achievement'));
  });

  testWidgets('kartu statistik: grafik dan total, ganti ke bulanan', (tester) async {
    final seen = <RequestOptions>[];
    await tester.pumpWidget(host(seen, const Scaffold(body: SingleChildScrollView(child: RunStatsCard()))));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('stats-chart')), findsOneWidget);
    expect(find.text('13.00'), findsOneWidget);
    expect(find.text('Total 90 hari terakhir'), findsOneWidget);
    await tester.tap(find.text('Bulanan'));
    await tester.pumpAndSettle();
    expect(seen.last.queryParameters['period'], 'month');
  });

  testWidgets('paspor sendiri: lencana, medali, dan hasil', (tester) async {
    final seen = <RequestOptions>[];
    await tester.pumpWidget(host(seen, const PassportScreen()));
    await tester.pumpAndSettle();
    expect(find.text('Lencana (2/3)'), findsOneWidget);
    expect(find.text('Rak medali (5/5)'), findsOneWidget);
    expect(find.text('Jakarta Marathon'), findsOneWidget);
    expect(find.text('Konsisten 3 minggu berturut-turut'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('Bandung Half Marathon'), 300, scrollable: find.byType(Scrollable).first);
    expect(find.text('Bandung Half Marathon'), findsOneWidget);
    expect(find.text('2:00:00'), findsOneWidget);
  });
}
