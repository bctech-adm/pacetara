import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/config.dart';
import '../auth/auth_controller.dart';
import 'gma_ad_view.dart';

/// Iklan AdMob (modul 2.7). Hanya dua tempat yang boleh menampilkan iklan: feed (tab Feed) dan daftar event.
/// Tidak ada iklan layar penuh (interstitial / app open / rewarded), dan tidak ada slot di layar rekam lari,
/// chat, SOS, langganan, atau profil pengguna lain. Struktur ini dijaga tes (`test/ads_test.dart`).
enum AdPlacement { feed, events }

enum AdFormat { native, banner }

class AdUnit {
  const AdUnit(this.id, this.format);
  final String id;
  final AdFormat format;

  @override
  bool operator ==(Object other) => other is AdUnit && other.id == id && other.format == format;

  @override
  int get hashCode => Object.hash(id, format);
}

/// Unit uji resmi Google (publik, tidak menghasilkan pendapatan). Hanya dipakai di build debug.
const testNativeUnit = 'ca-app-pub-3940256099942544/2247696110';
const testBannerUnit = 'ca-app-pub-3940256099942544/9214589741';

final _unitPattern = RegExp(r'^ca-app-pub-\d{10,20}/\d{6,12}$');

/// Pemetaan tempat → unit iklan dari `--dart-define`.
class AdUnits {
  const AdUnits({this.nativeFeed = '', this.bannerFeed = '', this.bannerEvents = '', this.useTestUnits = false});

  factory AdUnits.fromEnvironment() => const AdUnits(
        nativeFeed: AppConfig.admobNativeFeed,
        bannerFeed: AppConfig.admobBannerFeed,
        bannerEvents: AppConfig.admobBannerEvents,
        useTestUnits: kDebugMode,
      );

  final String nativeFeed;
  final String bannerFeed;
  final String bannerEvents;

  /// Build debug: tempat tanpa ID memakai unit uji Google. Build rilis: tanpa ID = tanpa iklan.
  final bool useTestUnits;

  /// Unit untuk [placement], atau null = slot tidak dirender sama sekali. ID yang formatnya salah diabaikan.
  AdUnit? unitFor(AdPlacement placement) {
    AdUnit? valid(String id, AdFormat f) => _unitPattern.hasMatch(id.trim()) ? AdUnit(id.trim(), f) : null;
    switch (placement) {
      case AdPlacement.feed:
        return valid(nativeFeed, AdFormat.native) ??
            valid(bannerFeed, AdFormat.banner) ??
            (useTestUnits ? const AdUnit(testNativeUnit, AdFormat.native) : null);
      case AdPlacement.events:
        return valid(bannerEvents, AdFormat.banner) ?? (useTestUnits ? const AdUnit(testBannerUnit, AdFormat.banner) : null);
    }
  }
}

/// Kerapatan iklan: satu slot setelah item ke-[first], lalu setiap [every] item.
class AdCadence {
  const AdCadence({required this.first, required this.every});
  final int first;
  final int every;

  /// Apakah slot iklan ditaruh tepat setelah item berindeks [index] (mulai 0).
  bool after(int index) {
    final n = index + 1;
    return n >= first && (n - first) % every == 0;
  }

  static const feed = AdCadence(first: 4, every: 8);
  static const events = AdCadence(first: 5, every: 10);
}

final adUnitsProvider = Provider<AdUnits>((ref) => AdUnits.fromEnvironment());

/// Iklan boleh tampil hanya jika server berkata demikian (`ads` di `/v1/me`, dari paket yang dihitung server).
/// Belum masuk, masih memuat, atau galat = tanpa iklan. Berubah otomatis saat profil dimuat ulang (mis. setelah
/// membeli Premium): slot hilang dan iklannya dibuang.
final adsAllowedProvider = Provider<bool>((ref) => ref.watch(authControllerProvider.select((s) => s.value?.ads ?? false)));

/// Pembuat tampilan iklan. Bawaan memakai SDK Google Mobile Ads; tes menggantinya dengan widget palsu
/// sehingga SDK tidak pernah dipanggil di tes.
typedef AdViewBuilder = Widget Function(AdUnit unit);
final adViewBuilderProvider = Provider<AdViewBuilder>((ref) => (unit) => GmaAdView(key: ValueKey(unit), unit: unit));

/// Slot iklan di dalam daftar. Tidak merender apa pun (dan tidak menyentuh SDK) untuk Premium, sebelum status
/// paket diketahui, atau bila unit iklan tidak dikonfigurasi. SDK baru diinisialisasi saat slot pertama dibangun.
class AdSlot extends ConsumerWidget {
  const AdSlot({super.key, required this.placement});
  final AdPlacement placement;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final unit = ref.watch(adUnitsProvider).unitFor(placement);
    if (unit == null) return const SizedBox.shrink();
    if (!ref.watch(adsAllowedProvider)) return const SizedBox.shrink();
    return ref.watch(adViewBuilderProvider)(unit);
  }
}

/// Ajakan ringan di bawah iklan yang berhasil dimuat (iklan internal, PRD 2.5).
class RemoveAdsHint extends StatelessWidget {
  const RemoveAdsHint({super.key});

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerRight,
      child: TextButton(
        key: const Key('remove-ads'),
        style: TextButton.styleFrom(visualDensity: VisualDensity.compact, textStyle: Theme.of(context).textTheme.bodySmall),
        onPressed: () => context.push('/subscription'),
        child: const Text('Hilangkan iklan dengan Premium'),
      ),
    );
  }
}
