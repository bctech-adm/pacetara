import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:go_router/go_router.dart';
import 'package:latlong2/latlong.dart';

import '../../../core/widgets/common.dart';
import '../../live/live_share.dart';
import '../../live/live_widgets.dart';
import '../recorder.dart';
import '../route_map.dart';
import '../runner_character.dart';
import '../track.dart';

/// Posisi saat belum merekam, hanya jika izin lokasi SUDAH diberikan (tidak memunculkan dialog izin).
final idlePositionProvider = FutureProvider.autoDispose<LatLng?>((ref) async {
  try {
    if (!await Geolocator.isLocationServiceEnabled()) return null;
    final perm = await Geolocator.checkPermission();
    if (perm != LocationPermission.whileInUse && perm != LocationPermission.always) return null;
    Position? p;
    try {
      p = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 10)),
      );
    } catch (_) {
      p = await Geolocator.getLastKnownPosition();
    }
    return p == null ? null : LatLng(p.latitude, p.longitude);
  } catch (_) {
    return null;
  }
});

/// Tab "Lari": mulai, jeda, lanjut, selesai. Rekaman berjalan di foreground service.
class RecordScreen extends ConsumerStatefulWidget {
  const RecordScreen({super.key});

  @override
  ConsumerState<RecordScreen> createState() => _RecordScreenState();
}

