import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_error.dart';
import '../../../core/config.dart';
import '../../../core/widgets/common.dart';
import '../../moderation/moderation.dart';
import '../auth_controller.dart';
import 'privacy_consent.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _form = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _login() async {
    if (!_form.currentState!.validate()) return;
    try {
      await ref.read(authControllerProvider.notifier).login(_email.text.trim(), _password.text);
    } on ApiError catch (e) {
      if (!isAccountBlocked(e) || !mounted) rethrow;
      await showBlockedAccountDialog(context, ref, e, PasswordCredentials(_email.text.trim(), _password.text));
    }
  }

  Future<void> _google() async {
    final auth = ref.read(authControllerProvider.notifier);
    final String idToken;
    try {
      idToken = await auth.googleIdToken(); // pemilih akun Google dibuka SEKALI
    } on ApiError catch (e) {
      if (e.code == 'canceled') return;
      rethrow;
    }
    try {
      await auth.loginWithGoogle(idToken: idToken);
    } on ApiError catch (e) {
      if (isAccountBlocked(e) && mounted) return showBlockedAccountDialog(context, ref, e, GoogleCredentials(idToken));
      if (e.code != 'privacy_required' || !mounted) rethrow;
      // Akun Google baru: minta persetujuan kebijakan privasi, lalu kirim ulang token yang sama.
      final config = await ref.read(authConfigProvider.future);
      if (!mounted) return;
      final agreed = await showPrivacyConsentSheet(context, config);
      if (agreed == true) await auth.loginWithGoogle(idToken: idToken, privacyVersion: config.privacyVersion);
    }
  }

  @override
  Widget build(BuildContext context) {
    final config = ref.watch(authConfigProvider).value;
    final googleOn = (config?.googleEnabled ?? false) && AppConfig.googleServerClientId.isNotEmpty;
    final theme = Theme.of(context);

    return FormPage(
      title: 'Masuk',
      showBack: false,
      children: [
        Icon(Icons.directions_run, size: 64, color: theme.colorScheme.primary),
        const SizedBox(height: 8),
        Text('PaceTara', textAlign: TextAlign.center, style: theme.textTheme.headlineSmall),
        Text('Komunitas lari Indonesia', textAlign: TextAlign.center, style: theme.textTheme.bodyMedium),
        const SizedBox(height: 32),
        Form(
          key: _form,
          child: AutofillGroup(
            child: Column(
              children: [
                TextFormField(
                  controller: _email,
                  keyboardType: TextInputType.emailAddress,
                  autofillHints: const [AutofillHints.email],
                  validator: validateEmail,
                  decoration: const InputDecoration(labelText: 'Email', border: OutlineInputBorder()),
                ),
                const SizedBox(height: 16),
                PasswordField(
                  controller: _password,
                  validator: (v) => (v ?? '').isEmpty ? 'Kata sandi wajib diisi' : null,
                ),
              ],
            ),
          ),
        ),
        Align(
          alignment: Alignment.centerRight,
          child: TextButton(onPressed: () => context.push('/forgot-password'), child: const Text('Lupa kata sandi?')),
        ),
        AsyncButton(label: 'Masuk', onPressed: _login),
        if (googleOn) ...[
          const SizedBox(height: 12),
          AsyncButton(label: 'Masuk dengan Google', outlined: true, onPressed: _google),
        ],
        const SizedBox(height: 24),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Text('Belum punya akun?'),
            TextButton(onPressed: () => context.push('/register'), child: const Text('Daftar')),
          ],
        ),
      ],
    );
  }
}
