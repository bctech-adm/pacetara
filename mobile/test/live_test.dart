import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';
import 'package:pacetara/features/live/live_repository.dart';
import 'package:pacetara/features/live/live_share.dart';
import 'package:pacetara/features/runs/recorder.dart';
import 'package:pacetara/features/runs/track.dart';

import 'runs_test.dart' show MemoryDrafts, straight;

class FakeLiveApi implements LiveApi {
  final updates = <LiveUpdate>[];
  final ended = <String>[];
  bool fail = false;

  @override
  Future<void> update(LiveUpdate u) async {
    if (fail) throw Exception('offline');
    updates.add(u);
  }

  @override
  Future<void> end(String clientRunId) async => ended.add(clientRunId);

  @override
  Future<List<LiveRunner>> community(String communityId) async => const [];
}

const _runId = '22222222-2222-4222-8222-222222222222';
const _c1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const _c2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

void main() {
  final start = DateTime.utc(2026, 11, 10, 6);

  group('Status lari dari perekam', () {
    late StreamController<GpsFix> gps;
    late FakeLiveApi api;
    late ProviderContainer container;

    setUp(() {
      gps = StreamController<GpsFix>.broadcast();
      api = FakeLiveApi();
      container = ProviderContainer(overrides: [
        gpsSourceProvider.overrideWithValue(() => gps.stream),
        draftStoreProvider.overrideWithValue(MemoryDrafts()),
        liveApiProvider.overrideWithValue(api),
      ]);
      container.listen(liveShareProvider, (_, _) {}); // seperti layar Lari yang menontonnya
    });
    tearDown(() async {
      container.dispose();
      await gps.close();
    });

    Future<void> settle() => Future<void>.delayed(Duration.zero);

    test('mati secara bawaan: merekam tanpa memilih komunitas tidak mengirim apa pun', () async {
      expect(container.read(liveShareProvider).isOn, isFalse);
      await container.read(recorderProvider.notifier).start(now: start, clientRunId: _runId);
      for (final f in straight(start, meters: 300)) {
        gps.add(f);
      }
      await settle();
      await container.read(liveShareProvider.notifier).sendNow();
      expect(api.updates, isEmpty);
      await container.read(recorderProvider.notifier).finish();
      await settle();
      expect(api.ended, isEmpty);
    });

    test('mengirim ke komunitas terpilih, berhenti saat dimatikan, dan dihapus saat selesai', () async {
      final share = container.read(liveShareProvider.notifier);
      share.setShares({_c1: true, _c2: false});
      final rec = container.read(recorderProvider.notifier);
      await rec.start(now: start, clientRunId: _runId);
      await settle();

      // Terkirim segera saat mulai.
      expect(api.updates, hasLength(1));
      expect(api.updates.single.clientRunId, _runId);
      expect(api.updates.single.shares.map((s) => (s.communityId, s.showLocation)), [(_c1, true), (_c2, false)]);

      for (final f in straight(start, meters: 600)) {
        gps.add(f);
      }
      await settle();
      await share.sendNow();
      final u = api.updates.last;
      expect(u.distanceM, closeTo(600, 5));
      expect(u.position!.latitude, closeTo(-6.9 + 600 / 111195, 1e-5));
      expect(u.origin, const LatLng(-6.9, 107.6));
      final json = u.toJson();
      expect(json.containsKey('position'), isTrue);
      expect(json.containsKey('origin'), isTrue);

      // Jeda langsung terkirim.
      rec.pause();
      await settle();
      expect(api.updates.last.paused, isTrue);
      expect(api.updates.last.position, isNull);

      // Dimatikan di tengah lari → status dihapus dari server.
      share.setShares({});
      expect(api.ended, [_runId]);

      // Dinyalakan lagi, lalu lari selesai → dihapus, dan pilihan kembali mati untuk lari berikutnya.
      share.setShares({_c1: false});
      await settle();
      expect(api.updates.last.shares.single.showLocation, isFalse);
      await rec.finish();
      await settle();
      expect(api.ended, [_runId, _runId]);
      expect(container.read(liveShareProvider).isOn, isFalse);
    });

    test('gagal kirim (offline) tidak mengganggu rekaman', () async {
      api.fail = true;
      container.read(liveShareProvider.notifier).setShares({_c1: false});
      await container.read(recorderProvider.notifier).start(now: start, clientRunId: _runId);
      await settle();
      expect(container.read(liveShareProvider).lastSentOk, isFalse);
      expect(container.read(recorderProvider).status, RecorderStatus.recording);
    });
  });

  test('posisi tidak dikirim jika tidak ada komunitas yang boleh melihat peta', () {
    final u = LiveUpdate(
      clientRunId: _runId,
      shares: const [LiveShare(communityId: _c1, showLocation: false)],
      startedAt: start,
      distanceM: 1234.567,
      movingTimeS: 400,
      paused: false,
      position: const LatLng(-6.8, 107.6),
      origin: const LatLng(-6.9, 107.6),
    );
    final json = u.toJson();
    expect(json.containsKey('position'), isFalse);
    expect(json.containsKey('origin'), isFalse);
    expect(json['distanceM'], 1234.6);
  });

  test('LiveRunner: durasi berdetak di antara pembaruan, berhenti saat dijeda', () {
    final updated = DateTime.utc(2026, 11, 10, 6, 10);
    final r = LiveRunner.fromJson({
      'userId': 'u1',
      'displayName': 'Ani',
      'avatarUrl': null,
      'isMe': false,
      'startedAt': '2026-11-10T06:00:00.000Z',
      'updatedAt': updated.toIso8601String(),
      'distanceM': 1520,
      'movingTimeS': 590,
      'paused': false,
      'position': {'lat': -6.8865, 'lng': 107.6},
      'positionHidden': false,
    });
    expect(r.position, const LatLng(-6.8865, 107.6));
    expect(r.durationAt(updated.add(const Duration(seconds: 7))), 597);
    // Tidak diekstrapolasi tanpa batas jika pembaruan berhenti datang.
    expect(r.durationAt(updated.add(const Duration(minutes: 5))), 650);
    expect(r.isStale(updated.add(const Duration(seconds: 30))), isFalse);
    expect(r.isStale(updated.add(const Duration(minutes: 1))), isTrue);

    final paused = LiveRunner.fromJson({
      'userId': 'u2',
      'displayName': 'Budi',
      'startedAt': '2026-11-10T06:00:00.000Z',
      'updatedAt': updated.toIso8601String(),
      'distanceM': 0,
      'movingTimeS': 100,
      'paused': true,
      'position': null,
      'positionHidden': true,
    });
    expect(paused.durationAt(updated.add(const Duration(seconds: 30))), 100);
    expect(paused.position, isNull);
    expect(paused.positionHidden, isTrue);
  });
}
