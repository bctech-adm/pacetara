import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// Benar jika pengguna mematikan animasi di pengaturan aksesibilitas Android.
bool reduceMotion(BuildContext context) => MediaQuery.maybeDisableAnimationsOf(context) ?? false;

/// Muncul dengan memudar sambil naik sedikit. [index] memberi jeda bertahap untuk daftar (maks. 8 langkah).
/// Hanya diputar sekali; tidak memakai Timer, jadi aman untuk tes widget (pumpAndSettle).
class FadeSlideIn extends StatefulWidget {
  const FadeSlideIn({
    super.key,
    required this.child,
    this.index = 0,
    this.offset = 28,
    this.duration = const Duration(milliseconds: 520),
    this.step = const Duration(milliseconds: 55),
    this.axis = Axis.vertical,
  });

  final Widget child;
  final int index;
  final double offset;
  final Duration duration;
  final Duration step;
  final Axis axis;

  @override
  State<FadeSlideIn> createState() => _FadeSlideInState();
}

class _FadeSlideInState extends State<FadeSlideIn> with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  late final Animation<double> _t;

  @override
  void initState() {
    super.initState();
    final delay = widget.step * math.min(widget.index, 8);
    final total = delay + widget.duration;
    _c = AnimationController(vsync: this, duration: total);
    final start = total.inMicroseconds == 0 ? 0.0 : delay.inMicroseconds / total.inMicroseconds;
    _t = CurvedAnimation(parent: _c, curve: Interval(start, 1, curve: Curves.easeOutCubic));
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_c.isAnimating || _c.isCompleted) return;
    if (reduceMotion(context)) {
      _c.value = 1;
    } else {
      _c.forward();
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _t,
      child: widget.child,
      builder: (context, child) {
        final v = _t.value;
        final d = (1 - v) * widget.offset;
        return Opacity(
          opacity: v.clamp(0.0, 1.0),
          child: Transform.translate(offset: widget.axis == Axis.vertical ? Offset(0, d) : Offset(d, 0), child: child),
        );
      },
    );
  }
}

/// Mengecil sedikit saat ditekan (umpan balik sentuh ala aplikasi modern). Tidak menangkap ketukan,
/// jadi InkWell/tombol di dalamnya tetap bekerja.
class Pressable extends StatefulWidget {
  const Pressable({super.key, required this.child, this.scale = 0.96, this.enabled = true});
  final Widget child;
  final double scale;
  final bool enabled;

  @override
  State<Pressable> createState() => _PressableState();
}

class _PressableState extends State<Pressable> {
  bool _down = false;

  void _set(bool v) {
    if (!widget.enabled || _down == v) return;
    setState(() => _down = v);
  }

  @override
  Widget build(BuildContext context) {
    return Listener(
      onPointerDown: (_) => _set(true),
      onPointerUp: (_) => _set(false),
      onPointerCancel: (_) => _set(false),
      child: AnimatedScale(
        scale: _down ? widget.scale : 1,
        duration: const Duration(milliseconds: 140),
        curve: Curves.easeOut,
        child: widget.child,
      ),
    );
  }
}

/// Teks angka bergaya odometer: setiap karakter yang berubah bergulir naik.
/// Karakter dicocokkan dari kanan agar satuan tetap di tempatnya saat jumlah digit bertambah.
class RollingText extends StatelessWidget {
  const RollingText(this.text, {super.key, this.style});
  final String text;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    final s = (style ?? DefaultTextStyle.of(context).style).copyWith(fontFeatures: tabularFigures);
    if (reduceMotion(context)) return Text(text, style: s);
    final chars = text.characters.toList();
    return Semantics(
      label: text,
      excludeSemantics: true,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < chars.length; i++)
            AnimatedSwitcher(
              key: ValueKey(chars.length - i),
              duration: const Duration(milliseconds: 280),
              switchInCurve: Curves.easeOutCubic,
              switchOutCurve: Curves.easeInCubic,
              transitionBuilder: (child, anim) {
                final incoming = child.key == ValueKey(chars[i]);
                final slide = Tween<Offset>(begin: Offset(0, incoming ? 0.6 : -0.6), end: Offset.zero).animate(anim);
                return ClipRect(child: SlideTransition(position: slide, child: FadeTransition(opacity: anim, child: child)));
              },
              layoutBuilder: (current, previous) => Stack(alignment: Alignment.center, children: [...previous, ?current]),
              child: Text(chars[i], key: ValueKey(chars[i]), style: s),
            ),
        ],
      ),
    );
  }
}

