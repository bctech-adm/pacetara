import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config.dart';

/// Certificate pinning ke CA: aplikasi hanya mempercayai root Let's Encrypt (ISRG Root X1/X2 dan
/// generasi Y: Root YE/YR, yang menerbitkan intermediate seperti YE2 sejak 2026),
/// bukan seluruh CA bawaan perangkat. Sertifikat leaf yang diperbarui otomatis oleh Caddy tetap
/// diterima, sementara sertifikat dari CA lain (termasuk CA yang dipasang pengguna atau proxy MITM)
/// ditolak. Caddy dikunci ke ACME Let's Encrypt (lihat infra/caddy/Caddyfile).
Future<SecurityContext> loadPinnedSecurityContext() async {
  final ctx = SecurityContext(withTrustedRoots: false);
  for (final path in const [
    'assets/certs/isrgrootx1.pem',
    'assets/certs/isrg-root-x2.pem',
    'assets/certs/isrg-root-ye.pem',
    'assets/certs/isrg-root-yr.pem',
  ]) {
    final pem = await rootBundle.load(path);
    ctx.setTrustedCertificatesBytes(pem.buffer.asUint8List());
  }
  return ctx;
}

final securityContextProvider = Provider<SecurityContext>(
  (ref) => throw UnimplementedError('Di-override di main()'),
);

HttpClient createPinnedHttpClient(SecurityContext ctx) {
  final client = HttpClient(context: ctx);
  if (!kReleaseMode && AppConfig.allowDevCa) {
    // Caddy lokal memakai CA internal; hanya diizinkan di debug dengan flag eksplisit.
    final devHost = Uri.parse(AppConfig.apiBaseUrl).host;
    client.badCertificateCallback = (cert, host, port) => host == devHost;
  }
  return client;
}
