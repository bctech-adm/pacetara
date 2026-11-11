import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart' as ph;

import '../auth/auth_controller.dart';
import 'track.dart';

enum RecorderStatus { idle, recording, paused, finished }

class RecorderState {
  const RecorderState({required this.status, this.track, this.clientRunId, this.activeSeconds = 0, this.gpsAccuracy, this.endedAt});

  final RecorderStatus status;
  final Track? track;
  final String? clientRunId;

  /// Durasi aktif (jam dinding, tanpa waktu jeda).
  final int activeSeconds;
  final double? gpsAccuracy;
  final DateTime? endedAt;

  RecorderState copy({RecorderStatus? status, int? activeSeconds, double? gpsAccuracy, DateTime? endedAt}) => RecorderState(
        status: status ?? this.status,
        track: track,
        clientRunId: clientRunId,
        activeSeconds: activeSeconds ?? this.activeSeconds,
        gpsAccuracy: gpsAccuracy ?? this.gpsAccuracy,
        endedAt: endedAt ?? this.endedAt,
      );
}

/// Sumber titik GPS. Di aplikasi: geolocator dengan foreground service (tetap jalan saat layar mati).
/// Di tes: diganti stream buatan.
typedef GpsSource = Stream<GpsFix> Function();

Stream<GpsFix> deviceGpsSource() {
  final settings = AndroidSettings(
    accuracy: LocationAccuracy.best,
    distanceFilter: 5,
    intervalDuration: const Duration(seconds: 2),
    foregroundNotificationConfig: const ForegroundNotificationConfig(
      notificationTitle: 'PaceTara sedang merekam lari',
      notificationText: 'Rekaman tetap berjalan saat layar mati',
      enableWakeLock: true,
      setOngoing: true,
    ),
  );
  return Geolocator.getPositionStream(locationSettings: settings).map(
    (p) => GpsFix(lat: p.latitude, lng: p.longitude, time: p.timestamp, altitude: p.altitude, accuracy: p.accuracy),
  );
}

final gpsSourceProvider = Provider<GpsSource>((ref) => deviceGpsSource);

/// Penyimpanan draf rekaman: berkas di folder data aplikasi, ditulis berkala agar lari tidak
/// hilang jika aplikasi dimatikan sistem. Dihapus setelah lari disimpan/dibuang.
class DraftStore {
  DraftStore([this._ownerId]);

  /// Akun yang sedang login. Draf milik akun lain (HP dipakai bergantian) dibuang, tidak ditawarkan.
  final String? _ownerId;

  Future<File> _file() async => File('${(await getApplicationSupportDirectory()).path}/current_run.json');

  Future<void> save(RecorderState s) async {
    final t = s.track;
    if (t == null) return;
    final data = {
      'ownerId': _ownerId,
      'clientRunId': s.clientRunId,
      'startedAt': t.startedAt.toUtc().toIso8601String(),
      'activeSeconds': s.activeSeconds,
      'segments': t.segmentsJson(),
      'finished': s.status == RecorderStatus.finished,
      'endedAt': s.endedAt?.toUtc().toIso8601String(),
    };
    final f = await _file();
    final tmp = File('${f.path}.tmp');
    await tmp.writeAsString(jsonEncode(data), flush: true);
    await tmp.rename(f.path);
  }

  Future<Map<String, dynamic>?> load() async {
    final f = await _file();
    if (!f.existsSync()) return null;
    try {
      final draft = jsonDecode(await f.readAsString()) as Map<String, dynamic>;
      final owner = draft['ownerId'] as String?;
      if (owner != null && owner != _ownerId) {
        await f.delete();
        return null;
      }
      return draft;
    } catch (_) {
      return null;
    }
  }

  Future<void> clear() async {
    final f = await _file();
    if (f.existsSync()) await f.delete();
  }
}

final draftStoreProvider = Provider<DraftStore>((ref) => DraftStore(ref.watch(authControllerProvider.select((a) => a.value?.id))));

class PermissionProblem implements Exception {
  const PermissionProblem(this.message, {this.openSettings = false});
  final String message;
  final bool openSettings;
  @override
  String toString() => message;
}

/// Memastikan GPS aktif dan izin lokasi (saat aplikasi dipakai) serta notifikasi diberikan.
Future<void> ensureLocationReady() async {
  await ensureLocationPermission();
  // Android 13+: tanpa izin ini notifikasi "sedang merekam" tidak terlihat (rekaman tetap jalan).
  await ph.Permission.notification.request();
}

/// Hanya GPS aktif + izin lokasi saat aplikasi dipakai (untuk tombol "lokasi saya").
Future<void> ensureLocationPermission() async {
  if (!await Geolocator.isLocationServiceEnabled()) {
    throw const PermissionProblem('Nyalakan Lokasi/GPS di HP untuk merekam lari', openSettings: true);
  }
  var perm = await Geolocator.checkPermission();
  if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
  if (perm == LocationPermission.denied) throw const PermissionProblem('Izin lokasi dibutuhkan untuk merekam lari');
  if (perm == LocationPermission.deniedForever) {
    throw const PermissionProblem('Izin lokasi ditolak permanen. Buka Setelan aplikasi untuk mengizinkan', openSettings: true);
  }
}

