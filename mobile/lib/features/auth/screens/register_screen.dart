import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/widgets/common.dart';
import '../auth_controller.dart';
import 'privacy_consent.dart';

class RegisterScreen extends ConsumerStatefulWidget {
  const RegisterScreen({super.key});

  @override
  ConsumerState<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends ConsumerState<RegisterScreen> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _agreed = false;

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    final config = await ref.read(authConfigProvider.future);
    await ref.read(authControllerProvider.notifier).register(
          email: _email.text.trim(),
          password: _password.text,
          displayName: _name.text.trim(),
          privacyVersion: config.privacyVersion,
        );
    // Router otomatis pindah ke layar verifikasi email.
  }

  @override
  Widget build(BuildContext context) {
    final config = ref.watch(authConfigProvider);
    return FormPage(
      title: 'Daftar',
      children: [
        Form(
          key: _form,
          child: AutofillGroup(
            child: Column(
              children: [
                TextFormField(
                  controller: _name,
                  textCapitalization: TextCapitalization.words,
                  autofillHints: const [AutofillHints.name],
                  maxLength: 60,
                  validator: (v) => (v ?? '').trim().isEmpty ? 'Nama wajib diisi' : null,
                  decoration: const InputDecoration(labelText: 'Nama', border: OutlineInputBorder()),
                ),
                const SizedBox(height: 8),
                TextFormField(
                  controller: _email,
                  keyboardType: TextInputType.emailAddress,
                  autofillHints: const [AutofillHints.email],
                  validator: validateEmail,
                  decoration: const InputDecoration(labelText: 'Email', border: OutlineInputBorder()),
                ),
                const SizedBox(height: 16),
                PasswordField(controller: _password, newPassword: true, validator: validateNewPassword),
              ],
            ),
          ),
        ),
        const SizedBox(height: 16),
        config.when(
          loading: () => const LinearProgressIndicator(),
          error: (e, _) => const Text('Gagal memuat kebijakan privasi. Periksa koneksi lalu coba lagi.'),
          data: (c) => CheckboxListTile(
            value: _agreed,
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            onChanged: (v) => setState(() => _agreed = v ?? false),
            title: PrivacyConsentText(config: c),
          ),
        ),
        const SizedBox(height: 16),
        AsyncButton(label: 'Buat akun', onPressed: _agreed && config.hasValue ? _submit : null),
      ],
    );
  }
}
