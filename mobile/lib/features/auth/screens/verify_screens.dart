import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/widgets/common.dart';
import '../auth_controller.dart';
import '../models.dart';

/// Langkah 1 dari Level 1: verifikasi email dengan kode.
class VerifyEmailScreen extends ConsumerStatefulWidget {
  const VerifyEmailScreen({super.key});

  @override
  ConsumerState<VerifyEmailScreen> createState() => _VerifyEmailScreenState();
}

class _VerifyEmailScreenState extends ConsumerState<VerifyEmailScreen> {
  final _code = TextEditingController();

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _verify() async {
    if (_code.text.length != 6) throw const FormatException('Masukkan 6 angka');
    await ref.read(authControllerProvider.notifier).verifyEmail(_code.text);
  }

  @override
  Widget build(BuildContext context) {
    final email = ref.watch(authControllerProvider).value?.email ?? '';
    final auth = ref.read(authControllerProvider.notifier);
    return FormPage(
      title: 'Verifikasi email',
      showBack: false,
      children: [
        const _StepHeader(step: 1),
        Text('Kami mengirim kode 6 angka ke $email. Kode berlaku 10 menit.'),
        const SizedBox(height: 24),
        CodeField(controller: _code, onCompleted: (_) => _verify().catchError((Object e) {
            if (mounted) showError(this.context, e);
          })),
        const SizedBox(height: 16),
        AsyncButton(label: 'Verifikasi', onPressed: _verify),
        ResendButton(onResend: auth.sendEmailCode),
        TextButton(onPressed: auth.logout, child: const Text('Keluar dan pakai email lain')),
      ],
    );
  }
}

/// Langkah 2 dari Level 1: verifikasi nomor HP (WhatsApp, cadangan email).
class VerifyPhoneScreen extends ConsumerStatefulWidget {
  const VerifyPhoneScreen({super.key});

  @override
  ConsumerState<VerifyPhoneScreen> createState() => _VerifyPhoneScreenState();
}

class _VerifyPhoneScreenState extends ConsumerState<VerifyPhoneScreen> {
  final _form = GlobalKey<FormState>();
  final _phone = TextEditingController();
  final _code = TextEditingController();
  OtpChannel? _sentVia;

  @override
  void dispose() {
    _phone.dispose();
    _code.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    if (!_form.currentState!.validate()) return;
    final channel = await ref.read(authControllerProvider.notifier).sendPhoneCode(_phone.text.trim());
    setState(() => _sentVia = channel);
  }

  Future<void> _verify() async {
    if (_code.text.length != 6) throw const FormatException('Masukkan 6 angka');
    await ref.read(authControllerProvider.notifier).verifyPhone(_code.text);
  }

  @override
  Widget build(BuildContext context) {
    final auth = ref.read(authControllerProvider.notifier);
    final sent = _sentVia;
    return FormPage(
      title: 'Verifikasi nomor HP',
      showBack: false,
      children: [
        const _StepHeader(step: 2),
        const Text('Nomor HP dipakai untuk keamanan akun dan tidak ditampilkan ke pengguna lain.'),
        const SizedBox(height: 24),
        Form(
          key: _form,
          child: TextFormField(
            controller: _phone,
            enabled: sent == null,
            keyboardType: TextInputType.phone,
            autofillHints: const [AutofillHints.telephoneNumber],
            inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9+\- ]'))],
            validator: (v) {
              final digits = (v ?? '').replaceAll(RegExp(r'\D'), '');
              return digits.length < 9 || digits.length > 15 ? 'Nomor HP tidak valid' : null;
            },
            decoration: const InputDecoration(
              labelText: 'Nomor HP',
              hintText: '0812xxxxxxxx',
              border: OutlineInputBorder(),
            ),
          ),
        ),
        const SizedBox(height: 16),
        if (sent == null)
          AsyncButton(label: 'Kirim kode', onPressed: _send)
        else ...[
          Text(
            sent == OtpChannel.whatsapp
                ? 'Kode dikirim lewat WhatsApp ke nomor ini. Berlaku 5 menit.'
                : 'WhatsApp tidak bisa dipakai saat ini, jadi kode dikirim ke email kamu. Berlaku 10 menit.',
          ),
          const SizedBox(height: 16),
          CodeField(controller: _code, onCompleted: (_) => _verify().catchError((Object e) {
            if (mounted) showError(this.context, e);
          })),
          const SizedBox(height: 16),
          AsyncButton(label: 'Verifikasi', onPressed: _verify),
          ResendButton(onResend: () async {
            final channel = await auth.sendPhoneCode(_phone.text.trim());
            setState(() => _sentVia = channel);
          }),
          TextButton(
            onPressed: () => setState(() {
              _sentVia = null;
              _code.clear();
            }),
            child: const Text('Ganti nomor'),
          ),
        ],
      ],
    );
  }
}

class _StepHeader extends StatelessWidget {
  const _StepHeader({required this.step});
  final int step;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Langkah $step dari 2', style: Theme.of(context).textTheme.labelLarge),
          const SizedBox(height: 8),
          LinearProgressIndicator(value: step / 2),
        ],
      ),
    );
  }
}
