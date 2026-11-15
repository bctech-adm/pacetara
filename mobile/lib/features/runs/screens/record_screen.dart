import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:go_router/go_router.dart';
import 'package:latlong2/latlong.dart';

import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/common.dart';
import '../../../core/widgets/motion.dart';
import '../../auth/auth_controller.dart';
import '../../live/live_share.dart';
import '../../live/live_widgets.dart';
import '../../safety/safety_screens.dart';
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

  /// Lokasi untuk SOS: titik rekaman terakhir jika masih baru (< 30 detik), selain itu GPS saat ini.
  Future<SosLocation?> _sosLocation() async {
    final s = ref.read(recorderProvider);
    final track = s.track;
    final last = track?.last;
    if (track != null && last != null) {
      final at = track.startedAt.add(Duration(milliseconds: (last.t * 1000).round()));
      if (DateTime.now().difference(at) < const Duration(seconds: 30)) {
        return (lat: last.lat, lng: last.lng, accuracyM: s.gpsAccuracy);
      }
    }
    try {
      final p = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 10)),
      );
      return (lat: p.latitude, lng: p.longitude, accuracyM: p.accuracy);
    } catch (_) {
      final p = await Geolocator.getLastKnownPosition();
      if (p != null) return (lat: p.latitude, lng: p.longitude, accuracyM: p.accuracy);
      return last == null ? null : (lat: last.lat, lng: last.lng, accuracyM: null);
    }
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
    final active = s.status == RecorderStatus.recording || s.status == RecorderStatus.paused;
    final idleLike = s.status == RecorderStatus.idle || s.status == RecorderStatus.finished;

    return Scaffold(
      body: Column(
        children: [
          Expanded(
            child: Stack(clipBehavior: Clip.none, children: [
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
              // Bayangan lembut di atas peta agar header terbaca di atas tile terang.
              Positioned(
                left: 0,
                right: 0,
                top: 0,
                height: 140,
                child: IgnorePointer(
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: [theme.scaffoldBackgroundColor.withValues(alpha: 0.9), theme.scaffoldBackgroundColor.withValues(alpha: 0)],
                      ),
                    ),
                  ),
                ),
              ),
              // Header mengambang: status, riwayat, SOS.
              Positioned(
                left: 16,
                right: 12,
                top: 0,
                child: SafeArea(
                  bottom: false,
                  child: Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Row(children: [
                        Expanded(child: _StatusTitle(status: s.status)),
                        if (idleLike)
                          _MapCircleButton(
                            key: const Key('open-history'),
                            tooltip: 'Riwayat lari',
                            icon: Icons.history_rounded,
                            onPressed: () => context.push('/runs'),
                          ),
                        // Mode aman (PRD 1.10): tersedia selama lari berlangsung.
                        if (active)
                          SosButton(locate: _sosLocation, userName: ref.watch(authControllerProvider).value?.displayName ?? 'Pengguna PaceTara'),
                      ]),
                      // Pemilih karakter mengambang di atas peta; disembunyikan saat merekam agar tidak tersentuh.
                      AnimatedSwitcher(
                        duration: const Duration(milliseconds: 300),
                        transitionBuilder: (c, a) => SizeTransition(sizeFactor: a, axisAlignment: -1, child: FadeTransition(opacity: a, child: c)),
                        child: idleLike
                            ? const Padding(padding: EdgeInsets.only(top: 12), child: CharacterPickerCard())
                            : const SizedBox(width: double.infinity),
                      ),
                    ]),
                  ),
                ),
              ),
              // "Bibir" panel: sudut membulat panel statistik yang menumpang di atas peta.
              Positioned(
                left: 0,
                right: 0,
                bottom: -1,
                height: 29,
                child: IgnorePointer(
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: theme.colorScheme.surface,
                      borderRadius: const BorderRadius.vertical(top: Radius.circular(28)),
                      boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.10), blurRadius: 16, offset: const Offset(0, -6))],
                    ),
                    child: Align(
                      alignment: const Alignment(0, -0.2),
                      child: Container(
                        width: 40,
                        height: 4,
                        decoration: BoxDecoration(color: theme.colorScheme.outlineVariant, borderRadius: BorderRadius.circular(2)),
                      ),
                    ),
                  ),
                ),
              ),
            ]),
          ),
          Container(
            color: theme.colorScheme.surface,
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
            child: SafeArea(
              top: false,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Jarak besar ala odometer.
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.baseline,
                    textBaseline: TextBaseline.alphabetic,
                    children: [
                      RollingText(
                        formatDistanceKm(track?.distanceM ?? 0),
                        style: theme.textTheme.displayLarge?.copyWith(fontSize: 64, height: 1, color: theme.colorScheme.onSurface),
                      ),
                      const SizedBox(width: 6),
                      Text('km', style: theme.textTheme.titleLarge?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
                    ],
                  ),
                  Text('Jarak (km)', style: theme.textTheme.labelMedium),
                  const SizedBox(height: 14),
                  Row(children: [
                    _Stat(icon: Icons.timer_outlined, label: 'Durasi', value: formatDuration(s.activeSeconds)),
                    const SizedBox(width: 8),
                    _Stat(icon: Icons.speed_rounded, label: 'Pace kini', value: formatPaceS(track?.currentPaceSPerKm)),
                    const SizedBox(width: 8),
                    _Stat(icon: Icons.av_timer_rounded, label: 'Pace rata-rata', value: formatPaceS(track?.avgPaceSPerKm)),
                  ]),
                  const SizedBox(height: 10),
                  Wrap(
                    alignment: WrapAlignment.center,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    spacing: 8,
                    runSpacing: 6,
                    children: [
                      _GpsBadge(accuracy: s.gpsAccuracy, active: active),
                      // Status lari: mati secara bawaan, dipilih per komunitas sebelum/saat merekam.
                      if (s.status != RecorderStatus.finished) const LiveShareChip(),
                    ],
                  ),
                  const SizedBox(height: 14),
                  AnimatedSwitcher(
                    duration: const Duration(milliseconds: 320),
                    switchInCurve: Curves.easeOutBack,
                    transitionBuilder: (c, a) => ScaleTransition(scale: Tween(begin: 0.85, end: 1.0).animate(a), child: FadeTransition(opacity: a, child: c)),
                    child: switch (s.status) {
                      RecorderStatus.idle => _RoundAction(
                          key: const ValueKey('start'),
                          icon: Icons.play_arrow_rounded,
                          label: 'Mulai lari',
                          size: 84,
                          pulse: true,
                          onPressed: _start,
                        ),
                      RecorderStatus.finished => SizedBox(
                          key: const ValueKey('save'),
                          width: double.infinity,
                          child: _GradientButton(
                            icon: Icons.save_alt_rounded,
                            label: 'Simpan lari terakhir',
                            onPressed: () => context.push('/runs/save'),
                          ),
                        ),
                      RecorderStatus.recording => _RoundAction(
                          key: const ValueKey('pause'),
                          icon: Icons.pause_rounded,
                          label: 'Jeda',
                          size: 76,
                          dark: true,
                          onPressed: rec.pause,
                        ),
                      RecorderStatus.paused => Row(
                          key: const ValueKey('paused'),
                          mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                          children: [
                            _RoundAction(icon: Icons.play_arrow_rounded, label: 'Lanjut', size: 76, onPressed: rec.resume),
                            _RoundAction(icon: Icons.stop_rounded, label: 'Selesai', size: 76, dark: true, onPressed: _finish),
                          ],
                        ),
                    },
                  ),
                  if (s.status == RecorderStatus.idle) ...[
                    const SizedBox(height: 6),
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

/// Judul status di atas peta; saat merekam ada titik merah berkedip.
class _StatusTitle extends StatelessWidget {
  const _StatusTitle({required this.status});
  final RecorderStatus status;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final text = switch (status) {
      RecorderStatus.recording => 'Merekam lari',
      RecorderStatus.paused => 'Dijeda',
      _ => 'Lari',
    };
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 250),
      layoutBuilder: (current, previous) => Stack(alignment: Alignment.centerLeft, children: [...previous, ?current]),
      child: Row(key: ValueKey(text), mainAxisSize: MainAxisSize.min, children: [
        if (status == RecorderStatus.recording) ...[
          const PulseRings(
            color: Color(0xFFFF1744),
            spread: 8,
            child: SizedBox.square(dimension: 10, child: DecoratedBox(decoration: BoxDecoration(color: Color(0xFFFF1744), shape: BoxShape.circle))),
          ),
          const SizedBox(width: 12),
        ],
        Text(text, style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
      ]),
    );
  }
}

class _MapCircleButton extends StatelessWidget {
  const _MapCircleButton({super.key, required this.icon, required this.tooltip, required this.onPressed});
  final IconData icon;
  final String tooltip;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Pressable(
      child: Material(
        color: scheme.surface,
        shape: const CircleBorder(),
        elevation: 3,
        shadowColor: Colors.black26,
        child: IconButton(tooltip: tooltip, icon: Icon(icon), onPressed: onPressed),
      ),
    );
  }
}

