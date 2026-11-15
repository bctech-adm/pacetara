import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/motion.dart';
import '../../auth/auth_controller.dart';
import '../../auth/models.dart';
import '../models.dart';
import '../../notifications/notifications_screens.dart';
import '../../profile/profile_screen.dart';
import '../communities_repository.dart';
import '../widgets.dart';
import '../../banners/sponsor_banner.dart';

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
          const NotificationBell(),
          IconButton(tooltip: 'Kalender event', icon: const Icon(Icons.event_outlined), onPressed: () => context.push('/events')),
          IconButton(tooltip: 'Jelajahi komunitas', icon: const Icon(Icons.search), onPressed: () => context.push('/communities/explore')),
          if (profile != null)
            IconButton(tooltip: 'Profil', onPressed: () => context.push('/profile'), icon: Avatar(profile: profile, radius: 16)),
          const SizedBox(width: 8),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        heroTag: null,
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
            final items = <Widget>[
              const CommunityPlusEntry(),
              // Banner sponsor slot beranda (modul 3.3); kosong untuk Premium atau bila tidak ada banner.
              SponsorBanner(slot: 'home', city: profile?.city),
              const EventsEntry(),
              SectionHeader(
                data.joined.limit == null
                    ? 'Bergabung di ${data.joined.used} komunitas'
                    : 'Bergabung di ${data.joined.label()} komunitas (paket gratis)',
              ),
              for (final c in data.items)
                Card(
                  margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 5),
                  clipBehavior: Clip.antiAlias,
                  child: Pressable(
                    scale: 0.98,
                    child: CommunityTile(community: c, onTap: () => context.push('/communities/${c.id}')),
                  ),
                ),
            ];
            return ListView(
              padding: const EdgeInsets.only(top: 4, bottom: 96),
              children: [for (var i = 0; i < items.length; i++) FadeSlideIn(index: i, child: items[i])],
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
                  showLimitDialog(context, 'Akun gratis hanya bisa membuat 1 komunitas. Upgrade komunitasmu ke Pro untuk membuat komunitas lain', kind: 'owned_communities');
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
    return ListView(
      padding: const EdgeInsets.only(top: 24, bottom: 96),
      children: [
        EmptyState(
          icon: Icons.groups_rounded,
          title: 'Belum ada komunitas',
          message: 'Cari komunitas lari di kotamu, gabung pakai kode undangan dari teman, atau buat komunitasmu sendiri.',
          action: FilledButton.icon(onPressed: onExplore, icon: const Icon(Icons.search), label: const Text('Jelajahi komunitas')),
        ),
        const EventsEntry(),
      ],
    );
  }
}

/// Jalan pintas ke kalender event (PRD 1.7): banner bergradien.
class EventsEntry extends StatelessWidget {
  const EventsEntry({super.key});

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 6),
      child: Pressable(
        child: DecoratedBox(
          decoration: BoxDecoration(
            gradient: Brand.gradientViolet,
            borderRadius: BorderRadius.circular(22),
            boxShadow: [BoxShadow(color: Brand.violet.withValues(alpha: 0.3), blurRadius: 18, offset: const Offset(0, 8))],
          ),
          child: Material(
            type: MaterialType.transparency,
            child: InkWell(
              key: const Key('events-entry'),
              borderRadius: BorderRadius.circular(22),
              onTap: () => context.push('/events'),
              child: Stack(children: [
                Positioned(
                  right: -18,
                  bottom: -26,
                  child: Icon(Icons.emoji_events_rounded, size: 120, color: Colors.white.withValues(alpha: 0.13)),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(18, 18, 14, 18),
                  child: Row(children: [
                    Container(
                      width: 48,
                      height: 48,
                      decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.2), borderRadius: BorderRadius.circular(16)),
                      child: const Icon(Icons.event_rounded, color: Colors.white),
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('Kalender event lari', style: t.titleMedium?.copyWith(color: Colors.white, fontWeight: FontWeight.w800)),
                        const SizedBox(height: 2),
                        Text(
                          'Temukan event dan lihat teman komunitas yang ikut',
                          style: t.bodySmall?.copyWith(color: Colors.white.withValues(alpha: 0.85)),
                        ),
                      ]),
                    ),
                    const Icon(Icons.arrow_forward_rounded, color: Colors.white),
                  ]),
                ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

/// Pintasan modul 2.6: cari teman lari, peta spot lari, liga komunitas, dan marketplace.
class CommunityPlusEntry extends StatelessWidget {
  const CommunityPlusEntry({super.key});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
      child: Row(children: [
        Expanded(
          child: _Shortcut(
            key: const Key('buddies-entry'),
            icon: Icons.diversity_3_rounded,
            gradient: Brand.gradient,
            label: 'Cari teman',
            onTap: () => context.push('/buddies'),
          ),
        ),
        Expanded(child: _Shortcut(icon: Icons.map_rounded, gradient: Brand.gradientTeal, label: 'Spot lari', onTap: () => context.push('/spots'))),
        Expanded(child: _Shortcut(icon: Icons.emoji_events_rounded, gradient: Brand.gradientGold, label: 'Liga', onTap: () => context.push('/league'))),
        Expanded(
          child: _Shortcut(
            key: const Key('market-entry'),
            icon: Icons.storefront_rounded,
            gradient: Brand.gradientRose,
            label: 'Marketplace',
            onTap: () => context.push('/market'),
          ),
        ),
      ]),
    );
  }
}

class _Shortcut extends StatelessWidget {
  const _Shortcut({super.key, required this.icon, required this.label, required this.onTap, required this.gradient});
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final Gradient gradient;

  @override
  Widget build(BuildContext context) => Pressable(
        scale: 0.92,
        child: InkWell(
          borderRadius: BorderRadius.circular(18),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 10),
            child: Column(children: [
              GradientIcon(icon: icon, gradient: gradient, size: 54),
              const SizedBox(height: 8),
              Text(
                label,
                style: Theme.of(context).textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w700),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ]),
          ),
        ),
      );
}
