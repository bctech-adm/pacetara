import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// Logo PaceTara: ikon pelari di kotak membulat. [onGradient] = di atas latar gradien (kotak putih).
class BrandMark extends StatelessWidget {
  const BrandMark({super.key, this.size = 72, this.onGradient = false});
  final double size;
  final bool onGradient;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: onGradient ? Colors.white : null,
        gradient: onGradient ? null : Brand.gradient,
        borderRadius: BorderRadius.circular(size * 0.3),
        boxShadow: [
          BoxShadow(
            color: (onGradient ? Colors.black : Brand.orange).withValues(alpha: onGradient ? 0.18 : 0.35),
            blurRadius: size * 0.35,
            offset: Offset(0, size * 0.12),
          ),
        ],
      ),
      child: onGradient
          ? ShaderMask(
              blendMode: BlendMode.srcIn,
              shaderCallback: (b) => Brand.gradient.createShader(Offset.zero & b.size),
              child: Icon(Icons.directions_run_rounded, size: size * 0.6, color: Colors.white),
            )
          : Icon(Icons.directions_run_rounded, size: size * 0.6, color: Colors.white),
    );
  }
}

/// Latar gradien merek dengan dua lingkaran samar sebagai dekorasi (splash, header login, header profil).
class BrandBackdrop extends StatelessWidget {
  const BrandBackdrop({super.key, this.child, this.borderRadius});
  final Widget? child;
  final BorderRadius? borderRadius;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: borderRadius ?? BorderRadius.zero,
      child: DecoratedBox(
        decoration: const BoxDecoration(gradient: Brand.gradient),
        child: Stack(children: [
          Positioned(right: -60, top: -40, child: _blob(200, 0.16)),
          Positioned(left: -50, bottom: -70, child: _blob(180, 0.12)),
          Positioned(right: 40, bottom: 20, child: _blob(60, 0.10)),
          if (child != null) Positioned.fill(child: child!),
        ]),
      ),
    );
  }

  static Widget _blob(double size, double alpha) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(shape: BoxShape.circle, color: Colors.white.withValues(alpha: alpha)),
      );
}