/// Tombol bulat besar (mulai, jeda, lanjut, selesai) dengan label di bawahnya.
class _RoundAction extends StatelessWidget {
  const _RoundAction({super.key, required this.icon, required this.label, required this.onPressed, this.size = 76, this.dark = false, this.pulse = false});
  final IconData icon;
  final String label;
  final VoidCallback onPressed;
  final double size;
  final bool dark;
  final bool pulse;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDarkTheme = theme.brightness == Brightness.dark;
    final circle = Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: dark ? null : Brand.gradient,
        color: dark ? (isDarkTheme ? const Color(0xFF2E2F38) : const Color(0xFF1B1C22)) : null,
        boxShadow: [
          BoxShadow(
            color: (dark ? Colors.black : Brand.orange).withValues(alpha: dark ? 0.25 : 0.45),
            blurRadius: 20,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: Icon(icon, color: Colors.white, size: size * 0.48),
    );
    return Semantics(
      button: true,
      label: label,
      excludeSemantics: true,
      child: Pressable(
        scale: 0.9,
        child: GestureDetector(
          onTap: onPressed,
          behavior: HitTestBehavior.opaque,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            pulse ? PulseRings(spread: 18, child: circle) : circle,
            const SizedBox(height: 8),
            Text(label, style: theme.textTheme.labelLarge),
          ]),
        ),
      ),
    );
  }
}

