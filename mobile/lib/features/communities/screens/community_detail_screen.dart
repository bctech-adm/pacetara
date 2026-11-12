import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/widgets/common.dart';
import '../../auth/auth_controller.dart';
import '../../chat/chat_screens.dart';
import '../../moderation/moderation.dart';
import '../../notifications/notifications_screens.dart';
import '../../live/live_widgets.dart';
import '../../subscriptions/upgrade.dart';
import '../communities_repository.dart';
import '../models.dart';
import '../widgets.dart';
import 'community_form_screen.dart';

class CommunityDetailScreen extends ConsumerWidget {
  const CommunityDetailScreen({super.key, required this.id});
  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detail = ref.watch(communityDetailProvider(id));
    return detail.when(
      loading: () => Scaffold(appBar: AppBar(), body: const Center(child: CircularProgressIndicator())),
      error: (e, _) => Scaffold(
        appBar: AppBar(),
        body: Center(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text(e.toString().contains('community_not_found') ? 'Komunitas tidak ditemukan' : 'Gagal memuat komunitas'),
            TextButton(onPressed: () => ref.invalidate(communityDetailProvider(id)), child: const Text('Coba lagi')),
          ]),
        ),
      ),
      data: (d) => _DetailBody(detail: d),
    );
  }
}

class _DetailBody extends ConsumerWidget {
  const _DetailBody({required this.detail});
  final CommunityDetail detail;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = detail.summary;
    final theme = Theme.of(context);
    final isMember = c.myStatus == MyStatus.active;

    return Scaffold(
      appBar: AppBar(
        title: Text(c.name, overflow: TextOverflow.ellipsis),
        actions: [
          if (isMember)
            _MenuButton(detail: detail)
          else
            IconButton(
              tooltip: 'Laporkan komunitas',
              icon: const Icon(Icons.flag_outlined),
              onPressed: () => showReportSheet(context, ref, target: ReportTarget.community, targetId: c.id, title: 'Laporkan ${c.name}'),
            ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async => refreshCommunity(ref, c.id),
        child: ListView(
          padding: const EdgeInsets.only(bottom: 32),
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  CommunityLogo(name: c.name, logoUrl: c.logoUrl, size: 72),
                  const SizedBox(width: 16),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(children: [
                          Flexible(child: Text(c.name, style: theme.textTheme.titleLarge)),
                          if (c.isPro) ...[const SizedBox(width: 8), const ProBadge()],
                        ]),
                        const SizedBox(height: 4),
                        Text('${c.city} · ${visibilityLabel(c.visibility)}'),
                        Text('${detail.memberLimit.label()} anggota', key: const Key('member-count')),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            if (detail.description.isNotEmpty)
              Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: Text(detail.description)),
            Padding(padding: const EdgeInsets.all(16), child: _PrimaryAction(detail: detail)),
            if (c.isStaff) _AdminPanel(detail: detail),
            if (isMember) CommunityLiveSection(communityId: c.id),
            if (isMember) _MembersSection(detail: detail),
          ],
        ),
      ),
    );
  }
}

/// Tombol utama sesuai status keanggotaan.
class _PrimaryAction extends ConsumerWidget {
  const _PrimaryAction({required this.detail});
  final CommunityDetail detail;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = detail.summary;
    final repo = ref.read(communitiesRepositoryProvider);
    switch (c.myStatus) {
      case MyStatus.active:
        return FilledButton.tonalIcon(
          key: const Key('community-chat'),
          onPressed: () => openCommunityChat(context, ref, c.id),
          icon: const Icon(Icons.chat_bubble_outline),
          label: const Text('Chat komunitas'),
        );
      case MyStatus.pending:
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const Text('Permintaan bergabung sedang menunggu persetujuan admin.'),
          const SizedBox(height: 8),
          AsyncButton(
            label: 'Batalkan permintaan',
            outlined: true,
            onPressed: () async {
              await repo.cancelRequest(c.id);
              refreshCommunity(ref, c.id);
            },
          ),
        ]);
      case MyStatus.none:
      case MyStatus.banned:
        final isPrivate = c.visibility == CommunityVisibility.private;
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (detail.memberLimit.reached)
            const Padding(
              padding: EdgeInsets.only(bottom: 8),
              child: Text('Komunitas ini sedang penuh untuk paketnya.'),
            ),
          AsyncButton(
            label: isPrivate ? 'Minta bergabung' : 'Gabung',
            onPressed: () async {
              final ok = await runCommunityAction(
                context,
                () => repo.join(c.id),
                success: isPrivate ? 'Permintaan dikirim ke admin' : 'Kamu sudah bergabung',
              );
              if (ok) refreshCommunity(ref, c.id);
            },
          ),
          if (isPrivate) ...[
            const SizedBox(height: 8),
            TextButton(onPressed: () => context.push('/communities/join'), child: const Text('Punya kode undangan?')),
          ],
        ]);
    }
  }
}

