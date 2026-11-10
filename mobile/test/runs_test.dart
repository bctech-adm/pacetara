import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pacetara/features/runs/recorder.dart';
import 'package:pacetara/features/runs/runs_repository.dart';
import 'package:pacetara/features/runs/screens/save_run_screen.dart';
import 'package:pacetara/features/runs/track.dart';

const _degPerM = 1 / 111195;

/// Rute lurus ke utara: titik tiap [step] meter, pace [pace] detik/km.
List<GpsFix> straight(DateTime start, {double meters = 5000, double step = 10, double pace = 360, double lat0 = -6.9}) => [
      for (var d = 0.0; d <= meters; d += step)
        GpsFix(lat: lat0 + d * _degPerM, lng: 107.6, time: start.add(Duration(milliseconds: (d / 1000 * pace * 1000).round())), altitude: 700),
    ];

class MemoryDrafts implements DraftStore {
  Map<String, dynamic>? saved;
  int saves = 0;
  @override
  Future<void> save(RecorderState s) async {
    saves++;
    final t = s.track!;
    saved = {
      'clientRunId': s.clientRunId,
      'startedAt': t.startedAt.toUtc().toIso8601String(),
      'activeSeconds': s.activeSeconds,
      'segments': t.segmentsJson(),
      'finished': s.status == RecorderStatus.finished,
      'endedAt': s.endedAt?.toUtc().toIso8601String(),
    };
  }

  @override
  Future<Map<String, dynamic>?> load() async => saved;
  @override
  Future<void> clear() async => saved = null;
}

