import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../auth/auth_controller.dart';
import '../chat/chat_screens.dart';
import '../chat/inbox.dart';
import '../communities/screens/my_communities_screen.dart';
import '../feed/feed_screens.dart';
import '../imports/health_connect_source.dart';
import '../notifications/push_registrar.dart';
import '../profile/profile_screen.dart';
import '../update/update_service.dart';
import '../runs/recorder.dart';
import '../runs/screens/record_screen.dart';
import '../runs/runs_repository.dart';
import '../runs/screens/runs_list_screen.dart';
import '../subscriptions/billing.dart';

final homeTabProvider = NotifierProvider<_HomeTab, int>(_HomeTab.new);

class _HomeTab extends Notifier<int> {
  @override
  int build() => 0;
  void select(int i) => state = i;
}

/// Beranda dengan lima tab: Lari, Feed, Komunitas, Chat, Profil. Semua tab tetap hidup (IndexedStack)
/// agar rekaman lari tidak terganggu saat berpindah tab. Riwayat lari dibuka dari tab Lari dan Profil
/// (`/runs`) sejak modul 2.1.
class HomeShell extends ConsumerStatefulWidget {
  const HomeShell({super.key});

  @override
  ConsumerState<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends ConsumerState<HomeShell> {
  @override
  void initState() {
    super.initState();
    // Antrean lari yang belum terunggah dicoba saat aplikasi dibuka (dulu dilakukan tab Riwayat).
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final n = await ref.read(uploadQueueProvider).flush().catchError((_) => 0);
      if (n > 0) {
        ref.invalidate(pendingUploadsProvider);
        ref.invalidate(myRunsProvider);
      }
    });
    // Langganan (modul 2.5): pembelian yang belum sempat diverifikasi server dikirim ulang sekali per sesi.
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      try {
        final config = await ref.read(authConfigProvider.future);
        if (config.subscriptionsEnabled) await ref.read(billingProvider).restore();
      } catch (_) {
        // Tanpa jaringan: dicoba lagi saat layar langganan dibuka.
      }
    });
    // Dibuka Health Connect untuk menjelaskan pemakaian izin (wajib menurut Health Connect): tampilkan penjelasan.
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final action = await launchAction();
      if (action != null && hcRationaleActions.contains(action) && mounted) context.push('/imports/health-connect/about');
    });
  }

  @override
  Widget build(BuildContext context) {
    final tab = ref.watch(homeTabProvider);
    final unread = ref.watch(unreadTotalProvider);
    final recording = ref.watch(recorderProvider.select((s) => s.status == RecorderStatus.recording || s.status == RecorderStatus.paused));
    return UpdateChecker(
      child: PushRegistrar(
      child: Scaffold(
      body: IndexedStack(
        index: tab,
        children: const [RecordScreen(), FeedScreen(), MyCommunitiesScreen(), ChatListScreen(), ProfileScreen(asTab: true)],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: tab,
        onDestinationSelected: ref.read(homeTabProvider.notifier).select,
        destinations: [
          NavigationDestination(
            icon: Badge(isLabelVisible: recording, child: const Icon(Icons.directions_run_outlined)),
            selectedIcon: const Icon(Icons.directions_run),
            label: 'Lari',
          ),
          const NavigationDestination(icon: Icon(Icons.dynamic_feed_outlined), selectedIcon: Icon(Icons.dynamic_feed), label: 'Feed'),
          const NavigationDestination(icon: Icon(Icons.groups_outlined), selectedIcon: Icon(Icons.groups), label: 'Komunitas'),
          NavigationDestination(
            icon: Badge(isLabelVisible: unread > 0, label: Text(unread > 99 ? '99+' : '$unread'), child: const Icon(Icons.chat_bubble_outline)),
            selectedIcon: const Icon(Icons.chat_bubble),
            label: 'Chat',
          ),
          const NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person), label: 'Profil'),
        ],
      ),
      ),
      ),
    );
  }
}
