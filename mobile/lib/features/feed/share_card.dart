import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/widgets/common.dart';
import '../auth/auth_controller.dart';
import '../communities/communities_repository.dart';
import '../communities/models.dart';
import '../communities/widgets.dart';
import '../runs/runs_repository.dart';
import '../runs/track.dart';

/// Ukuran Instagram Story (9:16).
const shareCardWidth = 1080;
const shareCardHeight = 1920;

/// Data kartu hasil lari. [route] WAJIB rute publik (setelah zona privasi), bukan rute utuh.
class ShareCardData {
  const ShareCardData({
    required this.title,
    required this.startedAt,
    required this.distanceM,
    required this.movingTimeS,
    required this.avgPaceSPerKm,
    required this.route,
    this.communityName,
    this.logo,
  });
  final String title;
  final DateTime startedAt;
  final int distanceM;
  final int movingTimeS;
  final int? avgPaceSPerKm;
  final RunRoute route;
  final String? communityName;

  /// Logo komunitas (byte gambar), opsional.
  final Uint8List? logo;
}

/// Proyeksikan rute (lat, lng) ke dalam [box], mempertahankan rasio (equirectangular, cukup untuk skala kota).
List<List<Offset>> projectRoute(RunRoute route, Rect box) {
  final pts = route.expand((s) => s).toList();
  if (pts.isEmpty) return const [];
  var minLat = pts.first.$1, maxLat = minLat, minLng = pts.first.$2, maxLng = minLng;
  for (final (lat, lng) in pts) {
    minLat = math.min(minLat, lat);
    maxLat = math.max(maxLat, lat);
    minLng = math.min(minLng, lng);
    maxLng = math.max(maxLng, lng);
  }
  final kx = math.cos((minLat + maxLat) / 2 * math.pi / 180);
  final w = math.max((maxLng - minLng) * kx, 1e-9);
  final h = math.max(maxLat - minLat, 1e-9);
  final scale = math.min(box.width / w, box.height / h);
  final dx = box.left + (box.width - w * scale) / 2;
  final dy = box.top + (box.height - h * scale) / 2;
  return [
    for (final seg in route)
      [for (final (lat, lng) in seg) Offset(dx + (lng - minLng) * kx * scale, dy + (maxLat - lat) * scale)],
  ];
}

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

/// Gambar kartu 1080x1920 sebagai PNG. Dibuat sepenuhnya di HP; tidak ada yang dikirim ke server.
Future<Uint8List> renderShareCard(ShareCardData d) async {
  final recorder = ui.PictureRecorder();
  final size = Size(shareCardWidth.toDouble(), shareCardHeight.toDouble());
  final canvas = Canvas(recorder, Offset.zero & size);

  canvas.drawRect(
    Offset.zero & size,
    Paint()
      ..shader = ui.Gradient.linear(Offset.zero, Offset(0, size.height), const [Color(0xFFF0590E), Color(0xFF1B1B1F)], const [0, 0.85]),
  );

  void text(String s, double x, double y, double fontSize, {FontWeight weight = FontWeight.w600, double maxWidth = 900, Color color = Colors.white}) {
    final tp = TextPainter(
      text: TextSpan(text: s, style: TextStyle(color: color, fontSize: fontSize, fontWeight: weight)),
      textDirection: TextDirection.ltr,
      maxLines: 2,
      ellipsis: '…',
    )..layout(maxWidth: maxWidth);
    tp.paint(canvas, Offset(x, y));
  }

  // Kepala: logo dan nama komunitas (atau PaceTara).
  var headerX = 90.0;
  if (d.logo != null) {
    try {
      final codec = await ui.instantiateImageCodec(d.logo!, targetWidth: 180, targetHeight: 180);
      final img = (await codec.getNextFrame()).image;
      final rect = const Rect.fromLTWH(90, 120, 180, 180);
      canvas.save();
      canvas.clipRRect(RRect.fromRectAndRadius(rect, const Radius.circular(40)));
      canvas.drawImageRect(img, Offset.zero & Size(img.width.toDouble(), img.height.toDouble()), rect, Paint());
      canvas.restore();
      headerX = 300;
    } catch (_) {
      // logo rusak: kartu tetap dibuat tanpa logo
    }
  }
  text(d.communityName ?? 'PaceTara', headerX, 150, 60, weight: FontWeight.w800, maxWidth: 1080 - headerX - 90);
  if (d.communityName != null) text('bersama PaceTara', headerX, 230, 38, weight: FontWeight.w400, color: Colors.white70);

  // Rute publik.
  final box = const Rect.fromLTWH(140, 400, 800, 760);
  final routePaint = Paint()
    ..color = Colors.white
    ..style = PaintingStyle.stroke
    ..strokeWidth = 12
    ..strokeCap = StrokeCap.round
    ..strokeJoin = StrokeJoin.round;
  for (final seg in projectRoute(d.route, box)) {
    if (seg.length < 2) continue;
    final path = Path()..moveTo(seg.first.dx, seg.first.dy);
    for (final p in seg.skip(1)) {
      path.lineTo(p.dx, p.dy);
    }
    canvas.drawPath(path, routePaint);
  }

  // Statistik.
  text('${formatDistanceKm(d.distanceM.toDouble())} km', 90, 1230, 150, weight: FontWeight.w900);
  text('Waktu', 90, 1440, 40, weight: FontWeight.w400, color: Colors.white70);
  text(formatDuration(d.movingTimeS), 90, 1490, 72, weight: FontWeight.w800);
  text('Pace', 560, 1440, 40, weight: FontWeight.w400, color: Colors.white70);
  text('${formatPaceS(d.avgPaceSPerKm?.toDouble())} /km', 560, 1490, 72, weight: FontWeight.w800, maxWidth: 440);
  final t = d.startedAt;
  text('${d.title} · ${t.day} ${_months[t.month - 1]} ${t.year}', 90, 1640, 44, weight: FontWeight.w500, color: Colors.white70);
  text('PaceTara', 90, 1790, 40, weight: FontWeight.w800, color: Colors.white54);

  final image = await recorder.endRecording().toImage(shareCardWidth, shareCardHeight);
  final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
  return bytes!.buffer.asUint8List();
}