class RecorderController extends Notifier<RecorderState> {
  StreamSubscription<GpsFix>? _sub;
  Timer? _ticker;
  DateTime? _activeSince;
  int _activeBefore = 0;
  int _unsaved = 0;

  @override
  RecorderState build() {
    ref.onDispose(_stopStreams);
    return const RecorderState(status: RecorderStatus.idle);
  }

  DraftStore get _drafts => ref.read(draftStoreProvider);

  /// Draf yang tertinggal dari sesi sebelumnya (aplikasi tertutup saat merekam), jika ada.
  Future<Map<String, dynamic>?> pendingDraft() => _drafts.load();

  Future<void> start({String? clientRunId, DateTime? now}) async {
    if (state.status == RecorderStatus.recording) return;
    final startedAt = now ?? DateTime.now();
    state = RecorderState(status: RecorderStatus.recording, track: Track(startedAt: startedAt), clientRunId: clientRunId ?? _uuid());
    _activeBefore = 0;
    _activeSince = startedAt;
    _listen();
    await _drafts.save(state);
  }

  /// Melanjutkan draf lama dalam keadaan dijeda.
  Future<void> restore(Map<String, dynamic> draft) async {
    final startedAt = DateTime.parse(draft['startedAt'] as String).toLocal();
    final track = Track.restore(startedAt, draft['segments'] as List<dynamic>);
    final finished = draft['finished'] == true;
    state = RecorderState(
      status: finished ? RecorderStatus.finished : RecorderStatus.paused,
      track: track,
      clientRunId: draft['clientRunId'] as String? ?? _uuid(),
      activeSeconds: (draft['activeSeconds'] as num?)?.toInt() ?? 0,
      endedAt: draft['endedAt'] == null ? null : DateTime.parse(draft['endedAt'] as String).toLocal(),
    );
    _activeBefore = state.activeSeconds;
    _activeSince = null;
  }

  void pause() {
    if (state.status != RecorderStatus.recording) return;
    _activeBefore = _activeNow();
    _activeSince = null;
    // Stream GPS tetap hidup (foreground service tidak berhenti), titik saat jeda diabaikan.
    state = state.copy(status: RecorderStatus.paused, activeSeconds: _activeBefore);
    unawaited(_drafts.save(state));
  }

  void resume({DateTime? now}) {
    if (state.status != RecorderStatus.paused) return;
    state.track!.newSegment();
    _activeSince = now ?? DateTime.now();
    state = state.copy(status: RecorderStatus.recording);
    if (_sub == null) _listen();
  }

  Future<void> finish({DateTime? now}) async {
    if (state.status != RecorderStatus.recording && state.status != RecorderStatus.paused) return;
    final active = _activeNow();
    _stopStreams();
    state = state.copy(status: RecorderStatus.finished, activeSeconds: active, endedAt: now ?? DateTime.now());
    await _drafts.save(state);
  }

  /// Membuang rekaman (setelah disimpan ke antrean upload, atau dibuang pengguna).
  Future<void> reset() async {
    _stopStreams();
    await _drafts.clear();
    state = const RecorderState(status: RecorderStatus.idle);
  }

  void _listen() {
    _sub = ref.read(gpsSourceProvider)().listen(_onFix, onError: (Object e) {
      if (kDebugMode) debugPrint('GPS error: $e');
    });
    _ticker ??= Timer.periodic(const Duration(seconds: 1), (_) {
      if (state.status == RecorderStatus.recording) state = state.copy(activeSeconds: _activeNow());
    });
  }

  void _onFix(GpsFix fix) {
    if (state.status != RecorderStatus.recording) {
      state = state.copy(gpsAccuracy: fix.accuracy);
      return;
    }
    final accepted = state.track!.add(fix);
    state = state.copy(gpsAccuracy: fix.accuracy, activeSeconds: _activeNow());
    if (accepted && ++_unsaved >= 10) {
      _unsaved = 0;
      unawaited(_drafts.save(state));
    }
  }

  int _activeNow() {
    final since = _activeSince;
    return since == null ? _activeBefore : _activeBefore + DateTime.now().difference(since).inSeconds;
  }

  void _stopStreams() {
    _sub?.cancel();
    _sub = null;
    _ticker?.cancel();
    _ticker = null;
  }
}

final recorderProvider = NotifierProvider<RecorderController, RecorderState>(RecorderController.new);

String _uuid() {
  final r = List<int>.generate(16, (_) => _rand.nextInt(256));
  r[6] = (r[6] & 0x0f) | 0x40;
  r[8] = (r[8] & 0x3f) | 0x80;
  String hex(int i) => r[i].toRadixString(16).padLeft(2, '0');
  final h = List.generate(16, hex).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}

final _rand = _SecureRandom();

class _SecureRandom {
  final _r = math.Random.secure();
  int nextInt(int max) => _r.nextInt(max);
}
