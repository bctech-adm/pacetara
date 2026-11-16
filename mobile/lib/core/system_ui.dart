import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/// Layar penuh (immersive sticky): bilah status dan tombol navigasi Android (back/home/recent) disembunyikan agar
/// tidak menimpa tombol di bagian bawah layar. Usap dari tepi layar memunculkannya sebentar di atas aplikasi
/// (tata letak tidak bergeser), lalu sistem menyembunyikannya lagi.
///
/// Android memunculkan bilah lagi setelah keyboard ditutup, dialog sistem (izin, kamera), atau aplikasi kembali dari
/// latar belakang; [SystemUi] menerapkan ulang mode ini di saat-saat itu.
class SystemUi with WidgetsBindingObserver {
  SystemUi._();
  static final instance = SystemUi._();

  Timer? _rehide;

  Future<void> init() async {
    WidgetsBinding.instance.addObserver(this);
    await SystemChrome.setSystemUIChangeCallback((systemOverlaysAreVisible) async {
      if (!systemOverlaysAreVisible) return;
      // Beri waktu jika pengguna sengaja mengusap untuk memakai tombol back/home.
      _rehide?.cancel();
      _rehide = Timer(const Duration(seconds: 3), apply);
    });
    await apply();
  }

  Future<void> apply() => SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) apply();
  }
}
