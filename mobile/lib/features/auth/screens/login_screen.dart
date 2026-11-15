import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_error.dart';
import '../../../core/config.dart';
import '../../../core/widgets/brand.dart';
import '../../../core/widgets/common.dart';
import '../../../core/widgets/motion.dart';
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

    final top = MediaQuery.paddingOf(context).top;

    return Scaffold(
      body: SingleChildScrollView(
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          // Header gradien dengan logo yang memantul masuk.
          SizedBox(
            height: 300 + top,
            child: BrandBackdrop(
              borderRadius: const BorderRadius.vertical(bottom: Radius.circular(36)),
              child: Padding(
                padding: EdgeInsets.fromLTRB(28, top + 32, 28, 56),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  TweenAnimationBuilder<double>(
                    tween: Tween(begin: 0, end: 1),
                    duration: const Duration(milliseconds: 800),
                    curve: Curves.elasticOut,
                    builder: (context, v, child) => Transform.scale(scale: 0.5 + 0.5 * v, alignment: Alignment.centerLeft, child: child),
                    child: const BrandMark(size: 64, onGradient: true),
                  ),
                  const Spacer(),
                  FadeSlideIn(
                    index: 1,
                    child: Text('PaceTara', style: theme.textTheme.displaySmall?.copyWith(color: Colors.white)),
                  ),
                  const SizedBox(height: 4),
                  FadeSlideIn(
                    index: 2,
                    child: Text(
                      'Komunitas lari Indonesia',
                      style: theme.textTheme.titleMedium?.copyWith(color: Colors.white.withValues(alpha: 0.9), fontWeight: FontWeight.w500),
                    ),
                  ),
                ]),
              ),
            ),
          ),
          // Kartu formulir menumpang di bawah header.
          Transform.translate(
            offset: const Offset(0, -36),
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 480),
                child: FadeSlideIn(
                  index: 3,
                  offset: 40,
                  child: Container(
                    margin: const EdgeInsets.symmetric(horizontal: 20),
                    padding: const EdgeInsets.fromLTRB(20, 24, 20, 12),
                    decoration: BoxDecoration(
                      color: theme.colorScheme.surface,
                      borderRadius: BorderRadius.circular(28),
                      boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.08), blurRadius: 32, offset: const Offset(0, 12))],
                    ),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                      Text('Masuk ke akunmu', style: theme.textTheme.titleLarge),
                      const SizedBox(height: 4),
                      Text('Lanjutkan lari bareng teman komunitas.', style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
                      const SizedBox(height: 20),
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
                                decoration: const InputDecoration(labelText: 'Email', prefixIcon: Icon(Icons.alternate_email_rounded)),
                              ),
                              const SizedBox(height: 14),
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
                        const SizedBox(height: 16),
                        Row(children: [
                          const Expanded(child: Divider()),
                          Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 12),
                            child: Text('atau', style: theme.textTheme.labelMedium),
                          ),
                          const Expanded(child: Divider()),
                        ]),
                        const SizedBox(height: 16),
                        AsyncButton(label: 'Masuk dengan Google', outlined: true, onPressed: _google),
                      ],
                      const SizedBox(height: 4),
                    ]),
                  ),
                ),
              ),
            ),
          ),
          FadeSlideIn(
            index: 5,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Text('Belum punya akun?'),
                TextButton(onPressed: () => context.push('/register'), child: const Text('Daftar')),
              ],
            ),
          ),
          SizedBox(height: MediaQuery.paddingOf(context).bottom + 16),
        ]),
      ),
    );
  }
}
