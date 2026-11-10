import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../communities/screens/my_communities_screen.dart';
import '../runs/recorder.dart';
import '../runs/screens/record_screen.dart';
import '../runs/screens/runs_list_screen.dart';

final homeTabProvider = NotifierProvider<_HomeTab, int>(_HomeTab.new);

class _HomeTab extends Notifier<int> {
  @override
  int build() => 0;
  void select(int i) => state = i;
}

/// Beranda dengan tiga tab. Semua tab tetap hidup (IndexedStack) agar rekaman lari tidak terganggu
/// saat berpindah tab.
class HomeShell extends ConsumerWidget {
  const HomeShell({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tab = ref.watch(homeTabProvider);
    final recording = ref.watch(recorderProvider.select((s) => s.status == RecorderStatus.recording || s.status == RecorderStatus.paused));
    return Scaffold(
      body: IndexedStack(index: tab, children: const [RecordScreen(), RunsListScreen(), MyCommunitiesScreen()]),
      bottomNavigationBar: NavigationBar(
        selectedIndex: tab,
        onDestinationSelected: ref.read(homeTabProvider.notifier).select,
        destinations: [
          NavigationDestination(
            icon: Badge(isLabelVisible: recording, child: const Icon(Icons.directions_run_outlined)),
            selectedIcon: const Icon(Icons.directions_run),
            label: 'Lari',
          ),
          const NavigationDestination(icon: Icon(Icons.history), label: 'Riwayat'),
          const NavigationDestination(icon: Icon(Icons.groups_outlined), selectedIcon: Icon(Icons.groups), label: 'Komunitas'),
        ],
      ),
    );
  }
}
