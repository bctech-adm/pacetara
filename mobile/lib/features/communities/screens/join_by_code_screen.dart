import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/widgets/common.dart';
import '../communities_repository.dart';
import '../models.dart';
import '../widgets.dart';

final _codePattern = RegExp(r'(?:^|[/\s])([A-Za-z2-9]{8})\s*$');

/// Mengambil kode undangan dari masukan: kode langsung atau tautan https://.../j/KODE.
String? extractInviteCode(String input) => _codePattern.firstMatch(input.trim())?.group(1)?.toUpperCase();

/// Gabung lewat kode undangan (8 huruf/angka) atau tempel tautan undangan.
class JoinByCodeScreen extends ConsumerStatefulWidget {
  const JoinByCodeScreen({super.key, this.initialCode});
  final String? initialCode;

  @override
  ConsumerState<JoinByCodeScreen> createState() => _JoinByCodeScreenState();
}

class _JoinByCodeScreenState extends ConsumerState<JoinByCodeScreen> {
  late final _code = TextEditingController(text: widget.initialCode ?? '');
  CommunityDetail? _preview;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _check() async {
    final code = extractInviteCode(_code.text);
    if (code == null) throw const FormatException('Kode berisi 8 huruf/angka');
    final preview = await ref.read(communitiesRepositoryProvider).previewInvite(code);
    setState(() => _preview = preview);
  }

  Future<void> _join() async {
    final code = extractInviteCode(_code.text)!;
    final router = GoRouter.of(context);
    late CommunityDetail joined;
    final ok = await runCommunityAction(context, () async {
      joined = await ref.read(communitiesRepositoryProvider).joinByCode(code);
    });
    if (!ok) return;
    ref.invalidate(myCommunitiesProvider);
    router.pushReplacement('/communities/${joined.summary.id}');
  }

  @override
  Widget build(BuildContext context) {
    final p = _preview;
    return FormPage(
      title: 'Gabung dengan kode',
      children: [
        const Text('Masukkan kode undangan dari admin komunitas, atau tempel tautan undangannya.'),
        const SizedBox(height: 16),
        TextField(
          controller: _code,
          textCapitalization: TextCapitalization.characters,
          inputFormatters: [LengthLimitingTextInputFormatter(80)],
          onChanged: (_) {
            if (_preview != null) setState(() => _preview = null);
          },
          decoration: const InputDecoration(labelText: 'Kode atau tautan undangan', border: OutlineInputBorder()),
        ),
        const SizedBox(height: 16),
        if (p == null)
          AsyncButton(label: 'Periksa kode', onPressed: _check)
        else ...[
          Card(child: CommunityTile(community: p.summary, onTap: () {})),
          if (p.description.isNotEmpty) Padding(padding: const EdgeInsets.all(8), child: Text(p.description)),
          const SizedBox(height: 16),
          if (p.summary.myStatus == MyStatus.active)
            AsyncButton(label: 'Buka komunitas', onPressed: () async => context.pushReplacement('/communities/${p.summary.id}'))
          else
            AsyncButton(label: 'Gabung ke ${p.summary.name}', onPressed: _join),
        ],
      ],
    );
  }
}
