import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/widgets/common.dart';
import '../auth_controller.dart';

class ForgotPasswordScreen extends ConsumerStatefulWidget {
  const ForgotPasswordScreen({super.key});

  @override
  ConsumerState<ForgotPasswordScreen> createState() => _ForgotPasswordScreenState();
}

class _ForgotPasswordScreenState extends ConsumerState<ForgotPasswordScreen> {
  final _form = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _code = TextEditingController();
  final _password = TextEditingController();
  bool _sent = false;

  @override
  void dispose() {
    _email.dispose();
    _code.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    if (validateEmail(_email.text) != null) {
      _form.currentState!.validate();
      return;
    }
    await ref.read(authControllerProvider.notifier).forgotPassword(_email.text.trim());
    setState(() => _sent = true);
  }

  Future<void> _reset() async {
    if (!_form.currentState!.validate()) return;
    await ref.read(authControllerProvider.notifier).resetPassword(_email.text.trim(), _code.text, _password.text);
    if (!mounted) return;
    showInfo(context, 'Kata sandi diganti. Silakan masuk');
    context.pop();
  }

  @override
  Widget build(BuildContext context) {
    return FormPage(
      title: 'Lupa kata sandi',
      children: [
        Form(
          key: _form,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextFormField(
                controller: _email,
                enabled: !_sent,
                keyboardType: TextInputType.emailAddress,
                validator: validateEmail,
                decoration: const InputDecoration(labelText: 'Email akun', border: OutlineInputBorder()),
              ),
              const SizedBox(height: 16),
              if (!_sent)
                AsyncButton(label: 'Kirim kode', onPressed: _send)
              else ...[
                const Text('Jika email terdaftar, kode 6 angka sudah dikirim. Berlaku 10 menit.'),
                const SizedBox(height: 16),
                CodeField(controller: _code),
                const SizedBox(height: 16),
                PasswordField(controller: _password, label: 'Kata sandi baru', newPassword: true, validator: validateNewPassword),
                const SizedBox(height: 16),
                AsyncButton(label: 'Simpan kata sandi baru', onPressed: _reset),
                const SizedBox(height: 8),
                const Text('Setelah diganti, kamu akan keluar dari semua perangkat.'),
              ],
            ],
          ),
        ),
      ],
    );
  }
}
