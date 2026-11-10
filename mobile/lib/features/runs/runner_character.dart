import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'track.dart';

/// Karakter penanda posisi di peta (seperti ikon mobil di aplikasi navigasi).
class RunnerCharacter {
  const RunnerCharacter(this.id, this.emoji, this.label, this.color);
  final String id;
  final String emoji;
  final String label;
  final Color color;
}

const runnerCharacters = <RunnerCharacter>[
  RunnerCharacter('runner', '🏃', 'Pelari', Color(0xFFF0590E)),
  RunnerCharacter('runner_f', '🏃‍♀️', 'Pelari putri', Color(0xFFE91E63)),
  RunnerCharacter('cheetah', '🐆', 'Cheetah', Color(0xFFFFA000)),
  RunnerCharacter('fox', '🦊', 'Rubah', Color(0xFFE64A19)),
  RunnerCharacter('turtle', '🐢', 'Santai', Color(0xFF43A047)),
  RunnerCharacter('rocket', '🚀', 'Roket', Color(0xFF3949AB)),
  RunnerCharacter('bolt', '⚡', 'Kilat', Color(0xFFFBC02D)),
  RunnerCharacter('unicorn', '🦄', 'Unicorn', Color(0xFF8E24AA)),
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

/// Penanda karakter: lingkaran berwarna dengan emoji tegak, plus panah arah yang berputar.
class RunnerMarker extends StatelessWidget {
  const RunnerMarker({super.key, required this.character, this.heading, this.size = 52});
  final RunnerCharacter character;
  final double? heading;
  final double size;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size,
      child: Stack(alignment: Alignment.center, children: [
        if (heading != null)
          Transform.rotate(
            angle: heading! * math.pi / 180,
            child: CustomPaint(size: Size(size, size), painter: _ArrowPainter(character.color)),
          ),
        Container(
          width: size * 0.62,
          height: size * 0.62,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: Colors.white,
            shape: BoxShape.circle,
            border: Border.all(color: character.color, width: 3),
            boxShadow: const [BoxShadow(color: Color(0x55000000), blurRadius: 6, offset: Offset(0, 2))],
          ),
          child: Text(character.emoji, style: TextStyle(fontSize: size * 0.32, height: 1)),
        ),
      ]),
    );
  }
}

class _ArrowPainter extends CustomPainter {
  _ArrowPainter(this.color);
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final path = Path()
      ..moveTo(w / 2, 0)
      ..lineTo(w / 2 + w * 0.16, w * 0.2)
      ..lineTo(w / 2 - w * 0.16, w * 0.2)
      ..close();
    canvas.drawPath(path, Paint()..color = color);
  }

  @override
  bool shouldRepaint(covariant _ArrowPainter old) => old.color != color;
}

Future<void> showCharacterPicker(BuildContext context, WidgetRef ref) {
  return showModalBottomSheet<void>(
    context: context,
    builder: (sheet) => Consumer(
      builder: (sheet, ref, _) {
        final current = ref.watch(runnerCharacterProvider);
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Karakter di peta', style: Theme.of(sheet).textTheme.titleMedium),
              const SizedBox(height: 4),
              const Text('Hanya tampil di HP-mu.'),
              const SizedBox(height: 16),
              Wrap(spacing: 12, runSpacing: 12, children: [
                for (final c in runnerCharacters)
                  InkWell(
                    borderRadius: BorderRadius.circular(12),
                    onTap: () {
                      ref.read(runnerCharacterProvider.notifier).select(c);
                      Navigator.pop(sheet);
                    },
                    child: Container(
                      width: 76,
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: c.id == current.id ? c.color : Colors.transparent, width: 2),
                      ),
                      child: Column(children: [
                        RunnerMarker(character: c, size: 44),
                        const SizedBox(height: 4),
                        Text(c.label, style: Theme.of(sheet).textTheme.labelSmall, textAlign: TextAlign.center),
                      ]),
                    ),
                  ),
              ]),
            ]),
          ),
        );
      },
    ),
  );
}