class _MenuButton extends ConsumerWidget {
  const _MenuButton({required this.detail});
  final CommunityDetail detail;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = detail.summary;
    final repo = ref.read(communitiesRepositoryProvider);
    return PopupMenuButton<String>(
      onSelected: (value) async {
        switch (value) {
          case 'settings':
            await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => CommunityFormScreen(initial: detail)));
          case 'leave':
            if (await confirm(context, title: 'Keluar dari ${c.name}?', message: 'Kamu bisa bergabung lagi nanti.', action: 'Keluar') &&
                context.mounted) {
              final ok = await runCommunityAction(context, () => repo.leave(c.id));
              if (ok) {
                refreshCommunity(ref, c.id);
                if (context.mounted) context.pop();
              }
            }
          case 'report':
            await showReportSheet(context, ref, target: ReportTarget.community, targetId: c.id, title: 'Laporkan ${c.name}');
          case 'delete':
            if (await confirm(context,
                    title: 'Hapus ${c.name}?',
                    message: 'Komunitas, keanggotaan, dan kode undangannya dihapus permanen.',
                    action: 'Hapus',
                    destructive: true) &&
                context.mounted) {
              final ok = await runCommunityAction(context, () => repo.delete(c.id), success: 'Komunitas dihapus');
              if (ok) {
                ref.invalidate(myCommunitiesProvider);
                if (context.mounted) context.go('/');
              }
            }
        }
      },
      itemBuilder: (_) => [
        if (c.isStaff) const PopupMenuItem(value: 'settings', child: Text('Pengaturan')),
        if (c.myRole != Role.owner) const PopupMenuItem(value: 'leave', child: Text('Keluar dari komunitas')),
        if (c.myRole == Role.owner) const PopupMenuItem(value: 'delete', child: Text('Hapus komunitas')),
        if (c.myRole != Role.owner) const PopupMenuItem(value: 'report', child: Text('Laporkan komunitas')),
      ],
    );
  }
}

