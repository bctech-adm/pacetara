import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'track.dart';

/// Karakter penanda posisi di peta (seperti ikon motor/mobil di aplikasi navigasi):
/// pelari tampak atas yang diputar mengikuti arah gerak.
class RunnerCharacter {
  const RunnerCharacter(this.id, this.label, this.shirt, this.shorts, {this.cap = false});
  final String id;
  final String label;
  final Color shirt;
  final Color shorts;
  final bool cap;

  Color get color => shirt;
}

const runnerCharacters = <RunnerCharacter>[
  RunnerCharacter('runner', 'Oranye', Color(0xFFF0590E), Color(0xFF263238)),
  RunnerCharacter('runner_pink', 'Merah muda', Color(0xFFE91E63), Color(0xFF37474F)),
  RunnerCharacter('runner_blue', 'Biru', Color(0xFF1E88E5), Color(0xFF263238), cap: true),
  RunnerCharacter('runner_green', 'Hijau', Color(0xFF43A047), Color(0xFF1B5E20)),
  RunnerCharacter('runner_purple', 'Ungu', Color(0xFF8E24AA), Color(0xFF311B92), cap: true),
  RunnerCharacter('runner_yellow', 'Kuning', Color(0xFFFBC02D), Color(0xFF424242)),
];

const _prefKey = 'runner_character';

/// Pilihan karakter, disimpan di HP (bukan data pribadi, tidak dikirim ke server).
class RunnerCharacterController extends Notifier<RunnerCharacter> {
  @override
  RunnerCharacter build() {
    _load();
    return runnerCharacters.first;
  }

  Future<void> _load() async {
    try {
      final id = (await SharedPreferences.getInstance()).getString(_prefKey);
      final found = runnerCharacters.where((c) => c.id == id);
      if (found.isNotEmpty) state = found.first;
    } catch (_) {
      // tetap bawaan
    }
  }

  Future<void> select(RunnerCharacter c) async {
    state = c;
    try {
      await (await SharedPreferences.getInstance()).setString(_prefKey, c.id);
    } catch (_) {}
  }
}

final runnerCharacterProvider = NotifierProvider<RunnerCharacterController, RunnerCharacter>(RunnerCharacterController.new);

/// Arah gerak (derajat dari utara, searah jarum jam) dari titik-titik terakhir.
/// Memakai titik ≥ 15 m ke belakang agar tidak berputar-putar karena derau GPS.
double? headingFromTrack(List<TrackPoint> seg) {
  if (seg.length < 2) return null;
  final last = seg.last;
  for (var i = seg.length - 2; i >= 0; i--) {
    final p = seg[i];
    if (haversine(p.lat, p.lng, last.lat, last.lng) >= 15) return bearing(p.lat, p.lng, last.lat, last.lng);
  }
  return null;
}

double bearing(double lat1, double lng1, double lat2, double lng2) {
  double rad(double d) => d * math.pi / 180;
  final y = math.sin(rad(lng2 - lng1)) * math.cos(rad(lat2));
  final x = math.cos(rad(lat1)) * math.sin(rad(lat2)) - math.sin(rad(lat1)) * math.cos(rad(lat2)) * math.cos(rad(lng2 - lng1));
  return (math.atan2(y, x) * 180 / math.pi + 360) % 360;
}

/// Penanda karakter: lingkaran bayangan di tanah + pelari tampak atas yang menghadap [heading].
/// [moving] = kaki dan tangan berayun (hanya saat merekam).
class RunnerMarker extends StatefulWidget {
  const RunnerMarker({super.key, required this.character, this.heading, this.size = 56, this.moving = false});
  final RunnerCharacter character;
  final double? heading;
  final double size;
  final bool moving;

  @override
  State<RunnerMarker> createState() => _RunnerMarkerState();
}

class _RunnerMarkerState extends State<RunnerMarker> {
  Timer? _timer;
  bool _stride = false;

  @override
  void initState() {
    super.initState();
    _sync();
  }

  @override
  void didUpdateWidget(covariant RunnerMarker old) {
    super.didUpdateWidget(old);
    if (old.moving != widget.moving) _sync();
  }

  void _sync() {
    _timer?.cancel();
    _timer = null;
    if (widget.moving) {
      _timer = Timer.periodic(const Duration(milliseconds: 320), (_) {
        if (mounted) setState(() => _stride = !_stride);
      });
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.size;
    return SizedBox(
      width: s,
      height: s,
      child: Stack(alignment: Alignment.center, children: [
        // Lingkaran di tanah (tidak berputar), seperti di aplikasi navigasi.
        Container(
          width: s * 0.86,
          height: s * 0.86,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: widget.character.shirt.withValues(alpha: 0.18),
            border: Border.all(color: widget.character.shirt.withValues(alpha: 0.45), width: 1.5),
          ),
        ),
        AnimatedRotation(
          turns: (widget.heading ?? 0) / 360,
          duration: const Duration(milliseconds: 400),
          child: CustomPaint(size: Size(s, s), painter: _RunnerPainter(widget.character, _stride)),
        ),
      ]),
    );
  }
}

