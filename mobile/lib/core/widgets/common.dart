import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/api_error.dart';

void showError(BuildContext context, Object error) {
  final message = ApiError.from(error).message;
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message)));
}

void showInfo(BuildContext context, String message) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message)));
}

/// Tombol yang menampilkan indikator memuat selama [onPressed] berjalan dan menampilkan galatnya.
class AsyncButton extends StatefulWidget {
  const AsyncButton({super.key, required this.label, required this.onPressed, this.outlined = false});

  final String label;
  final Future<void> Function()? onPressed;
  final bool outlined;

  @override
  State<AsyncButton> createState() => _AsyncButtonState();
}

class _AsyncButtonState extends State<AsyncButton> {
  bool _busy = false;

  Future<void> _run() async {
    setState(() => _busy = true);
    try {
      await widget.onPressed!();
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final child = _busy
        ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
        : Text(widget.label);
    final onPressed = _busy || widget.onPressed == null ? null : _run;
    final style = ButtonStyle(minimumSize: WidgetStateProperty.all(const Size.fromHeight(48)));
    return widget.outlined
        ? OutlinedButton(style: style, onPressed: onPressed, child: child)
        : FilledButton(style: style, onPressed: onPressed, child: child);
  }
}

/// Kolom kode verifikasi 6 angka.
class CodeField extends StatelessWidget {
  const CodeField({super.key, required this.controller, this.onCompleted});

  final TextEditingController controller;
  final ValueChanged<String>? onCompleted;

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      keyboardType: TextInputType.number,
      textAlign: TextAlign.center,
      autofillHints: const [AutofillHints.oneTimeCode],
      maxLength: 6,
      style: Theme.of(context).textTheme.headlineMedium?.copyWith(letterSpacing: 12),
      inputFormatters: [FilteringTextInputFormatter.digitsOnly],
      decoration: const InputDecoration(counterText: '', hintText: '••••••', border: OutlineInputBorder()),
      onChanged: (v) {
        if (v.length == 6) onCompleted?.call(v);
      },
    );
  }
}

/// Tombol "Kirim ulang" dengan hitung mundur.
class ResendButton extends StatefulWidget {
  const ResendButton({super.key, required this.onResend, this.initialSeconds = 60});

  final Future<void> Function() onResend;
  final int initialSeconds;

  @override
  State<ResendButton> createState() => _ResendButtonState();
}

class _ResendButtonState extends State<ResendButton> {
  late int _left = widget.initialSeconds;
  Timer? _timer;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _start();
  }

  void _start() {
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return;
      setState(() => _left = _left > 0 ? _left - 1 : 0);
      if (_left == 0) t.cancel();
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return TextButton(
      onPressed: _left > 0 || _busy
          ? null
          : () async {
              setState(() => _busy = true);
              try {
                await widget.onResend();
                if (mounted) showInfo(this.context, 'Kode baru dikirim');
                _left = widget.initialSeconds;
                _start();
              } catch (e) {
                if (mounted) showError(this.context, e);
              } finally {
                if (mounted) setState(() => _busy = false);
              }
            },
      child: Text(_left > 0 ? 'Kirim ulang dalam $_left dtk' : 'Kirim ulang kode'),
    );
  }
}

class PasswordField extends StatefulWidget {
  const PasswordField({super.key, required this.controller, this.label = 'Kata sandi', this.validator, this.newPassword = false});

  final TextEditingController controller;
  final String label;
  final FormFieldValidator<String>? validator;
  final bool newPassword;

  @override
  State<PasswordField> createState() => _PasswordFieldState();
}

class _PasswordFieldState extends State<PasswordField> {
  bool _hidden = true;

  @override
  Widget build(BuildContext context) {
    return TextFormField(
      controller: widget.controller,
      obscureText: _hidden,
      autofillHints: [widget.newPassword ? AutofillHints.newPassword : AutofillHints.password],
      validator: widget.validator,
      decoration: InputDecoration(
        labelText: widget.label,
        border: const OutlineInputBorder(),
        suffixIcon: IconButton(
          tooltip: _hidden ? 'Tampilkan' : 'Sembunyikan',
          icon: Icon(_hidden ? Icons.visibility_outlined : Icons.visibility_off_outlined),
          onPressed: () => setState(() => _hidden = !_hidden),
        ),
      ),
    );
  }
}

String? validateEmail(String? v) {
  final value = v?.trim() ?? '';
  if (value.isEmpty) return 'Email wajib diisi';
  if (!RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(value)) return 'Email tidak valid';
  return null;
}

String? validateNewPassword(String? v) {
  if ((v ?? '').length < 8) return 'Minimal 8 karakter';
  if ((v ?? '').length > 128) return 'Maksimal 128 karakter';
  return null;
}

/// Kerangka layar formulir: lebar terbatas di tablet, bisa digulir di ponsel kecil.
class FormPage extends StatelessWidget {
  const FormPage({super.key, required this.title, required this.children, this.showBack = true});

  final String title;
  final List<Widget> children;
  final bool showBack;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(title), automaticallyImplyLeading: showBack),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 480),
            child: ListView(padding: const EdgeInsets.all(24), children: children),
          ),
        ),
      ),
    );
  }
}
