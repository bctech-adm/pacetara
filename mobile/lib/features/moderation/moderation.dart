import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_error.dart';
import '../../core/http/api_client.dart';
import '../../core/widgets/common.dart';

/// Alasan laporan, sama dengan server (REPORT_REASONS).
const reportReasons = <String, String>{
  'spam': 'Spam',
  'harassment': 'Pelecehan atau perundungan',
  'hate': 'Ujaran kebencian',
  'sexual': 'Konten seksual',
  'violence': 'Kekerasan atau ancaman',
  'scam': 'Penipuan',
  'impersonation': 'Menyamar sebagai orang lain',
  'other': 'Lainnya',
};

enum ReportTarget { user, community, message, event, post, comment }

/// Kirim laporan. [details] opsional, maks. 500 karakter.
Future<void> sendReport(WidgetRef ref, ReportTarget target, String targetId, String reason, String details) async {
  try {
    await ref.read(dioProvider).post<void>('/v1/reports', data: {
      'targetType': target.name,
      'targetId': targetId,
      'reason': reason,
      if (details.trim().isNotEmpty) 'details': details.trim(),
    });
  } catch (e) {
    throw ApiError.from(e);
  }
}

/// Lembar laporan: pilih alasan, keterangan opsional, kirim. Mengembalikan true jika terkirim.
Future<bool> showReportSheet(BuildContext context, WidgetRef ref, {required ReportTarget target, required String targetId, required String title}) async {
  final sent = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => ReportSheet(target: target, targetId: targetId, title: title),
  );
  if (sent == true && context.mounted) showInfo(context, 'Laporan terkirim. Terima kasih, tim kami akan meninjaunya');
  return sent == true;
}

class ReportSheet extends ConsumerStatefulWidget {
  const ReportSheet({super.key, required this.target, required this.targetId, required this.title});
  final ReportTarget target;
  final String targetId;
  final String title;

  @override
  ConsumerState<ReportSheet> createState() => _ReportSheetState();
}

class _ReportSheetState extends ConsumerState<ReportSheet> {
  String? _reason;
  final _details = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _details.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final reason = _reason;
    if (reason == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await sendReport(ref, widget.target, widget.targetId, reason, _details.text);
      if (mounted) Navigator.pop(context, true);
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.85),
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text(widget.title, style: theme.textTheme.titleLarge),
            const SizedBox(height: 4),
            Text('Pelapor tidak diberitahukan kepada orang yang dilaporkan.', style: theme.textTheme.bodySmall),
            const SizedBox(height: 8),
            RadioGroup<String>(
              groupValue: _reason,
              onChanged: (v) => setState(() => _reason = v),
              child: Column(children: [
                for (final e in reportReasons.entries)
                  RadioListTile<String>(key: Key('reason-${e.key}'), contentPadding: EdgeInsets.zero, value: e.key, title: Text(e.value)),
              ]),
            ),
            TextField(
              controller: _details,
              maxLength: 500,
              minLines: 1,
              maxLines: 4,
              decoration: const InputDecoration(labelText: 'Keterangan (opsional)', border: OutlineInputBorder()),
            ),
            if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(_error!, style: TextStyle(color: theme.colorScheme.error))),
            FilledButton(
              key: const Key('report-submit'),
              onPressed: _reason == null || _busy ? null : _submit,
              child: Text(_busy ? 'Mengirim…' : 'Kirim laporan'),
            ),
            ]),
          ),
        ),
      ),
    );
  }
}

// ---------- Banding akun ----------

/// Kredensial yang dipakai saat login ditolak; dikirim ulang bersama banding.
sealed class AppealCredentials {
  const AppealCredentials();
  Map<String, Object> toJson();
}

class PasswordCredentials extends AppealCredentials {
  const PasswordCredentials(this.email, this.password);
  final String email;
  final String password;
  @override
  Map<String, Object> toJson() => {'email': email, 'password': password};
}

class GoogleCredentials extends AppealCredentials {
  const GoogleCredentials(this.idToken);
  final String idToken;
  @override
  Map<String, Object> toJson() => {'googleIdToken': idToken};
}

bool isAccountBlocked(ApiError e) => e.code == 'account_suspended' || e.code == 'account_banned';

/// Login ditolak karena akun ditangguhkan/diblokir: jelaskan, dan tawarkan banding.
Future<void> showBlockedAccountDialog(BuildContext context, WidgetRef ref, ApiError error, AppealCredentials credentials) async {
  final appeal = await showDialog<bool>(
    context: context,
    builder: (dialog) => AlertDialog(
      title: Text(error.code == 'account_banned' ? 'Akun diblokir' : 'Akun ditangguhkan'),
      content: Text(
        error.code == 'account_banned'
            ? 'Akunmu diblokir karena melanggar aturan komunitas. Jika menurutmu ini keliru, ajukan banding.'
            : 'Akunmu ditangguhkan sementara karena laporan pelanggaran. Jika menurutmu ini keliru, ajukan banding.',
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(dialog, false), child: const Text('Tutup')),
        FilledButton(onPressed: () => Navigator.pop(dialog, true), child: const Text('Ajukan banding')),
      ],
    ),
  );
  if (appeal != true || !context.mounted) return;
  final sent = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => _AppealSheet(credentials: credentials),
  );
  if (sent == true && context.mounted) showInfo(context, 'Banding terkirim. Kami akan meninjaunya secepatnya');
}

class _AppealSheet extends ConsumerStatefulWidget {
  const _AppealSheet({required this.credentials});
  final AppealCredentials credentials;

  @override
  ConsumerState<_AppealSheet> createState() => _AppealSheetState();
}

class _AppealSheetState extends ConsumerState<_AppealSheet> {
  final _message = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _message.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_message.text.trim().length < 10) {
      setState(() => _error = 'Jelaskan minimal 10 karakter');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(bareDioProvider).post<void>('/v1/auth/appeal', data: {...widget.credentials.toJson(), 'message': _message.text.trim()});
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (mounted) setState(() => _error = ApiError.from(e).message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 0, 16, 16 + MediaQuery.viewInsetsOf(context).bottom),
      child: SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Ajukan banding', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 12),
          TextField(
            controller: _message,
            maxLength: 2000,
            minLines: 3,
            maxLines: 8,
            decoration: const InputDecoration(labelText: 'Ceritakan kenapa menurutmu ini keliru', border: OutlineInputBorder()),
          ),
          if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
          FilledButton(onPressed: _busy ? null : _submit, child: Text(_busy ? 'Mengirim…' : 'Kirim banding')),
        ]),
      ),
    );
  }
}
