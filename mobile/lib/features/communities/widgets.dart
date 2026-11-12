import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/api_error.dart';
import '../../core/widgets/common.dart';
import '../auth/auth_controller.dart';
import '../subscriptions/upgrade.dart';
import 'models.dart';

class CommunityLogo extends ConsumerWidget {
  const CommunityLogo({super.key, required this.name, required this.logoUrl, this.size = 48});
  final String name;
  final String? logoUrl;
  final double size;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final url = logoUrl;
    final bytes = url == null ? null : ref.watch(avatarBytesProvider(url)).value;
    final scheme = Theme.of(context).colorScheme;
    return ClipRRect(
      borderRadius: BorderRadius.circular(size * 0.25),
      child: Container(
        width: size,
        height: size,
        color: scheme.primaryContainer,
        alignment: Alignment.center,
        child: bytes != null
            ? Image.memory(Uint8List.fromList(bytes), width: size, height: size, fit: BoxFit.cover)
            : Text(
                name.isEmpty ? '?' : name[0].toUpperCase(),
                style: TextStyle(fontSize: size * 0.45, fontWeight: FontWeight.w700, color: scheme.onPrimaryContainer),
              ),
      ),
    );
  }
}

class ProBadge extends StatelessWidget {
  const ProBadge({super.key});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(color: scheme.tertiary, borderRadius: BorderRadius.circular(6)),
      child: Text('PRO', style: TextStyle(color: scheme.onTertiary, fontSize: 11, fontWeight: FontWeight.w700)),
    );
  }
}

class CommunityTile extends StatelessWidget {
  const CommunityTile({super.key, required this.community, required this.onTap});
  final CommunitySummary community;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = community;
    final status = switch (c.myStatus) {
      MyStatus.pending => ' · Menunggu persetujuan',
      MyStatus.active when c.myRole != null && c.myRole != Role.member => ' · ${roleLabel(c.myRole!)}',
      _ => '',
    };
    return ListTile(
      onTap: onTap,
      leading: CommunityLogo(name: c.name, logoUrl: c.logoUrl),
      title: Row(
        children: [
          Flexible(child: Text(c.name, overflow: TextOverflow.ellipsis)),
          if (c.isPro) ...[const SizedBox(width: 6), const ProBadge()],
        ],
      ),
      subtitle: Text('${c.city} · ${c.memberCount} anggota · ${visibilityLabel(c.visibility)}$status'),
      trailing: c.visibility == CommunityVisibility.private ? const Icon(Icons.lock_outline, size: 18) : null,
    );
  }
}

/// Menjalankan aksi; jika server menolak karena batas paket, tampilkan dialog batas
/// (ajakan upgrade internal, PRD 2.5), selain itu snackbar galat. Mengembalikan true jika berhasil.
/// [ownedCommunityId]: komunitas milik pengguna yang relevan, agar batas komunitas mengarah ke Komunitas Pro-nya.
Future<bool> runCommunityAction(BuildContext context, Future<void> Function() action, {String? success, String? ownedCommunityId}) async {
  try {
    await action();
    if (success != null && context.mounted) showInfo(context, success);
    return true;
  } catch (e) {
    if (!context.mounted) return false;
    final err = ApiError.from(e);
    if (err.code == 'limit_reached') {
      await showLimitDialog(context, err.message, kind: err.limitKind, ownedCommunityId: ownedCommunityId);
    } else {
      showError(context, err);
    }
    return false;
  }
}

/// Dialog batas paket dengan tombol ke layar langganan yang relevan (Premium atau Komunitas Pro). Harga dan
/// pembelian ada di layar langganan; dialog ini tidak mengubah apa pun.
Future<void> showLimitDialog(BuildContext context, String message, {String? kind, String? ownedCommunityId}) {
  final route = upgradeRoute(kind, ownedCommunityId: ownedCommunityId);
  return showDialog<void>(
    context: context,
    builder: (dialog) => AlertDialog(
      icon: const Icon(Icons.workspace_premium_outlined),
      title: const Text('Batas paket gratis'),
      content: Text(message),
      actions: [
        TextButton(onPressed: () => Navigator.pop(dialog), child: Text(route == null ? 'Mengerti' : 'Tutup')),
        if (route != null)
          FilledButton(
            key: const Key('limit-upgrade'),
            onPressed: () {
              Navigator.pop(dialog);
              context.push(route);
            },
            child: Text(upgradeLabel(kind)),
          ),
      ],
    ),
  );
}

Future<bool> confirm(BuildContext context, {required String title, required String message, required String action, bool destructive = false}) async {
  final result = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Batal')),
        FilledButton(
          style: destructive ? FilledButton.styleFrom(backgroundColor: Theme.of(context).colorScheme.error) : null,
          onPressed: () => Navigator.pop(context, true),
          child: Text(action),
        ),
      ],
    ),
  );
  return result ?? false;
}
