import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/http/api_client.dart';
import '../auth/auth_controller.dart';

/// Banner sponsor (modul 3.3) yang dikembalikan server untuk satu slot.
class SponsorBannerData {
  const SponsorBannerData({required this.id, required this.title, required this.imageUrl, this.eventId, required this.hasLink});
  final String id;
  final String title;
  final String imageUrl;
  final String? eventId;
  final bool hasLink;

  static SponsorBannerData? fromJson(Object? j) {
    if (j is! Map<String, dynamic>) return null;
    return SponsorBannerData(
      id: j['id'] as String,
      title: j['title'] as String,
      imageUrl: j['imageUrl'] as String,
      eventId: j['eventId'] as String?,
      hasLink: j['hasLink'] as bool? ?? false,
    );
  }
}

typedef BannerQuery = ({String slot, String? city, String? eventId});

/// Satu banner per slot + kota (+ event untuk detail event). Kota dikirim di body, bukan URL. Server tidak mengirim
/// banner untuk Premium (tanpa iklan); aplikasi juga tidak meminta jika profil berkata tanpa iklan.
final sponsorBannerProvider = FutureProvider.autoDispose.family<(SponsorBannerData, Uint8List)?, BannerQuery>((ref, q) async {
  final profile = ref.watch(authControllerProvider).value;
  if (profile == null || !profile.ads) return null;
  final dio = ref.watch(dioProvider);
  try {
    final res = await dio.post<Map<String, dynamic>>('/v1/banners/pick', data: {'slot': q.slot, 'city': ?q.city, 'eventId': ?q.eventId});
    final b = SponsorBannerData.fromJson(res.data?['banner']);
    if (b == null) return null;
    final img = await dio.get<List<int>>(b.imageUrl, options: Options(responseType: ResponseType.bytes));
    if (img.data == null) return null;
    return (b, Uint8List.fromList(img.data!));
  } catch (_) {
    // Banner tidak penting: gagal = slot kosong tanpa pesan.
    return null;
  }
});

/// Slot banner sponsor. Tidak memakan tempat sampai banner termuat. Ditandai "Sponsor" dan diketuk membuka event
/// (di aplikasi) atau tautan https (browser luar). Tayangan dicatat sekali per tampil.
class SponsorBanner extends ConsumerStatefulWidget {
  const SponsorBanner({super.key, required this.slot, this.city, this.eventId, this.padding = const EdgeInsets.symmetric(horizontal: 16, vertical: 8)});
  final String slot;
  final String? city;
  final String? eventId;
  final EdgeInsets padding;

  @override
  ConsumerState<SponsorBanner> createState() => _SponsorBannerState();
}

class _SponsorBannerState extends ConsumerState<SponsorBanner> {
  String? _counted;

  Future<void> _impression(String id) async {
    if (!mounted) return;
    try {
      await ref.read(dioProvider).post<void>('/v1/banners/$id/impression');
    } catch (_) {
      // Statistik tidak penting bagi pengguna.
    }
  }

  Future<void> _tap(SponsorBannerData b) async {
    try {
      final res = await ref.read(dioProvider).post<Map<String, dynamic>>('/v1/banners/${b.id}/click');
      final eventId = res.data?['eventId'] as String?;
      final url = res.data?['url'] as String?;
      if (!mounted) return;
      if (eventId != null) {
        context.push('/events/$eventId');
      } else if (url != null) {
        final uri = Uri.tryParse(url);
        if (uri != null && uri.scheme == 'https') await launchUrl(uri, mode: LaunchMode.externalApplication);
      }
    } catch (_) {
      // abaikan
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = (slot: widget.slot, city: widget.city, eventId: widget.eventId);
    final data = ref.watch(sponsorBannerProvider(q)).value;
    if (data == null) return const SizedBox.shrink();
    final (b, bytes) = data;
    if (_counted != b.id) {
      _counted = b.id;
      // Dicatat setelah frame tergambar (banner benar-benar tampil), bukan di dalam build.
      WidgetsBinding.instance.addPostFrameCallback((_) => _impression(b.id));
    }
    return Padding(
      padding: widget.padding,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Sponsor', style: Theme.of(context).textTheme.labelSmall),
        const SizedBox(height: 4),
        Semantics(
          label: 'Banner sponsor: ${b.title}',
          button: b.hasLink,
          child: InkWell(
            key: const Key('sponsor-banner'),
            onTap: b.hasLink ? () => _tap(b) : null,
            borderRadius: BorderRadius.circular(12),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(12),
              child: AspectRatio(aspectRatio: 3, child: Image.memory(bytes, fit: BoxFit.cover, gaplessPlayback: true)),
            ),
          ),
        ),
      ]),
    );
  }
}