/// Bagikan kartu hasil lari milik sendiri lewat share sheet Android (mis. Instagram Story).
/// Hanya rute publik yang digambar; pengguna memilih logo komunitas (opsional).
Future<void> shareRunCard(BuildContext context, WidgetRef ref, RunDetail run) async {
  if (!run.isOwner) return;
  final community = await showModalBottomSheet<_CommunityChoice>(
    context: context,
    showDragHandle: true,
    builder: (_) => const _CommunityPicker(),
  );
  if (community == null || !context.mounted) return;
  try {
    Uint8List? logo;
    final url = community.community?.logoUrl;
    if (url != null) {
      final b = await ref.read(avatarBytesProvider(url).future);
      if (b != null) logo = Uint8List.fromList(b);
    }
    final png = await renderShareCard(ShareCardData(
      title: run.summary.title,
      startedAt: run.summary.startedAt,
      distanceM: run.summary.distanceM,
      movingTimeS: run.summary.movingTimeS,
      avgPaceSPerKm: run.summary.avgPaceSPerKm,
      // Pemilik menerima rute utuh dan rute publik; kartu SELALU memakai rute publik.
      route: run.publicRoute ?? const [],
      communityName: community.community?.name,
      logo: logo,
    ));
    final file = File('${(await getTemporaryDirectory()).path}/pacetara-lari-${DateTime.now().millisecondsSinceEpoch}.png');
    await file.writeAsBytes(png, flush: true);
    try {
      await SharePlus.instance.share(ShareParams(files: [XFile(file.path, mimeType: 'image/png')]));
    } finally {
      if (file.existsSync()) await file.delete();
    }
  } catch (e) {
    if (context.mounted) showError(context, e);
  }
}

class _CommunityChoice {
  const _CommunityChoice(this.community);
  final CommunitySummary? community;
}

class _CommunityPicker extends ConsumerWidget {
  const _CommunityPicker();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final mine = ref.watch(myCommunitiesProvider).value?.items ?? const <CommunitySummary>[];
    return SafeArea(
      child: ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(16, 0, 16, 16), children: [
        Text('Kartu hasil lari', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 4),
        Text('Pilih logo komunitas untuk kartu. Rute digambar tanpa area zona privasi.', style: Theme.of(context).textTheme.bodySmall),
        for (final c in mine)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: CommunityLogo(name: c.name, logoUrl: c.logoUrl, size: 40),
            title: Text(c.name),
            onTap: () => Navigator.pop(context, _CommunityChoice(c)),
          ),
        ListTile(
          key: const Key('share-no-community'),
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.directions_run),
          title: const Text('Tanpa komunitas'),
          onTap: () => Navigator.pop(context, const _CommunityChoice(null)),
        ),
      ]),
    );
  }
}