/// Panel admin: permintaan bergabung dan kode undangan.
class _AdminPanel extends ConsumerWidget {
  const _AdminPanel({required this.detail});
  final CommunityDetail detail;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = detail.summary;
    final repo = ref.read(communitiesRepositoryProvider);
    final pending = (detail.pendingCount ?? 0) > 0 ? ref.watch(communityMembersProvider((c.id, 'pending'))).value : null;
    final invites = ref.watch(communityInvitesProvider(c.id)).value ?? const <Invite>[];

    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ListTile(title: Text('Admin', style: Theme.of(context).textTheme.titleMedium)),
            // Langganan Komunitas Pro hanya bisa dibeli pemilik (diperiksa juga di server).
            if (c.myRole == Role.owner)
              ListTile(
                key: const Key('community-subscription'),
                leading: const Icon(Icons.workspace_premium_outlined),
                title: Text(c.isPro ? 'Langganan Komunitas Pro' : 'Upgrade ke Komunitas Pro'),
                subtitle: Text(c.isPro ? 'Lihat status dan kelola langganan' : 'Anggota hingga 30 atau tanpa batas, multi-admin, lencana Pro'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => context.push('/subscription/community/${c.id}'),
              ),
            if (pending != null && pending.isNotEmpty) ...[
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Text('Permintaan bergabung (${pending.length})', style: Theme.of(context).textTheme.labelLarge),
              ),
              for (final m in pending)
                ListTile(
                  title: Text(m.displayName),
                  subtitle: m.city == null ? null : Text(m.city!),
                  trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                    IconButton(
                      tooltip: 'Tolak',
                      icon: const Icon(Icons.close),
                      onPressed: () async {
                        if (await runCommunityAction(context, () => repo.reject(c.id, m.userId))) refreshCommunity(ref, c.id);
                      },
                    ),
                    IconButton.filled(
                      tooltip: 'Setujui',
                      icon: const Icon(Icons.check),
                      onPressed: () async {
                        final seeHistory = await _askSeeHistory(context, m.displayName, detail.newMembersSeeHistory ?? false);
                        if (seeHistory == null || !context.mounted) return;
                        if (await runCommunityAction(context, () => repo.approve(c.id, m.userId, seeHistory: seeHistory),
                            success: '${m.displayName} bergabung', ownedCommunityId: c.myRole == Role.owner ? c.id : null)) {
                          refreshCommunity(ref, c.id);
                        }
                      },
                    ),
                  ]),
                ),
              const Divider(),
            ],
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Text('Kode undangan', style: Theme.of(context).textTheme.labelLarge),
            ),
            for (final inv in invites)
              ListTile(
                title: SelectableText(inv.code, style: const TextStyle(fontFamily: 'monospace', fontSize: 18, letterSpacing: 2)),
                subtitle: Text(
                  'Berlaku sampai ${_date(inv.expiresAt)}'
                  '${inv.maxUses == null ? '' : ' · ${inv.uses}/${inv.maxUses} dipakai'}',
                ),
                trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                  IconButton(
                    tooltip: 'Salin tautan',
                    icon: const Icon(Icons.copy),
                    onPressed: () async {
                      await Clipboard.setData(ClipboardData(
                        text: 'Gabung ke ${c.name} di PaceTara: ${inv.url}\nAtau masukkan kode ${inv.code} di menu Gabung dengan kode.',
                      ));
                      if (context.mounted) showInfo(context, 'Undangan disalin. Tempel di WhatsApp atau grup komunitasmu');
                    },
                  ),
                  IconButton(
                    tooltip: 'Cabut',
                    icon: const Icon(Icons.delete_outline),
                    onPressed: () async {
                      if (await runCommunityAction(context, () => repo.revokeInvite(c.id, inv.id))) {
                        ref.invalidate(communityInvitesProvider(c.id));
                      }
                    },
                  ),
                ]),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
              child: FilledButton.tonalIcon(
                key: const Key('invite-members'),
                onPressed: () => showModalBottomSheet<void>(
                  context: context,
                  isScrollControlled: true,
                  showDragHandle: true,
                  builder: (_) => InviteMembersSheet(communityId: c.id),
                ),
                icon: const Icon(Icons.person_add_alt),
                label: const Text('Undang anggota langsung'),
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: AsyncButton(
                label: 'Buat kode undangan (7 hari)',
                outlined: true,
                onPressed: () async {
                  if (await runCommunityAction(context, () => repo.createInvite(c.id))) ref.invalidate(communityInvitesProvider(c.id));
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  static String _date(DateTime d) => '${d.day}/${d.month}/${d.year}';

  /// Admin memilih apakah anggota baru melihat riwayat chat lama (PRD 1.6). Null = batal.
  static Future<bool?> _askSeeHistory(BuildContext context, String name, bool initial) {
    var see = initial;
    return showDialog<bool>(
      context: context,
      builder: (dialog) => StatefulBuilder(
        builder: (dialog, setState) => AlertDialog(
          title: Text('Setujui $name?'),
          content: CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            value: see,
            onChanged: (v) => setState(() => see = v ?? false),
            title: const Text('Boleh melihat riwayat chat sebelum bergabung'),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialog), child: const Text('Batal')),
            FilledButton(onPressed: () => Navigator.pop(dialog, see), child: const Text('Setujui')),
          ],
        ),
      ),
    );
  }
}