/// Cincin berdenyut di belakang [child] (tombol mulai lari). Berhenti jika [active] salah,
/// animasi dimatikan pengguna, atau tab tidak tampil (TickerMode).
class PulseRings extends StatefulWidget {
  const PulseRings({super.key, required this.child, this.active = true, this.color = Brand.orange, this.spread = 26});
  final Widget child;
  final bool active;
  final Color color;
  final double spread;

  @override
  State<PulseRings> createState() => _PulseRingsState();
}

class _PulseRingsState extends State<PulseRings> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 2200));

  void _sync() {
    final run = widget.active && !reduceMotion(context);
    if (run && !_c.isAnimating) _c.repeat();
    if (!run && _c.isAnimating) _c.stop();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void didUpdateWidget(PulseRings old) {
    super.didUpdateWidget(old);
    _sync();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      painter: _RingsPainter(_c, widget.color, widget.spread, widget.active),
      child: widget.child,
    );
  }
}

class _RingsPainter extends CustomPainter {
  _RingsPainter(this.anim, this.color, this.spread, this.active) : super(repaint: anim);
  final Animation<double> anim;
  final Color color;
  final double spread;
  final bool active;

  @override
  void paint(Canvas canvas, Size size) {
    if (!active) return;
    final center = size.center(Offset.zero);
    final r0 = size.shortestSide / 2;
    for (var k = 0; k < 2; k++) {
      final t = (anim.value + k * 0.5) % 1.0;
      final paint = Paint()..color = color.withValues(alpha: (1 - t) * 0.35);
      canvas.drawCircle(center, r0 + t * spread, paint);
    }
  }

  @override
  bool shouldRepaint(_RingsPainter old) => old.color != color || old.active != active || old.spread != spread;
}

/// Teks bergradien (judul merek, angka besar).
class GradientText extends StatelessWidget {
  const GradientText(this.text, {super.key, this.style, this.gradient = Brand.gradient, this.textAlign});
  final String text;
  final TextStyle? style;
  final Gradient gradient;
  final TextAlign? textAlign;

  @override
  Widget build(BuildContext context) {
    return ShaderMask(
      blendMode: BlendMode.srcIn,
      shaderCallback: (bounds) => gradient.createShader(Offset.zero & bounds.size),
      child: Text(text, style: style, textAlign: textAlign),
    );
  }
}

/// Ikon di dalam kotak membulat bergradien (pintasan fitur, menu profil).
class GradientIcon extends StatelessWidget {
  const GradientIcon({super.key, required this.icon, this.gradient = Brand.gradient, this.size = 44});
  final IconData icon;
  final Gradient gradient;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        gradient: gradient,
        borderRadius: BorderRadius.circular(size * 0.32),
        boxShadow: [BoxShadow(color: gradient.colors.last.withValues(alpha: 0.28), blurRadius: 12, offset: const Offset(0, 5))],
      ),
      child: Icon(icon, color: Colors.white, size: size * 0.5),
    );
  }
}

/// Judul bagian dengan aksi opsional di kanan ("Lihat semua").
class SectionHeader extends StatelessWidget {
  const SectionHeader(this.title, {super.key, this.action, this.onAction, this.padding = const EdgeInsets.fromLTRB(20, 20, 12, 8)});
  final String title;
  final String? action;
  final VoidCallback? onAction;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Padding(
      padding: padding,
      child: Row(children: [
        Expanded(child: Text(title, style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800, letterSpacing: -0.2))),
        if (action != null) TextButton(onPressed: onAction, child: Text(action!)),
      ]),
    );
  }
}

/// Keadaan kosong dengan ikon bergradien yang mengambang pelan.
class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.title, this.message, this.action, this.gradient = Brand.gradient});
  final IconData icon;
  final String title;
  final String? message;
  final Widget? action;
  final Gradient gradient;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return FadeSlideIn(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 40),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          GradientIcon(icon: icon, gradient: gradient, size: 88),
          const SizedBox(height: 22),
          Text(title, textAlign: TextAlign.center, style: t.titleLarge),
          if (message != null) ...[
            const SizedBox(height: 8),
            Text(message!, textAlign: TextAlign.center, style: t.bodyMedium?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant)),
          ],
          if (action != null) ...[const SizedBox(height: 24), action!],
        ]),
      ),
    );
  }
}