void main() {
  final start = DateTime.utc(2026, 11, 10, 6);

  group('Track', () {
    test('lari 5 km terhitung 5 km dengan pace 6:00/km', () {
      final t = Track(startedAt: start);
      for (final f in straight(start)) {
        t.add(f);
      }
      expect(t.distanceM, closeTo(5000, 10));
      expect(t.movingSeconds, closeTo(1800, 1));
      expect(t.avgPaceSPerKm, closeTo(360, 2));
      expect(formatPaceS(t.avgPaceSPerKm), '6:00');
      expect(t.currentPaceSPerKm, closeTo(360, 5));
    });

    test('titik dengan akurasi buruk dan lompatan GPS diabaikan', () {
      final t = Track(startedAt: start);
      final pts = straight(start, meters: 1000);
      for (var i = 0; i < pts.length; i++) {
        t.add(pts[i]);
        if (i == 30) {
          expect(t.add(GpsFix(lat: -6.0, lng: 107.6, time: pts[i].time.add(const Duration(seconds: 1)))), isFalse); // lompat ~100 km
          expect(t.add(GpsFix(lat: pts[i].lat, lng: pts[i].lng, time: pts[i].time.add(const Duration(seconds: 1)), accuracy: 80)), isFalse);
        }
      }
      expect(t.distanceM, closeTo(1000, 5));
    });

    test('jeda: jarak antar-segmen tidak dihitung', () {
      final t = Track(startedAt: start);
      for (final f in straight(start, meters: 1000)) {
        t.add(f);
      }
      t.newSegment();
      final later = start.add(const Duration(hours: 1));
      for (final f in straight(later, meters: 1000, lat0: -6.89)) {
        t.add(f);
      }
      expect(t.distanceM, closeTo(2000, 10));
      expect(t.segments, hasLength(2));
    });

    test('pulih dari draf menghasilkan statistik yang sama', () {
      final t = Track(startedAt: start);
      for (final f in straight(start, meters: 3000)) {
        t.add(f);
      }
      final restored = Track.restore(start, t.segmentsJson());
      expect(restored.distanceM, closeTo(t.distanceM, 1));
      expect(restored.pointCount, t.pointCount);
    });
  });

  group('Recorder', () {
    late StreamController<GpsFix> gps;
    late MemoryDrafts drafts;
    late ProviderContainer container;

    setUp(() {
      gps = StreamController<GpsFix>.broadcast();
      drafts = MemoryDrafts();
      container = ProviderContainer(overrides: [
        gpsSourceProvider.overrideWithValue(() => gps.stream),
        draftStoreProvider.overrideWithValue(drafts),
      ]);
    });
    tearDown(() async {
      container.dispose();
      await gps.close();
    });

    Future<void> feed(List<GpsFix> fixes) async {
      for (final f in fixes) {
        gps.add(f);
      }
      await Future<void>.delayed(Duration.zero);
    }

    test('rekam 5 km dengan jeda: titik saat jeda diabaikan, draf tersimpan berkala', () async {
      final rec = container.read(recorderProvider.notifier);
      await rec.start(now: start, clientRunId: '11111111-1111-4111-8111-111111111111');
      final first = straight(start, meters: 2500);
      await feed(first);
      rec.pause();
      // Saat jeda, pelari berjalan 500 m: tidak boleh terhitung.
      await feed(straight(start.add(const Duration(minutes: 16)), meters: 500, lat0: -6.9 + 2500 * _degPerM));
      rec.resume();
      final resumeAt = start.add(const Duration(minutes: 20));
      await feed(straight(resumeAt, meters: 2500, lat0: -6.9 + 3000 * _degPerM));
      await rec.finish(now: start.add(const Duration(minutes: 40)));

      final s = container.read(recorderProvider);
      expect(s.status, RecorderStatus.finished);
      expect(s.track!.distanceM, closeTo(5000, 15));
      expect(s.track!.segments, hasLength(2));
      expect(drafts.saves, greaterThan(10)); // ditulis tiap 10 titik → aman jika aplikasi dimatikan
      expect(drafts.saved!['finished'], isTrue);

      // Draf bisa dipulihkan ke perekam baru dengan jarak yang sama.
      final other = ProviderContainer(overrides: [
        gpsSourceProvider.overrideWithValue(() => const Stream<GpsFix>.empty()),
        draftStoreProvider.overrideWithValue(drafts),
      ]);
      await other.read(recorderProvider.notifier).restore(drafts.saved!);
      expect(other.read(recorderProvider).track!.distanceM, closeTo(5000, 15));
      expect(other.read(recorderProvider).clientRunId, '11111111-1111-4111-8111-111111111111');
      other.dispose();
    });

    test('reset membuang rekaman dan draf', () async {
      final rec = container.read(recorderProvider.notifier);
      await rec.start(now: start);
      await feed(straight(start, meters: 200));
      await rec.reset();
      expect(container.read(recorderProvider).status, RecorderStatus.idle);
      expect(drafts.saved, isNull);
    });
  });

  test('format', () {
    expect(formatDuration(65), '01:05');
    expect(formatDuration(3725), '1:02:05');
    expect(formatDistanceKm(5012), '5.01');
    expect(formatPaceS(null), '--:--');
  });

  test('judul bawaan menurut jam', () {
    expect(defaultRunTitle(DateTime(2026, 1, 1, 5, 30)), 'Lari pagi');
    expect(defaultRunTitle(DateTime(2026, 1, 1, 16)), 'Lari sore');
    expect(defaultRunTitle(DateTime(2026, 1, 1, 20)), 'Lari malam');
  });

  test('parseRoute dan RunDetail.fromJson', () {
    final d = RunDetail.fromJson({
      'id': 'r1',
      'title': 'Lari pagi',
      'visibility': 'community',
      'startedAt': '2026-11-10T06:00:00Z',
      'distanceM': 5000,
      'movingTimeS': 1800,
      'avgPaceSPerKm': 360,
      'isOwner': true,
      'route': [
        [
          [-6.9, 107.6, 0, 700],
          [-6.8999, 107.6, 4, null],
        ],
      ],
      'publicRoute': <dynamic>[],
      'photos': [
        {'id': 'p1', 'url': '/v1/runs/r1/photos/p1'},
      ],
    });
    expect(d.route.single, hasLength(2));
    expect(d.route.single.first.$1, -6.9);
    expect(d.publicRoute, isEmpty);
    expect(d.photoIds, ['p1']);
    expect(d.summary.visibility, RunVisibility.community);
  });
}