class _MembersSection extends ConsumerWidget {
  const _MembersSection({required this.detail});
  final CommunityDetail detail;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = detail.summary;
    final members = ref.watch(communityMembersProvider((c.id, 'active')));
    final me = ref.watch(authControllerProvider).value?.id;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
          child: Text('Anggota', style: Theme.of(context).textTheme.titleMedium),
        ),
        ...members.when(
          loading: () => [const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()))],
          error: (e, _) => [const ListTile(title: Text('Gagal memuat anggota'))],
          data: (list) => [
            for (final m in list)
              ListTile(
                leading: CommunityLogo(name: m.displayName, logoUrl: m.avatarUrl, size: 40),
                title: NameWithBadges(name: m.displayName + (m.userId == me ? ' (kamu)' : ''), badges: m.badges, proBadge: const ProBadge()),
                onTap: m.userId == me ? null : () => openDirectChat(context, ref, m.userId),
                subtitle: Text([roleLabel(m.role), if (m.city != null) m.city!].join(' · ')),
                trailing: c.isStaff && m.userId != me && m.role != Role.owner
                    ? IconButton(
                        tooltip: 'Kelola',
                        icon: const Icon(Icons.more_vert),
                        onPressed: () => _manageMember(context, ref, m),
                      )
                    : null,
              ),
          ],
        ),
      ],
    );
  }

  void _manageMember(BuildContext context, WidgetRef ref, Member m) {
    final c = detail.summary;
    final repo = ref.read(communitiesRepositoryProvider);
    final isOwner = c.myRole == Role.owner;
    // Admin hanya bisa mengelola anggota biasa; pemilik bisa mengelola admin juga.
    if (!isOwner && m.role == Role.admin) {
      showInfo(context, 'Hanya pemilik yang bisa mengelola admin');
      return;
    }

    Future<void> act(BuildContext sheet, Future<void> Function() fn, String success) async {
      Navigator.pop(sheet);
      if (await runCommunityAction(context, fn, success: success, ownedCommunityId: isOwner ? c.id : null)) refreshCommunity(ref, c.id);
    }

    showModalBottomSheet<void>(
      context: context,
      builder: (sheet) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(title: Text(m.displayName, style: Theme.of(context).textTheme.titleMedium)),
          if (isOwner && m.role == Role.member)
            ListTile(
              leading: const Icon(Icons.shield_outlined),
              title: const Text('Jadikan admin'),
              subtitle: detail.multiAdmin ? null : const Text('Khusus Komunitas Pro'),
              onTap: () => act(sheet, () => repo.setRole(c.id, m.userId, Role.admin), '${m.displayName} sekarang admin'),
            ),
          if (isOwner && m.role == Role.admin)
            ListTile(
              leading: const Icon(Icons.remove_moderator_outlined),
              title: const Text('Jadikan anggota biasa'),
              onTap: () => act(sheet, () => repo.setRole(c.id, m.userId, Role.member), 'Peran diubah'),
            ),
          if (isOwner)
            ListTile(
              leading: const Icon(Icons.swap_horiz),
              title: const Text('Serahkan kepemilikan'),
              onTap: () async {
                Navigator.pop(sheet);
                final yes = await confirm(context,
                    title: 'Serahkan kepemilikan?',
                    message: '${m.displayName} akan menjadi pemilik ${c.name}. Kamu tidak lagi bisa menghapus komunitas ini.',
                    action: 'Serahkan');
                if (yes && context.mounted && await runCommunityAction(context, () => repo.transfer(c.id, m.userId), success: 'Kepemilikan diserahkan')) {
                  refreshCommunity(ref, c.id);
                }
              },
            ),
          ListTile(
            leading: const Icon(Icons.person_remove_outlined),
            title: const Text('Keluarkan'),
            subtitle: const Text('Masih bisa bergabung lagi'),
            onTap: () => act(sheet, () => repo.removeMember(c.id, m.userId), '${m.displayName} dikeluarkan'),
          ),
          ListTile(
            leading: Icon(Icons.block, color: Theme.of(context).colorScheme.error),
            title: const Text('Keluarkan dan blokir'),
            subtitle: const Text('Tidak bisa bergabung lagi, termasuk lewat kode undangan'),
            onTap: () => act(sheet, () => repo.removeMember(c.id, m.userId, ban: true), '${m.displayName} diblokir'),
          ),
        ]),
      ),
    );
  }
}
