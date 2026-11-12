import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

/// Aset merek Strava resmi (developers.strava.com/guidelines), dipakai apa adanya: tidak diubah warna, bentuk,
/// atau dianimasikan. Tombol "Connect with Strava" setinggi 48 dp (PNG 1x dan 2x dari Strava).
const stravaConnectAsset = 'assets/strava/btn_strava_connect_with_orange.png';
const _poweredByOrange = 'assets/strava/api_logo_pwrdBy_strava_horiz_orange.png';
const _poweredByWhite = 'assets/strava/api_logo_pwrdBy_strava_horiz_white.png';

/// Warna tautan "View on Strava" menurut pedoman.
const stravaOrange = Color(0xFFFC5200);

/// Tombol resmi "Connect with Strava" yang membuka OAuth Strava.
class StravaConnectButton extends StatefulWidget {
  const StravaConnectButton({super.key, required this.onPressed});
  final Future<void> Function() onPressed;

  @override
  State<StravaConnectButton> createState() => _StravaConnectButtonState();
}

class _StravaConnectButtonState extends State<StravaConnectButton> {
  bool _busy = false;

  Future<void> _tap() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await widget.onPressed();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: 'Connect with Strava',
      child: Opacity(
        opacity: _busy ? 0.6 : 1,
        child: InkWell(
          key: const Key('strava-connect'),
          onTap: _busy ? null : _tap,
          borderRadius: BorderRadius.circular(4),
          child: Image.asset(stravaConnectAsset, height: 48, excludeFromSemantics: true),
        ),
      ),
    );
  }
}

/// Logo "Powered by Strava": oranye di tema terang, putih di tema gelap. Tidak lebih menonjol dari nama aplikasi.
class PoweredByStrava extends StatelessWidget {
  const PoweredByStrava({super.key});

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Semantics(
      label: 'Powered by Strava',
      child: Image.asset(dark ? _poweredByWhite : _poweredByOrange, height: 18, excludeFromSemantics: true),
    );
  }
}

/// Tautan "View on Strava" ke aktivitas asli (tebal, oranye #FC5200, sesuai pedoman).
class ViewOnStravaLink extends StatelessWidget {
  const ViewOnStravaLink({super.key, required this.url});
  final String url;

  @override
  Widget build(BuildContext context) {
    final uri = Uri.parse(url);
    // Hanya tautan https ke strava.com yang dibuka.
    if (uri.scheme != 'https' || uri.host != 'www.strava.com') return const SizedBox.shrink();
    return InkWell(
      onTap: () => launchUrl(uri, mode: LaunchMode.externalApplication),
      child: const Padding(
        padding: EdgeInsets.symmetric(vertical: 8),
        child: Text(
          'View on Strava',
          style: TextStyle(color: stravaOrange, fontWeight: FontWeight.bold, decoration: TextDecoration.underline, decorationColor: stravaOrange),
        ),
      ),
    );
  }
}
