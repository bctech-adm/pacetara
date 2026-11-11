import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/api_error.dart';
import '../../core/widgets/common.dart';
import '../chat/chat_screens.dart' show formatListTime;
import '../communities/communities_repository.dart';
import '../communities/widgets.dart';
import 'notifications_repository.dart';

/// Ikon lonceng dengan jumlah notifikasi belum dibaca.
class NotificationBell extends ConsumerWidget {
  const NotificationBell({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final unread = ref.watch(unreadNotificationsProvider);
    final invites = ref.watch(invitationsProvider).value?.length ?? 0;
    final n = unread > invites ? unread : invites;
    return IconButton(
      key: const Key('notification-bell'),
      tooltip: 'Notifikasi',
      onPressed: () => context.push('/notifications'),
      icon: Badge(isLabelVisible: n > 0, label: Text(n > 99 ? '99+' : '$n'), child: const Icon(Icons.notifications_outlined)),
    );
  }
}

class NotificationsScreen extends ConsumerStatefulWidget {
  const NotificationsScreen({super.key});

  @override
  ConsumerState<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends ConsumerState<NotificationsScreen> {
  bool _marked = false;

  Future<void> _respond(Invitation inv, bool accept) async {
    try {
      await ref.read(notificationsRepositoryProvider).respond(inv.id, accept: accept);
      ref.invalidate(invitationsProvider);
      ref.invalidate(myCommunitiesProvider);
      if (!mounted) return;
      if (accept) {
        showInfo(context, 'Kamu bergabung ke ${inv.community.name}');
        await context.push('/communities/${inv.community.id}');
      }
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final page = ref.watch(notificationsProvider);
    final invites = ref.watch(invitationsProvider).value ?? const <Invitation>[];
    // Membuka layar = semua dianggap dibaca (sekali per kunjungan).
    if (!_marked && (page.value?.unread ?? 0) > 0) {
      _marked = true;
      ref.read(notificationsRepositoryProvider).markAllRead().then((_) => ref.invalidate(notificationsProvider), onError: (_) {});
    }
    return Scaffold(
      appBar: AppBar(
        title: const Text('Notifikasi'),
        actions: [IconButton(tooltip: 'Pengaturan notifikasi', icon: const Icon(Icons.tune), onPressed: () => context.push('/settings/notifications'))],
      ),
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(notificationsProvider);
          ref.invalidate(invitationsProvider);
        },
        child: ListView(children: [
          if (invites.isNotEmpty) ...[
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
              child: Text('Undangan komunitas', style: Theme.of(context).textTheme.titleSmall),
            ),
            for (final inv in invites)
              Card(
                margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(0, 4, 8, 8),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
                    ListTile(
                      leading: CommunityLogo(name: inv.community.name, logoUrl: inv.community.logoUrl, size: 44),
                      title: Text(inv.community.name),
                      subtitle: Text('${inv.invitedBy ?? 'Admin'} mengundangmu · ${inv.community.city}'),
                    ),
                    Wrap(spacing: 8, children: [
                      TextButton(key: Key('decline-${inv.id}'), onPressed: () => _respond(inv, false), child: const Text('Tolak')),
                      FilledButton(key: Key('accept-${inv.id}'), onPressed: () => _respond(inv, true), child: const Text('Gabung')),
                    ]),
                  ]),
                ),
              ),
            const Divider(),
          ],
          ...page.when(
            loading: () => [const Padding(padding: EdgeInsets.all(32), child: Center(child: CircularProgressIndicator()))],
            error: (e, _) => [Padding(padding: const EdgeInsets.all(32), child: Center(child: Text(ApiError.from(e).message)))],
            data: (p) => p.items.isEmpty && invites.isEmpty
                ? [const Padding(padding: EdgeInsets.all(48), child: Center(child: Text('Belum ada notifikasi')))]
                : [
                    for (final n in p.items.where((n) => n.type != 'community_invite'))
                      ListTile(
                        leading: CommunityLogo(name: n.actorName ?? n.communityName ?? '?', logoUrl: n.actorAvatarUrl, size: 40),
                        title: Text(n.text, style: n.read ? null : const TextStyle(fontWeight: FontWeight.w600)),
                        subtitle: Text(formatListTime(n.createdAt, DateTime.now())),
                        onTap: n.route == null ? null : () => context.push(n.route!),
                      ),
                  ],
          ),
        ]),
      ),
    );
  }
}

class NotificationSettingsScreen extends ConsumerWidget {
  const NotificationSettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(notificationSettingsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Pengaturan notifikasi')),
      body: settings.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text(ApiError.from(e).message)),
        data: (s) => ListView(children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 12, 16, 4),
            child: Text('Pilih notifikasi push yang ingin kamu terima. Isi pesan chat tidak pernah ditampilkan di notifikasi.'),
          ),
          for (final e in notificationCategories.entries)
            SwitchListTile(
              key: Key('pref-${e.key}'),
              title: Text(e.value.$1),
              subtitle: Text(e.value.$2),
              value: s[e.key] ?? true,
              onChanged: (v) async {
                try {
                  await ref.read(notificationsRepositoryProvider).updateSettings({e.key: v});
                  ref.invalidate(notificationSettingsProvider);
                } catch (err) {
                  if (context.mounted) showError(context, err);
                }
              },
            ),
        ]),
      ),
    );
  }
}

/// Admin mengundang langsung pengguna yang sudah ia kenal (sesama anggota komunitas lain / chat pribadi).
class InviteMembersSheet extends ConsumerWidget {
  const InviteMembersSheet({super.key, required this.communityId});
  final String communityId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(inviteCandidatesProvider(communityId));
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.8),
        child: list.when(
          loading: () => const Padding(padding: EdgeInsets.all(32), child: Center(child: CircularProgressIndicator())),
          error: (e, _) => Padding(padding: const EdgeInsets.all(32), child: Text(ApiError.from(e).message)),
          data: (items) => ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(16, 0, 16, 16), children: [
            Text('Undang anggota', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 4),
            Text('Daftar berisi teman dari komunitasmu yang lain dan orang yang pernah chat pribadi denganmu.',
                style: Theme.of(context).textTheme.bodySmall),
            if (items.isEmpty)
              const Padding(padding: EdgeInsets.symmetric(vertical: 24), child: Text('Belum ada yang bisa diundang. Bagikan kode undangan di bawah.')),
            for (final c in items)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: CommunityLogo(name: c.displayName, logoUrl: c.avatarUrl, size: 40),
                title: Text(c.displayName),
                trailing: c.invited
                    ? const Text('Diundang')
                    : FilledButton.tonal(
                        key: Key('invite-${c.id}'),
                        onPressed: () async {
                          try {
                            await ref.read(notificationsRepositoryProvider).invite(communityId, c.id);
                            ref.invalidate(inviteCandidatesProvider(communityId));
                          } catch (e) {
                            if (context.mounted) showError(context, e);
                          }
                        },
                        child: const Text('Undang'),
                      ),
              ),
          ]),
        ),
      ),
    );
  }
}
