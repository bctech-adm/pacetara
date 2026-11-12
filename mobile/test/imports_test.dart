import 'package:flutter_test/flutter_test.dart';
import 'package:pacetara/features/imports/health_connect_mapping.dart';
import 'package:pacetara/features/imports/imports_repository.dart';
import 'package:pacetara/features/imports/imports_screens.dart';

void main() {
  final start = DateTime.utc(2026, 11, 10, 6, 0, 0);

  HcRunSession session({String origin = 'com.google.android.apps.fitness', List<HcRoutePoint> route = const []}) => HcRunSession(
        id: 'abc-123',
        start: start,
        end: start.add(const Duration(minutes: 30)),
        origin: origin,
        treadmill: false,
        distanceM: 5012.6,
        route: route,
      );

  test('rute menjadi detik sejak mulai, urut, titik di luar rentang dibuang', () {
    final pts = routeToPoints([
      HcRoutePoint(lat: -6.91, lng: 107.6, time: start.add(const Duration(seconds: 20)), altitude: 701.4),
      HcRoutePoint(lat: -6.9, lng: 107.6, time: start),
      HcRoutePoint(lat: -6.9, lng: 107.6, time: start.subtract(const Duration(seconds: 5))),
      HcRoutePoint(lat: 95, lng: 107.6, time: start.add(const Duration(seconds: 30))),
    ], start);
    expect(pts, [
      [-6.9, 107.6, 0, null],
      [-6.91, 107.6, 20, 701],
    ]);
  });

  test('rute dijarangkan ke batas server', () {
    final many = [for (var i = 0; i < 20000; i++) HcRoutePoint(lat: -6.9, lng: 107.6, time: start.add(Duration(seconds: i)))];
    expect(routeToPoints(many, start).length, maxRoutePoints);
  });

  test('body impor: field sesuai server; Strava selalu privat', () {
    final b = sessionToBody(session(), 'community');
    expect(b.keys.toSet(), {'externalId', 'originPackage', 'exerciseType', 'visibility', 'startedAt', 'endedAt', 'distanceM', 'route'});
    expect(b['distanceM'], 5013);
    expect(b['visibility'], 'community');
    expect(b['startedAt'], '2026-11-10T06:00:00.000Z');
    expect(sessionToBody(session(origin: stravaPackage), 'public')['visibility'], 'private');
  });

  test('validasi id dan label asal', () {
    expect(validSessionId('1b2c-3d'), isTrue);
    expect(validSessionId('../x'), isFalse);
    expect(originLabel('com.garmin.android.apps.connectmobile'), 'Garmin Connect');
    expect(originLabel('com.contoh'), 'com.contoh');
  });

  test('status impor dari JSON server', () {
    final s = ImportStatus.fromJson({
      'healthConnect': {'enabled': true, 'runs': 2},
      'garmin': {'enabled': false, 'connected': false, 'runs': 0},
      'strava': {'enabled': true, 'connected': true, 'runs': 3, 'connectedAt': '2026-11-10T00:00:00.000Z', 'lastSyncAt': null},
    });
    expect(s.healthConnectRuns, 2);
    expect(s.garmin.enabled, isFalse);
    expect(s.strava.connected, isTrue);
    expect(s.strava.connectedAt, isNotNull);
    expect(s.strava.lastSyncAt, isNull);
  });

  test('ringkasan hasil impor', () {
    expect(importSummary({'imported': 2, 'duplicate': 1}), '2 lari diimpor, 1 sudah ada (dilewati)');
    expect(importSummary({}), 'Tidak ada lari yang diimpor');
  });
}