class _RecordScreenState extends ConsumerState<RecordScreen> {
  bool _checkedDraft = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _offerDraftRecovery());
  }

  /// Aplikasi tertutup saat merekam → tawarkan melanjutkan atau menyimpan rekaman itu.
  Future<void> _offerDraftRecovery() async {
    if (_checkedDraft) return;
    _checkedDraft = true;
    final rec = ref.read(recorderProvider.notifier);
    if (ref.read(recorderProvider).status != RecorderStatus.idle) return;
    final draft = await rec.pendingDraft();
    if (draft == null || !mounted) return;
    final keep = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        title: const Text('Rekaman lari belum selesai'),
        content: const Text('Ada rekaman lari dari sesi sebelumnya. Lanjutkan rekaman itu?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Buang')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Lanjutkan')),
        ],
      ),
    );
    if (keep == true) {
      await rec.restore(draft);
      if (ref.read(recorderProvider).status == RecorderStatus.finished && mounted) context.push('/runs/save');
    } else {
      await rec.reset();
    }
  }

  Future<bool> _askPermission(Future<void> Function() ask) async {
    try {
      await ask();
      return true;
    } on PermissionProblem catch (p) {
      if (!mounted) return false;
      showInfo(context, p.message);
      if (p.openSettings) {
        await (p.message.contains('GPS') ? Geolocator.openLocationSettings() : Geolocator.openAppSettings());
      }
      return false;
    }
  }

  Future<void> _start() async {
    if (!await _askPermission(ensureLocationReady)) return;
    await ref.read(recorderProvider.notifier).start();
  }

  /// Tombol "lokasi saya" saat belum merekam: minta izin lokasi (atas tindakan pengguna) lalu ambil posisi.
  Future<void> _locate() async {
    if (ref.read(recorderProvider).status != RecorderStatus.idle) return;
    if (!await _askPermission(ensureLocationPermission)) return;
    ref.invalidate(idlePositionProvider);
  }

  Future<void> _finish() async {
    final s = ref.read(recorderProvider);
    final short = (s.track?.distanceM ?? 0) < 50;
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Selesai lari?'),
        content: Text(short ? 'Jarak masih sangat pendek. Tetap selesai?' : 'Rekaman dihentikan lalu kamu bisa menyimpannya.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Lanjut lari')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Selesai')),
        ],
      ),
    );
    if (ok != true) return;
    await ref.read(recorderProvider.notifier).finish();
    if (mounted) context.push('/runs/save');
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(recorderProvider);
    final rec = ref.read(recorderProvider.notifier);
    ref.watch(liveShareProvider); // pengirim status lari hidup selama layar Lari ada
    final theme = Theme.of(context);
    final track = s.track;
    final segments = [for (final seg in track?.segments ?? const <List<TrackPoint>>[]) [for (final p in seg) LatLng(p.lat, p.lng)]];
    final character = ref.watch(runnerCharacterProvider);
    final lastPoint = track?.last;
    final runnerAt = lastPoint != null
        ? LatLng(lastPoint.lat, lastPoint.lng)
        : (s.status == RecorderStatus.idle ? ref.watch(idlePositionProvider).value : null);

    return Scaffold(
      appBar: AppBar(
        title: Text(switch (s.status) {
          RecorderStatus.recording => 'Merekam lari',
          RecorderStatus.paused => 'Dijeda',
          _ => 'Lari',
        }),
      ),
      body: Column(
        children: [
          Expanded(
            child: Stack(children: [
              Positioned.fill(
                child: RouteMap(
                  segments: segments,
                  follow: s.status == RecorderStatus.recording,
                  showEndpoints: false,
                  runnerAt: runnerAt,
                  runnerHeading: track == null ? null : headingFromTrack(track.segments.last),
                  runnerMoving: s.status == RecorderStatus.recording,
                  character: character,
                  onLocate: _locate,
                ),
              ),
              // Pemilih karakter mengambang di atas peta; disembunyikan saat merekam agar tidak tersentuh.
              if (s.status == RecorderStatus.idle || s.status == RecorderStatus.finished)
                const Positioned(left: 12, top: 12, right: 12, child: Align(alignment: Alignment.topLeft, child: CharacterPickerCard())),
            ]),
          ),
          Container(
            color: theme.colorScheme.surface,
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
            child: SafeArea(
              top: false,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(children: [
                    _Stat(label: 'Jarak (km)', value: formatDistanceKm(track?.distanceM ?? 0), big: true),
                  ]),
                  const SizedBox(height: 12),
                  Row(children: [
                    _Stat(label: 'Durasi', value: formatDuration(s.activeSeconds)),
                    _Stat(label: 'Pace kini', value: formatPaceS(track?.currentPaceSPerKm)),
                    _Stat(label: 'Pace rata-rata', value: formatPaceS(track?.avgPaceSPerKm)),
                  ]),
                  const SizedBox(height: 8),
                  _GpsBadge(accuracy: s.gpsAccuracy, active: s.status == RecorderStatus.recording || s.status == RecorderStatus.paused),
                  // Status lari: mati secara bawaan, dipilih per komunitas sebelum/saat merekam.
                  if (s.status != RecorderStatus.finished) const Padding(padding: EdgeInsets.only(top: 8), child: LiveShareChip()),
                  const SizedBox(height: 16),
                  switch (s.status) {
                    RecorderStatus.idle || RecorderStatus.finished => SizedBox(
                        width: double.infinity,
                        child: FilledButton.icon(
                          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
                          onPressed: s.status == RecorderStatus.finished ? () => context.push('/runs/save') : _start,
                          icon: const Icon(Icons.play_arrow),
                          label: Text(s.status == RecorderStatus.finished ? 'Simpan lari terakhir' : 'Mulai lari'),
                        ),
                      ),
                    RecorderStatus.recording => Row(children: [
                        Expanded(
                          child: FilledButton.tonalIcon(
                            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
                            onPressed: rec.pause,
                            icon: const Icon(Icons.pause),
                            label: const Text('Jeda'),
                          ),
                        ),
                      ]),
                    RecorderStatus.paused => Row(children: [
                        Expanded(
                          child: FilledButton.icon(
                            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
                            onPressed: rec.resume,
                            icon: const Icon(Icons.play_arrow),
                            label: const Text('Lanjut'),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: OutlinedButton.icon(
                            style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(56)),
                            onPressed: _finish,
                            icon: const Icon(Icons.stop),
                            label: const Text('Selesai'),
                          ),
                        ),
                      ]),
                  },
                  if (s.status == RecorderStatus.idle) ...[
                    const SizedBox(height: 8),
                    Text('Rekaman tetap berjalan saat layar mati.', style: theme.textTheme.bodySmall),
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value, this.big = false});
  final String label;
  final String value;
  final bool big;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Expanded(
      child: Column(
        children: [
          Text(value, style: (big ? t.displayMedium : t.headlineSmall)?.copyWith(fontWeight: FontWeight.w700, fontFeatures: const [FontFeature.tabularFigures()])),
          Text(label, style: t.labelMedium),
        ],
      ),
    );
  }
}

class _GpsBadge extends StatelessWidget {
  const _GpsBadge({required this.accuracy, required this.active});
  final double? accuracy;
  final bool active;

  @override
  Widget build(BuildContext context) {
    if (!active) return const SizedBox.shrink();
    final a = accuracy;
    final (text, color) = a == null
        ? ('Mencari sinyal GPS…', Colors.orange)
        : a <= 10
            ? ('GPS kuat (±${a.round()} m)', Colors.green)
            : a <= maxAccuracyM
                ? ('GPS sedang (±${a.round()} m)', Colors.orange)
                : ('GPS lemah (±${a.round()} m), titik diabaikan', Colors.red);
    return Row(mainAxisAlignment: MainAxisAlignment.center, children: [
      Icon(Icons.gps_fixed, size: 16, color: color),
      const SizedBox(width: 6),
      Text(text, style: Theme.of(context).textTheme.labelMedium),
    ]);
  }
}
