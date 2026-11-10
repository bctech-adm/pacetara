import 'dart:async';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:open_filex/open_filex.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';

import '../../core/http/api_client.dart';

/// Info APK terbaru dari `GET /v1/app/android/latest`.
class AppRelease {
  const AppRelease({required this.versionCode, required this.versionName, required this.apkUrl, required this.sha256, required this.notes});
  final int versionCode;
  final String versionName;
  final String apkUrl;
  final String sha256;
  final String notes;

  factory AppRelease.fromJson(Map<String, dynamic> j) => AppRelease(
        versionCode: (j['versionCode'] as num).toInt(),
        versionName: j['versionName'] as String,
        apkUrl: j['apkUrl'] as String,
        sha256: (j['sha256'] as String).toLowerCase(),
        notes: j['notes'] as String? ?? '',
      );
}

final packageInfoProvider = FutureProvider<PackageInfo>((ref) => PackageInfo.fromPlatform());

/// Rilis terbaru jika lebih baru dari yang terpasang; null jika sudah terbaru atau info tidak tersedia.
final availableUpdateProvider = FutureProvider.autoDispose<AppRelease?>((ref) async {
  if (!Platform.isAndroid) return null;
  final info = await ref.watch(packageInfoProvider.future);
  try {
    final res = await ref.watch(bareDioProvider).get<Map<String, dynamic>>('/v1/app/android/latest');
    final release = AppRelease.fromJson(res.data!);
    final current = int.tryParse(info.buildNumber) ?? 0;
    return release.versionCode > current ? release : null;
  } catch (_) {
    return null; // pembaruan tidak boleh mengganggu pemakaian aplikasi
  }
});

class UpdateException implements Exception {
  const UpdateException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Mengunduh APK, memverifikasi SHA-256 dari API (yang diambil lewat koneksi ber-pinning),
/// lalu membuka penginstal Android. APK diunduh dari GitHub Releases dengan TLS biasa; keasliannya
/// dijamin oleh hash ini dan oleh tanda tangan aplikasi yang diperiksa Android.
Future<void> downloadAndInstall(AppRelease release, {required void Function(double progress) onProgress}) async {
  final dir = Directory('${(await getTemporaryDirectory()).path}/updates');
  if (dir.existsSync()) dir.deleteSync(recursive: true);
  dir.createSync(recursive: true);
  final file = File('${dir.path}/pacetara-${release.versionCode}.apk');

  final client = HttpClient()..connectionTimeout = const Duration(seconds: 20);
  try {
    final uri = Uri.parse(release.apkUrl);
    if (uri.scheme != 'https') throw const UpdateException('Alamat unduhan tidak aman');
    final response = await (await client.getUrl(uri)).close();
    if (response.statusCode != 200) throw UpdateException('Unduhan gagal (HTTP ${response.statusCode})');

    final total = response.contentLength;
    var received = 0;
    final digestSink = _DigestSink();
    final hasher = sha256.startChunkedConversion(digestSink);
    final out = file.openWrite();
    await for (final chunk in response) {
      out.add(chunk);
      hasher.add(chunk);
      received += chunk.length;
      if (total > 0) onProgress(received / total);
    }
    await out.close();
    hasher.close();

    if (digestSink.value.toString() != release.sha256) {
      file.deleteSync();
      throw const UpdateException('Berkas unduhan rusak atau tidak asli. Coba lagi');
    }
  } finally {
    client.close(force: true);
  }

  final result = await OpenFilex.open(file.path, type: 'application/vnd.android.package-archive');
  if (result.type != ResultType.done) {
    throw UpdateException(
      result.type == ResultType.permissionDenied
          ? 'Izinkan PaceTara memasang aplikasi (Setelan → Instal aplikasi tidak dikenal), lalu coba lagi'
          : 'Penginstal tidak bisa dibuka: ${result.message}',
    );
  }
}

class _DigestSink implements Sink<Digest> {
  late Digest value;
  @override
  void add(Digest data) => value = data;
  @override
  void close() {}
}

/// Dialog pembaruan dengan progres unduhan.
Future<void> showUpdateDialog(BuildContext context, AppRelease release) {
  return showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (_) => _UpdateDialog(release: release),
  );
}

class _UpdateDialog extends StatefulWidget {
  const _UpdateDialog({required this.release});
  final AppRelease release;

  @override
  State<_UpdateDialog> createState() => _UpdateDialogState();
}

class _UpdateDialogState extends State<_UpdateDialog> {
  double? _progress;
  String? _error;

  Future<void> _start() async {
    setState(() {
      _progress = 0;
      _error = null;
    });
    try {
      await downloadAndInstall(widget.release, onProgress: (p) {
        if (mounted) setState(() => _progress = p);
      });
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted) {
        setState(() {
          _progress = null;
          _error = e is UpdateException ? e.message : 'Pembaruan gagal. Periksa koneksi lalu coba lagi';
        });
      }
      if (kDebugMode) debugPrint('update gagal: $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.release;
    final downloading = _progress != null;
    return AlertDialog(
      icon: const Icon(Icons.system_update),
      title: Text('Versi ${r.versionName} tersedia'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (r.notes.isNotEmpty) Text(r.notes, maxLines: 8, overflow: TextOverflow.ellipsis),
          if (downloading) ...[
            const SizedBox(height: 16),
            LinearProgressIndicator(value: _progress == 0 ? null : _progress),
            const SizedBox(height: 4),
            Text('${((_progress ?? 0) * 100).round()}%'),
          ],
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
          ],
        ],
      ),
      actions: [
        if (!downloading) TextButton(onPressed: () => Navigator.pop(context), child: const Text('Nanti')),
        FilledButton(onPressed: downloading ? null : _start, child: Text(_error == null ? 'Perbarui' : 'Coba lagi')),
      ],
    );
  }
}

/// Memeriksa pembaruan sekali per sesi aplikasi, lalu menawarkan dialog jika ada versi baru.
class UpdateChecker extends ConsumerStatefulWidget {
  const UpdateChecker({super.key, required this.child});
  final Widget child;

  @override
  ConsumerState<UpdateChecker> createState() => _UpdateCheckerState();
}

class _UpdateCheckerState extends ConsumerState<UpdateChecker> {
  static bool _checkedThisSession = false;

  @override
  void initState() {
    super.initState();
    if (_checkedThisSession) return;
    _checkedThisSession = true;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final release = await ref.read(availableUpdateProvider.future);
      if (release != null && mounted) await showUpdateDialog(context, release);
    });
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