/// Pelari dilihat dari atas, menghadap ke atas (utara) sebelum diputar.
class _RunnerPainter extends CustomPainter {
  _RunnerPainter(this.c, this.stride);
  final RunnerCharacter c;
  final bool stride;

  static const _skin = Color(0xFFE0A47A);
  static const _hair = Color(0xFF3E2723);
  static const _shoe = Color(0xFFFAFAFA);
  static const _outline = Color(0x99000000);

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final cx = w / 2, cy = w / 2;
    final sign = stride ? -1.0 : 1.0; // kaki/tangan mana yang di depan
    final outline = Paint()
      ..color = _outline
      ..style = PaintingStyle.stroke
      ..strokeWidth = w * 0.018;

    void limb(Offset from, Offset to, double width, Color color, Color tip) {
      final p = Paint()
        ..color = color
        ..strokeWidth = width
        ..strokeCap = StrokeCap.round;
      canvas.drawLine(from, to, Paint()
        ..color = _outline
        ..strokeWidth = width + w * 0.03
        ..strokeCap = StrokeCap.round);
      canvas.drawLine(from, to, p);
      canvas.drawCircle(to, width * 0.62, Paint()..color = tip);
      canvas.drawCircle(to, width * 0.62, outline);
    }

    // Bayangan lembut
    canvas.drawOval(
      Rect.fromCenter(center: Offset(cx + w * 0.03, cy + w * 0.04), width: w * 0.46, height: w * 0.56),
      Paint()
        ..color = const Color(0x33000000)
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 3),
    );

    // Kaki: satu melangkah ke depan, satu ke belakang
    final hipY = cy + w * 0.06;
    final legW = w * 0.085;
    limb(Offset(cx - w * 0.07, hipY), Offset(cx - w * 0.08, hipY - sign * w * 0.22), legW, c.shorts, _shoe);
    limb(Offset(cx + w * 0.07, hipY), Offset(cx + w * 0.08, hipY + sign * w * 0.22), legW, c.shorts, _shoe);

    // Tangan berayun berlawanan dengan kaki
    final shoulderY = cy - w * 0.02;
    final armW = w * 0.065;
    limb(Offset(cx - w * 0.17, shoulderY), Offset(cx - w * 0.2, shoulderY + sign * w * 0.15), armW, _skin, _skin);
    limb(Offset(cx + w * 0.17, shoulderY), Offset(cx + w * 0.2, shoulderY - sign * w * 0.15), armW, _skin, _skin);

    // Badan (bahu lebar, dilihat dari atas)
    final torso = RRect.fromRectAndRadius(
      Rect.fromCenter(center: Offset(cx, cy + w * 0.01), width: w * 0.38, height: w * 0.2),
      Radius.circular(w * 0.1),
    );
    canvas.drawRRect(torso, Paint()..color = c.shirt);
    canvas.drawRRect(torso, outline);

    // Kepala (rambut/topi terlihat dari atas), sedikit condong ke depan
    final head = Offset(cx, cy - w * 0.035);
    canvas.drawCircle(head, w * 0.095, Paint()..color = c.cap ? c.shirt : _hair);
    canvas.drawCircle(head, w * 0.095, outline);
    if (c.cap) {
      // Lidah topi menunjuk arah lari
      final visor = Path()
        ..moveTo(head.dx - w * 0.07, head.dy - w * 0.06)
        ..quadraticBezierTo(head.dx, head.dy - w * 0.17, head.dx + w * 0.07, head.dy - w * 0.06)
        ..close();
      canvas.drawPath(visor, Paint()..color = Color.lerp(c.shirt, Colors.black, 0.35)!);
    } else {
      // Hidung kecil penunjuk arah
      canvas.drawCircle(Offset(head.dx, head.dy - w * 0.095), w * 0.025, Paint()..color = _skin);
    }
  }

  @override
  bool shouldRepaint(covariant _RunnerPainter old) => old.c.id != c.id || old.stride != stride;
}

/// Pemilih karakter yang mengambang di pojok kiri atas peta.
class CharacterPickerCard extends ConsumerWidget {
  const CharacterPickerCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final current = ref.watch(runnerCharacterProvider);
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: scheme.surface.withValues(alpha: 0.95),
      elevation: 3,
      borderRadius: BorderRadius.circular(14),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.all(4),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          for (final c in runnerCharacters)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 2),
              child: Tooltip(
                message: c.label,
                child: InkWell(
                  borderRadius: BorderRadius.circular(10),
                  onTap: () => ref.read(runnerCharacterProvider.notifier).select(c),
                  child: Container(
                    padding: const EdgeInsets.all(2),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(10),
                      color: c.id == current.id ? scheme.primaryContainer : Colors.transparent,
                    ),
                    child: RunnerMarker(character: c, size: 40),
                  ),
                ),
              ),
            ),
        ]),
      ),
    );
  }
}
