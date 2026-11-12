import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_error.dart';
import '../../core/http/api_client.dart';
import '../../core/widgets/common.dart';

/// Satu konten milikku yang diturunkan moderator (tanpa isi: isi pesan/postingan/komentar sudah dihapus).
class ContentRemoval {
  const ContentRemoval({
    required this.id,
    required this.targetType,
    required this.label,
    required this.restorable,
    required this.removedAt,
    required this.appealUntil,
    required this.canAppeal,
    required this.appealStatus,
    required this.appealNote,
    required this.restored,
  });

  final String id;
  final String targetType;
  final String? label;
  final bool restorable;
  final DateTime removedAt;
  final DateTime appealUntil;
  final bool canAppeal;

  /// null = belum dibanding; open | accepted | rejected.
  final String? appealStatus;
  final String? appealNote;
  final bool restored;

  factory ContentRemoval.fromJson(Map<String, dynamic> j) {
    final appeal = j['appeal'] as Map<String, dynamic>?;
    return ContentRemoval(
      id: j['id'] as String,
      targetType: j['targetType'] as String,
      label: j['label'] as String?,
      restorable: j['restorable'] as bool? ?? false,
      removedAt: DateTime.parse(j['removedAt'] as String).toLocal(),
      appealUntil: DateTime.parse(j['appealUntil'] as String).toLocal(),
      canAppeal: j['canAppeal'] as bool? ?? false,
      appealStatus: appeal?['status'] as String?,
      appealNote: appeal?['note'] as String?,
      restored: j['restored'] as bool? ?? false,
    );
  }

  String get typeLabel => switch (targetType) {
        'message' => 'Pesan',
        'community' => 'Komunitas',
        'event' => 'Event',
        'post' => 'Postingan',
        'listing' => 'Listing',
        'spot' => 'Spot lari',
        'comment' => 'Komentar',
        _ => 'Konten',
      };

  /// Keterangan status untuk daftar.
  String get statusText {
    if (appealStatus == 'open') return 'Banding sedang ditinjau';
    if (appealStatus == 'accepted') {
      return restored ? 'Banding diterima, konten dipulihkan' : 'Banding diterima. Isinya sudah terhapus permanen; kamu boleh mengunggahnya lagi';
    }
    if (appealStatus == 'rejected') return 'Banding ditolak${appealNote == null ? '' : ': $appealNote'}';
    if (canAppeal) return 'Bisa dibanding sampai ${appealUntil.day}/${appealUntil.month}/${appealUntil.year}';
    return 'Batas banding sudah lewat';
  }
}

final removalsProvider = FutureProvider.autoDispose<List<ContentRemoval>>((ref) async {
  try {
    final res = await ref.watch(dioProvider).get<Map<String, dynamic>>('/v1/moderation/removals');
    return (res.data!['items'] as List<dynamic>).map((e) => ContentRemoval.fromJson(e as Map<String, dynamic>)).toList();
  } catch (e) {
    throw ApiError.from(e);
  }
});

/// Layar "Konten yang diturunkan": daftar penurunan 90 hari terakhir dan banding (sekali, dalam 14 hari).
class RemovalsScreen extends ConsumerWidget {
  const RemovalsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(removalsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Konten yang diturunkan')),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(removalsProvider.future),
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: switch (list) {
            AsyncData(:final value) when value.isEmpty => const [
                Padding(padding: EdgeInsets.only(top: 48), child: Center(child: Text('Tidak ada kontenmu yang diturunkan.'))),
              ],
            AsyncData(:final value) => [
                const Text('Konten yang melanggar aturan komunitas diturunkan tim moderasi. Kamu bisa mengajukan banding sekali, '
                    'paling lambat 14 hari setelah diturunkan.'),
                const SizedBox(height: 12),
                for (final r in value)
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(r.label == null ? r.typeLabel : '${r.typeLabel}: ${r.label}', style: Theme.of(context).textTheme.titleMedium),
                        const SizedBox(height: 4),
                        Text('Diturunkan ${r.removedAt.day}/${r.removedAt.month}/${r.removedAt.year}', style: Theme.of(context).textTheme.bodySmall),
                        const SizedBox(height: 8),
                        Text(r.statusText),
                        if (r.canAppeal) ...[
                          const SizedBox(height: 12),
                          AsyncButton(label: 'Ajukan banding', onPressed: () => _appeal(context, ref, r)),
                        ],
                      ]),
                    ),
                  ),
              ],
            AsyncError(:final error) => [Text(ApiError.from(error).message)],
            _ => const [Center(child: CircularProgressIndicator())],
          },
        ),
      ),
    );
  }

  Future<void> _appeal(BuildContext context, WidgetRef ref, ContentRemoval r) async {
    final message = await showDialog<String>(context: context, builder: (_) => const _AppealDialog());
    if (message == null || !context.mounted) return;
    try {
      await ref.read(dioProvider).post<void>('/v1/moderation/removals/${r.id}/appeal', data: {'message': message});
      if (context.mounted) showInfo(context, 'Banding terkirim. Kamu akan diberi tahu hasilnya');
    } catch (e) {
      if (context.mounted) showError(context, ApiError.from(e));
    }
    ref.invalidate(removalsProvider);
  }
}

class _AppealDialog extends StatefulWidget {
  const _AppealDialog();

  @override
  State<_AppealDialog> createState() => _AppealDialogState();
}

class _AppealDialogState extends State<_AppealDialog> {
  final _text = TextEditingController();

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ok = _text.text.trim().length >= 10;
    return AlertDialog(
      title: const Text('Ajukan banding'),
      content: TextField(
        controller: _text,
        maxLines: 5,
        maxLength: 2000,
        onChanged: (_) => setState(() {}),
        decoration: const InputDecoration(hintText: 'Jelaskan mengapa menurutmu konten ini tidak melanggar aturan (min. 10 karakter)'),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Batal')),
        FilledButton(onPressed: ok ? () => Navigator.pop(context, _text.text.trim()) : null, child: const Text('Kirim')),
      ],
    );
  }
}
