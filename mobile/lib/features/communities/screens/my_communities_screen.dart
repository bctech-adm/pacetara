import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../auth/auth_controller.dart';
import '../../auth/models.dart';
import '../models.dart';
import '../../profile/profile_screen.dart';
import '../communities_repository.dart';
import '../widgets.dart';

/// Beranda: komunitas yang diikuti, plus jalan pintas ke direktori, buat, dan gabung dengan kode.
class MyCommunitiesScreen extends ConsumerWidget {
  const MyCommunitiesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profile = ref.watch(authControllerProvider).value;
    final mine = ref.watch(myCommunitiesProvider);

    return _scaffold(context, ref, profile, mine);
  }

  Widget _scaffold(BuildContext context, WidgetRef ref, MyProfile? profile, AsyncValue<MyCommunities> mine) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Komunitasku'),
        actions: [
          IconButton(tooltip: 'Kalender event', icon: const Icon(Icons.event_outlined), onPressed: () => context.push('/events')),
          IconButton(tooltip: 'Jelajahi komunitas', icon: const Icon(Icons.search), onPressed: () => context.push('/communities/explore')),
          if (profile != null)
            IconButton(tooltip: 'Profil', onPressed: () => context.push('/profile'), icon: Avatar(profile: profile, radius: 16)),
          const SizedBox(width: 8),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _showAddSheet(context, ref),
        icon: const Icon(Icons.add),
        label: const Text('Komunitas'),
      ),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(myCommunitiesProvider.future),
        child: mine.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => ListView(children: [
            const SizedBox(height: 120),
            const Center(child: Text('Gagal memuat komunitas')),
            Center(child: TextButton(onPressed: () => ref.invalidate(myCommunitiesProvider), child: const Text('Coba lagi'))),
          ]),
          data: (data) {
            if (data.items.isEmpty) return _Empty(onExplore: () => context.push('/communities/explore'));
            return ListView(
              padding: const EdgeInsets.only(bottom: 96),
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
                  child: Text(
                    data.joined.limit == null
                        ? 'Bergabung di ${data.joined.used} komunitas'
                        : 'Bergabung di ${data.joined.label()} komunitas (paket gratis)',
                    style: Theme.of(context).textTheme.labelLarge,
                  ),
                ),
                const EventsEntry(),
                for (final c in data.items) CommunityTile(community: c, onTap: () => context.push('/communities/${c.id}')),
              ],
            );
          },
        ),
      ),
    );
  }

  void _showAddSheet(BuildContext context, WidgetRef ref) {
    showModalBottomSheet<void>(
      context: context,
      builder: (sheet) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.travel_explore),
              title: const Text('Jelajahi komunitas'),
              onTap: () {
                Navigator.pop(sheet);
                context.push('/communities/explore');
              },
            ),
            ListTile(
              leading: const Icon(Icons.vpn_key_outlined),
              title: const Text('Gabung dengan kode undangan'),
              onTap: () {
                Navigator.pop(sheet);
                context.push('/communities/join');
              },
            ),
            ListTile(
              leading: const Icon(Icons.group_add_outlined),
              title: const Text('Buat komunitas'),
              onTap: () {
                Navigator.pop(sheet);
                final mine = ref.read(myCommunitiesProvider).value;
                if (mine != null && mine.ownedFree.reached) {
                  showLimitDialog(context, 'Akun gratis hanya bisa membuat 1 komunitas. Upgrade komunitasmu ke Pro untuk membuat komunitas lain');
                  return;
                }
                context.push('/communities/new');
              },
            ),
          ],
        ),
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty({required this.onExplore});
  final VoidCallback onExplore;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListView(
      padding: const EdgeInsets.all(32),
      children: [
        const SizedBox(height: 48),
        Icon(Icons.groups_outlined, size: 72, color: theme.colorScheme.primary),
        const SizedBox(height: 16),
        Text('Belum ada komunitas', textAlign: TextAlign.center, style: theme.textTheme.titleLarge),
        const SizedBox(height: 8),
        const Text('Cari komunitas lari di kotamu, gabung pakai kode undangan dari teman, atau buat komunitasmu sendiri.',
            textAlign: TextAlign.center),
        const SizedBox(height: 24),
        FilledButton.icon(onPressed: onExplore, icon: const Icon(Icons.search), label: const Text('Jelajahi komunitas')),
        const SizedBox(height: 24),
        const EventsEntry(),
      ],
    );
  }
}

/// Jalan pintas ke kalender event (PRD 1.7).
class EventsEntry extends StatelessWidget {
  const EventsEntry({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      color: theme.colorScheme.secondaryContainer,
      child: ListTile(
        key: const Key('events-entry'),
        leading: Icon(Icons.event, color: theme.colorScheme.onSecondaryContainer),
        title: const Text('Kalender event lari'),
        subtitle: const Text('Temukan event dan lihat teman komunitas yang ikut'),
        trailing: const Icon(Icons.chevron_right),
        onTap: () => context.push('/events'),
      ),
    );
  }
}
