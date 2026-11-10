import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:latlong2/latlong.dart';

import '../runs/recorder.dart';
import 'live_repository.dart';

/// Pilihan status lari untuk lari yang sedang/akan direkam.
class LiveShareState {
  const LiveShareState({this.shares = const {}, this.lastSentOk});

  /// id komunitas → tampilkan posisi di peta. Kosong = status lari mati (bawaan).
  final Map<String, bool> shares;

  /// Hasil pengiriman terakhir (null = belum pernah mengirim).
  final bool? lastSentOk;

  bool get isOn => shares.isNotEmpty;

  LiveShareState copy({Map<String, bool>? shares, bool? lastSentOk}) =>
      LiveShareState(shares: shares ?? this.shares, lastSentOk: lastSentOk ?? this.lastSentOk);
}

/// Mengirim status lari ke server selama merekam, dan menghapusnya begitu lari selesai.
///
/// - Bawaan mati, dan kembali mati setiap lari baru (pilihan tidak disimpan).
/// - Pembaruan tiap [interval] saat merekam atau dijeda; gagal kirim (offline) diabaikan,
///   status hilang sendiri di server setelah 3 menit tanpa pembaruan.
/// - Lari selesai atau dibuang → DELETE ke server; server juga menghapusnya saat lari diunggah.
class LiveShareController extends Notifier<LiveShareState> {
  static const interval = Duration(seconds: 10);

  Timer? _timer;
  String? _activeRunId;
  bool _sending = false;

  @override
  LiveShareState build() {
    ref.onDispose(() => _timer?.cancel());
    ref.listen<RecorderState>(recorderProvider, _onRecorder);
    return const LiveShareState();
  }

  LiveApi get _api => ref.read(liveApiProvider);

  /// Ganti pilihan komunitas. Saat merekam, langsung dikirim (kosong = status dimatikan).
  void setShares(Map<String, bool> shares) {
    state = LiveShareState(shares: Map<String, bool>.unmodifiable(shares));
    final rec = ref.read(recorderProvider);
    if (!_isActive(rec.status)) return;
    if (shares.isEmpty) {
      _stop();
    } else {
      _activeRunId = rec.clientRunId;
      _ensureTimer();
      unawaited(sendNow());
    }
  }

  void _onRecorder(RecorderState? prev, RecorderState next) {
    final active = _isActive(next.status);
    if (active && state.isOn) {
      final firstTick = _activeRunId != next.clientRunId;
      _activeRunId = next.clientRunId;
      _ensureTimer();
      // Kirim segera saat mulai/jeda/lanjut agar teman melihat perubahan tanpa menunggu interval.
      if (firstTick || prev?.status != next.status) unawaited(sendNow());
    } else if (prev != null && _isActive(prev.status) && !active) {
      // Selesai atau dibuang: hapus status di server dan kembali ke bawaan (mati) untuk lari berikutnya.
      _stop();
      state = const LiveShareState();
    }
  }

  @visibleForTesting
  Future<void> sendNow() async {
    final rec = ref.read(recorderProvider);
    final track = rec.track;
    final runId = rec.clientRunId;
    if (!state.isOn || !_isActive(rec.status) || track == null || runId == null || _sending) return;
    _sending = true;
    final last = rec.status == RecorderStatus.recording ? track.last : null;
    final first = track.segments.firstWhere((s) => s.isNotEmpty, orElse: () => const []);
    try {
      await _api.update(LiveUpdate(
        clientRunId: runId,
        shares: [for (final e in state.shares.entries) LiveShare(communityId: e.key, showLocation: e.value)],
        startedAt: track.startedAt,
        distanceM: track.distanceM,
        movingTimeS: rec.activeSeconds,
        paused: rec.status == RecorderStatus.paused,
        position: last == null ? null : LatLng(last.lat, last.lng),
        origin: first.isEmpty ? null : LatLng(first.first.lat, first.first.lng),
      ));
      if (state.lastSentOk != true) state = state.copy(lastSentOk: true);
    } catch (e) {
      if (kDebugMode) debugPrint('Status lari gagal dikirim: $e');
      if (state.lastSentOk != false) state = state.copy(lastSentOk: false);
    } finally {
      _sending = false;
    }
  }

  void _ensureTimer() {
    _timer ??= Timer.periodic(interval, (_) => unawaited(sendNow()));
  }

  /// Hentikan pengiriman. DELETE ke server hanya jika status lari ini memang pernah dinyalakan.
  void _stop() {
    _timer?.cancel();
    _timer = null;
    final runId = _activeRunId;
    _activeRunId = null;
    if (runId != null) unawaited(_endQuietly(runId));
  }

  Future<void> _endQuietly(String runId) async {
    try {
      await _api.end(runId);
    } catch (e) {
      // Offline: status tetap hilang sendiri di server setelah TTL (3 menit).
      if (kDebugMode) debugPrint('Status lari gagal dihapus: $e');
    }
  }

  static bool _isActive(RecorderStatus s) => s == RecorderStatus.recording || s == RecorderStatus.paused;
}

final liveShareProvider = NotifierProvider<LiveShareController, LiveShareState>(LiveShareController.new);