/// Tombol lebar bergradien.
class _GradientButton extends StatelessWidget {
  const _GradientButton({required this.icon, required this.label, required this.onPressed});
  final IconData icon;
  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      child: DecoratedBox(
        decoration: BoxDecoration(
          gradient: Brand.gradient,
          borderRadius: BorderRadius.circular(18),
          boxShadow: [BoxShadow(color: Brand.orange.withValues(alpha: 0.4), blurRadius: 18, offset: const Offset(0, 8))],
        ),
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            borderRadius: BorderRadius.circular(18),
            onTap: onPressed,
            child: SizedBox(
              height: 58,
              child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                Icon(icon, color: Colors.white),
                const SizedBox(width: 10),
                Text(label, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 16)),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.icon, required this.label, required this.value});
  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 8),
        decoration: BoxDecoration(color: theme.colorScheme.surfaceContainer, borderRadius: BorderRadius.circular(18)),
        child: Column(
          children: [
            Icon(icon, size: 18, color: theme.colorScheme.primary),
            const SizedBox(height: 4),
            FittedBox(
              fit: BoxFit.scaleDown,
              child: Text(
                value,
                style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800, fontFeatures: tabularFigures),
              ),
            ),
            Text(label, style: theme.textTheme.labelSmall, maxLines: 1, overflow: TextOverflow.ellipsis),
          ],
        ),
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
        ? ('Mencari sinyal GPS…', Brand.warning)
        : a <= 10
            ? ('GPS kuat (±${a.round()} m)', Brand.success)
            : a <= maxAccuracyM
                ? ('GPS sedang (±${a.round()} m)', Brand.warning)
                : ('GPS lemah (±${a.round()} m), titik diabaikan', Colors.red);
    return AnimatedContainer(
      duration: const Duration(milliseconds: 300),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(999)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(Icons.gps_fixed_rounded, size: 16, color: color),
        const SizedBox(width: 6),
        Text(text, style: Theme.of(context).textTheme.labelMedium?.copyWith(color: color, fontWeight: FontWeight.w700)),
      ]),
    );
  }
}
