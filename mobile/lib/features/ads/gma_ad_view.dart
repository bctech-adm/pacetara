import 'dart:async';

import 'package:flutter/material.dart';
import 'package:google_mobile_ads/google_mobile_ads.dart';

import 'ads.dart';

/// Inisialisasi SDK Google Mobile Ads, sekali per proses dan hanya saat slot iklan pertama dibangun (pengguna
/// Premium tidak pernah sampai ke sini). Konfigurasi permintaan dipasang sebelum `initialize`.
class GmaAds {
  GmaAds._();

  static Future<void>? _init;

  static Future<void> ensureInitialized() => _init ??= _start().catchError((Object e) {
        _init = null; // dicoba lagi di slot berikutnya
        throw e;
      });

  static Future<void> _start() async {
    await MobileAds.instance.updateRequestConfiguration(RequestConfiguration(
      // Aplikasi olahraga untuk umum (18+, di bawah 18 dengan izin wali): batasi konten iklan ke PG.
      maxAdContentRating: MaxAdContentRating.pg,
      // Tidak ditujukan untuk anak; tanpa sinyal perlakuan usia khusus (KEPUTUSAN 2.7).
      ageRestrictedTreatment: AgeRestrictedTreatment.unspecified,
    ));
    await MobileAds.instance.initialize();
  }

  /// Iklan tidak dipersonalisasi untuk semua pengguna, tanpa kata kunci/URL konten/ekstra: tidak ada data
  /// pengguna PaceTara yang dikirim ke jaringan iklan (KEPUTUSAN 2.7).
  static const request = AdRequest(nonPersonalizedAds: true);
}

/// Satu iklan (native template atau banner adaptif inline). Tidak memakan tempat sampai iklan termuat; gagal
/// memuat = tetap kosong (tanpa pesan galat dan tanpa mencoba ulang terus-menerus).
class GmaAdView extends StatefulWidget {
  const GmaAdView({super.key, required this.unit});
  final AdUnit unit;

  @override
  State<GmaAdView> createState() => _GmaAdViewState();
}

class _GmaAdViewState extends State<GmaAdView> {
  AdWithView? _ad;
  bool _started = false;
  bool _loaded = false;
  double? _bannerHeight;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    final width = (MediaQuery.sizeOf(context).width - 32).clamp(250, 600).truncate();
    final scheme = Theme.of(context).colorScheme;
    unawaited(_load(width, scheme));
  }

  Future<void> _load(int width, ColorScheme scheme) async {
    try {
      await GmaAds.ensureInitialized();
    } catch (_) {
      return;
    }
    if (!mounted) return;
    final ad = switch (widget.unit.format) {
      AdFormat.native => NativeAd(
          adUnitId: widget.unit.id,
          request: GmaAds.request,
          nativeTemplateStyle: NativeTemplateStyle(
            templateType: TemplateType.medium,
            mainBackgroundColor: scheme.surfaceContainerLow,
            cornerRadius: 12,
            callToActionTextStyle: NativeTemplateTextStyle(textColor: scheme.onPrimary, backgroundColor: scheme.primary, size: 15),
            primaryTextStyle: NativeTemplateTextStyle(textColor: scheme.onSurface, size: 15),
            secondaryTextStyle: NativeTemplateTextStyle(textColor: scheme.onSurfaceVariant, size: 13),
            tertiaryTextStyle: NativeTemplateTextStyle(textColor: scheme.onSurfaceVariant, size: 13),
          ),
          listener: NativeAdListener(onAdLoaded: _onLoaded, onAdFailedToLoad: _onFailed),
        ),
      AdFormat.banner => BannerAd(
          adUnitId: widget.unit.id,
          request: GmaAds.request,
          size: AdSize.getInlineAdaptiveBannerAdSize(width, 120),
          listener: BannerAdListener(onAdLoaded: _onLoaded, onAdFailedToLoad: _onFailed),
        ),
    };
    _ad = ad;
    await ad.load();
  }

  Future<void> _onLoaded(Ad ad) async {
    if (!mounted) return; // sudah dibuang di dispose()
    double? height;
    if (ad is BannerAd) height = (await ad.getPlatformAdSize())?.height.toDouble();
    if (!mounted) return;
    setState(() {
      _loaded = true;
      _bannerHeight = height;
    });
  }

  void _onFailed(Ad ad, LoadAdError error) {
    // Kode galat saja tidak berisi data pribadi, tetapi tidak perlu di-log.
    ad.dispose();
    if (identical(ad, _ad)) _ad = null;
  }

  @override
  void dispose() {
    _ad?.dispose();
    _ad = null;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ad = _ad;
    if (!_loaded || ad == null) return const SizedBox.shrink();
    final Widget view = ad is NativeAd
        ? ConstrainedBox(
            constraints: const BoxConstraints(minWidth: 300, minHeight: 320, maxHeight: 400),
            child: AdWidget(ad: ad),
          )
        : SizedBox(height: _bannerHeight ?? 100, child: AdWidget(ad: ad));
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Iklan', style: Theme.of(context).textTheme.labelSmall),
        const SizedBox(height: 4),
        view,
        const RemoveAdsHint(),
      ]),
    );
  }
}
