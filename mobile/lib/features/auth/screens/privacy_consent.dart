import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models.dart';

Future<void> openPrivacyPolicy(AuthConfig config) =>
    launchUrl(Uri.parse(config.privacyUrl), mode: LaunchMode.externalApplication);

/// Teks persetujuan dengan tautan ke kebijakan privasi.
class PrivacyConsentText extends StatefulWidget {
  const PrivacyConsentText({super.key, required this.config});
  final AuthConfig config;

  @override
  State<PrivacyConsentText> createState() => _PrivacyConsentTextState();
}

class _PrivacyConsentTextState extends State<PrivacyConsentText> {
  late final _tap = TapGestureRecognizer()..onTap = () => openPrivacyPolicy(widget.config);

  @override
  void dispose() {
    _tap.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final link = TextStyle(color: Theme.of(context).colorScheme.primary, decoration: TextDecoration.underline);
    return Text.rich(
      TextSpan(children: [
        const TextSpan(text: 'Saya sudah membaca dan menyetujui '),
        TextSpan(text: 'Kebijakan Privasi', style: link, recognizer: _tap),
        const TextSpan(text: ' PaceTara, termasuk pemrosesan email, nomor HP, dan data lari saya.'),
      ]),
    );
  }
}

/// Lembar persetujuan untuk akun Google baru. Mengembalikan true jika disetujui.
Future<bool?> showPrivacyConsentSheet(BuildContext context, AuthConfig config) {
  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    builder: (context) {
      var agreed = false;
      return StatefulBuilder(
        builder: (context, setState) => Padding(
          padding: const EdgeInsets.fromLTRB(24, 24, 24, 32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Buat akun PaceTara', style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 16),
              CheckboxListTile(
                value: agreed,
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                onChanged: (v) => setState(() => agreed = v ?? false),
                title: PrivacyConsentText(config: config),
              ),
              const SizedBox(height: 16),
              FilledButton(
                onPressed: agreed ? () => Navigator.pop(context, true) : null,
                child: const Text('Setuju dan lanjutkan'),
              ),
            ],
          ),
        ),
      );
    },
  );
}
