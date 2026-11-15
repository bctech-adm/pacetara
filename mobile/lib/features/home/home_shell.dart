import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/motion.dart';
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
          body: _FadeIndexedStack(
            index: tab,
            children: const [RecordScreen(), FeedScreen(), MyCommunitiesScreen(), ChatListScreen(), ProfileScreen(asTab: true)],
          ),
          // Urutan tampilan berbeda dari indeks tab: Lari (indeks 0) di tengah sebagai tombol utama.
          bottomNavigationBar: _BottomBar(
            current: tab,
            onSelect: ref.read(homeTabProvider.notifier).select,
            recording: recording,
            unread: unread,
          ),
        ),
      ),
    );
  }
}

/// IndexedStack yang memudar saat tab berganti. Tab yang tidak tampil dibekukan (TickerMode) agar animasinya
/// tidak memakan baterai; status (termasuk rekaman lari) tetap hidup.
class _FadeIndexedStack extends StatefulWidget {
  const _FadeIndexedStack({required this.index, required this.children});
  final int index;
  final List<Widget> children;

  @override
  State<_FadeIndexedStack> createState() => _FadeIndexedStackState();
}

class _FadeIndexedStackState extends State<_FadeIndexedStack> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 260), value: 1);
  late final Animation<double> _t = CurvedAnimation(parent: _c, curve: Curves.easeOutCubic);

  @override
  void didUpdateWidget(_FadeIndexedStack old) {
    super.didUpdateWidget(old);
    if (old.index != widget.index && !reduceMotion(context)) _c.forward(from: 0);
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: _t,
      child: SlideTransition(
        position: Tween(begin: const Offset(0, 0.015), end: Offset.zero).animate(_t),
        child: IndexedStack(
          index: widget.index,
          children: [
            for (var i = 0; i < widget.children.length; i++) TickerMode(enabled: i == widget.index, child: widget.children[i]),
          ],
        ),
      ),
    );
  }
}

class _NavItem {
  const _NavItem(this.index, this.icon, this.selectedIcon, this.label);
  final int index;
  final IconData icon;
  final IconData selectedIcon;
  final String label;
}

const _leftItems = [
  _NavItem(1, Icons.dynamic_feed_outlined, Icons.dynamic_feed_rounded, 'Feed'),
  _NavItem(2, Icons.groups_outlined, Icons.groups_rounded, 'Komunitas'),
];
const _rightItems = [
  _NavItem(3, Icons.chat_bubble_outline_rounded, Icons.chat_bubble_rounded, 'Chat'),
  _NavItem(4, Icons.person_outline_rounded, Icons.person_rounded, 'Profil'),
];

class _BottomBar extends StatelessWidget {
  const _BottomBar({required this.current, required this.onSelect, required this.recording, required this.unread});
  final int current;
  final ValueChanged<int> onSelect;
  final bool recording;
  final int unread;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final bottom = MediaQuery.paddingOf(context).bottom;
    Widget item(_NavItem it) => Expanded(
          child: _NavButton(
            item: it,
            selected: current == it.index,
            badge: it.index == 3 && unread > 0 ? (unread > 99 ? '99+' : '$unread') : null,
            onTap: () => onSelect(it.index),
          ),
        );
    return Container(
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(28)),
        boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.08), blurRadius: 24, offset: const Offset(0, -4))],
      ),
      padding: EdgeInsets.fromLTRB(8, 8, 8, bottom + 8),
      child: SizedBox(
        height: 60,
        child: Row(children: [
          ..._leftItems.map(item),
          Expanded(child: _RecordButton(selected: current == 0, recording: recording, onTap: () => onSelect(0))),
          ..._rightItems.map(item),
        ]),
      ),
    );
  }
}

class _NavButton extends StatelessWidget {
  const _NavButton({required this.item, required this.selected, required this.onTap, this.badge});
  final _NavItem item;
  final bool selected;
  final VoidCallback onTap;
  final String? badge;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = selected ? theme.colorScheme.primary : theme.colorScheme.onSurfaceVariant;
    Widget icon = AnimatedSwitcher(
      duration: const Duration(milliseconds: 220),
      transitionBuilder: (c, a) => ScaleTransition(scale: a, child: c),
      child: Icon(selected ? item.selectedIcon : item.icon, key: ValueKey(selected), color: color, size: 24),
    );
    if (badge != null) icon = Badge(label: Text(badge!), child: icon);
    return Semantics(
      selected: selected,
      button: true,
      label: item.label,
      excludeSemantics: true,
      child: Pressable(
        scale: 0.9,
        child: InkWell(
          borderRadius: BorderRadius.circular(18),
          onTap: onTap,
          child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
            AnimatedContainer(
              duration: const Duration(milliseconds: 260),
              curve: Curves.easeOutCubic,
              padding: EdgeInsets.symmetric(horizontal: selected ? 18 : 10, vertical: 4),
              decoration: BoxDecoration(
                color: selected ? theme.colorScheme.primaryContainer : Colors.transparent,
                borderRadius: BorderRadius.circular(999),
              ),
              child: icon,
            ),
            const SizedBox(height: 4),
            AnimatedDefaultTextStyle(
              duration: const Duration(milliseconds: 200),
              style: (theme.textTheme.labelSmall ?? const TextStyle()).copyWith(color: color, fontWeight: selected ? FontWeight.w800 : FontWeight.w600),
              child: Text(item.label, maxLines: 1, overflow: TextOverflow.fade, softWrap: false),
            ),
          ]),
        ),
      ),
    );
  }
}

/// Tombol Lari di tengah: lingkaran bergradien. Saat merekam ada titik merah berdenyut.
class _RecordButton extends StatelessWidget {
  const _RecordButton({required this.selected, required this.recording, required this.onTap});
  final bool selected;
  final bool recording;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      selected: selected,
      button: true,
      label: recording ? 'Lari, sedang merekam' : 'Lari',
      excludeSemantics: true,
      child: Center(
        child: Pressable(
          scale: 0.88,
          child: GestureDetector(
            onTap: onTap,
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 300),
              curve: Curves.easeOutBack,
              width: selected ? 58 : 52,
              height: selected ? 58 : 52,
              decoration: BoxDecoration(
                gradient: Brand.gradient,
                shape: BoxShape.circle,
                border: Border.all(color: scheme.surface, width: 3),
                boxShadow: [
                  BoxShadow(color: Brand.orange.withValues(alpha: selected ? 0.5 : 0.3), blurRadius: selected ? 20 : 12, offset: const Offset(0, 6)),
                ],
              ),
              child: Stack(alignment: Alignment.center, children: [
                const Icon(Icons.directions_run_rounded, color: Colors.white, size: 28),
                if (recording)
                  Positioned(
                    right: 4,
                    top: 4,
                    child: PulseRings(
                      color: Colors.white,
                      spread: 6,
                      child: Container(
                        width: 12,
                        height: 12,
                        decoration: BoxDecoration(
                          color: const Color(0xFFFF1744),
                          shape: BoxShape.circle,
                          border: Border.all(color: Colors.white, width: 2),
                        ),
                      ),
                    ),
                  ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}
