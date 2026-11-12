import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_error.dart';
import '../../core/widgets/common.dart';
import '../chat/chat_screens.dart' show openDirectChat;
import '../communities/widgets.dart';
import '../feed/feed_screens.dart' show UserAvatar;
import '../moderation/moderation.dart';
import 'community_plus_repository.dart';
import 'models.dart';
import 'point_picker.dart';

/// Cari teman lari. Opt-in: tanpa profil pencarian kamu tidak pernah muncul. Gratis mencari per kota; filter pace,
/// jarak lokasi, dan jam khusus Premium (ditegakkan server). Sapa harus diterima sebelum bisa mengobrol.
class BuddyScreen extends ConsumerWidget {
  const BuddyScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = ref.watch(buddyProfileProvider);
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Cari teman lari'),
          actions: [
            if (p.value?.profile != null)
              IconButton(
                tooltip: 'Profil pencarian',
                icon: const Icon(Icons.tune),
                onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => BuddyProfileScreen(initial: p.value!.profile))),
              ),
          ],
          bottom: p.value?.profile == null ? null : const TabBar(tabs: [Tab(text: 'Cari'), Tab(text: 'Sapaan')]),
        ),
        body: p.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => Center(child: Text(ApiError.from(e).message)),
          data: (d) => d.profile == null
              ? const _Intro()
              : TabBarView(children: [_SearchTab(filters: d.filters, profile: d.profile!), const _RequestsTab()]),
        ),
      ),
    );
  }
}

class _Intro extends StatelessWidget {
  const _Intro();

  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.all(24), children: [
        const Icon(Icons.diversity_3, size: 64),
        const SizedBox(height: 16),
        Text('Temukan teman lari dengan pace dan jam yang cocok', style: Theme.of(context).textTheme.titleLarge, textAlign: TextAlign.center),
        const SizedBox(height: 12),
        const Text(
          'Fitur ini mati sampai kamu menyalakannya. Pengguna lain yang juga menyalakannya akan melihat nama, foto, pace, kota, '
          'jam lari favorit, dan perkiraan jarak dari area yang kamu pilih sendiri (dibulatkan ±2 km). Lokasi dari rute lari '
          'tidak pernah dipakai.',
        ),
        const SizedBox(height: 24),
        FilledButton(
          key: const Key('buddy-start'),
          onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const BuddyProfileScreen())),
          child: const Text('Nyalakan Cari teman lari'),
        ),
      ]);
}

/// Profil pencarian + persetujuan eksplisit.
class BuddyProfileScreen extends ConsumerStatefulWidget {
  const BuddyProfileScreen({super.key, this.initial});
  final BuddyProfile? initial;

  @override
  ConsumerState<BuddyProfileScreen> createState() => _BuddyProfileScreenState();
}

class _BuddyProfileScreenState extends ConsumerState<BuddyProfileScreen> {
  late final _city = TextEditingController(text: widget.initial?.city ?? '');
  late final _pace = TextEditingController(text: widget.initial == null ? '6:30' : paceLabel(widget.initial!.paceSPerKm).replaceAll('/km', ''));
  late final Set<String> _slots = {...?widget.initial?.slots};
  late GeoPoint? _area = widget.initial?.area;
  late bool _enabled = widget.initial?.enabled ?? true;
  bool _consent = false;

  @override
  void dispose() {
    _city.dispose();
    _pace.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isNew = widget.initial == null;
    return Scaffold(
      appBar: AppBar(title: const Text('Profil pencarian')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        TextField(controller: _city, decoration: const InputDecoration(labelText: 'Kota')),
        TextField(controller: _pace, decoration: const InputDecoration(labelText: 'Pace rata-rata (mis. 6:30)')),
        const SizedBox(height: 12),
        const Text('Jam lari favorit'),
        Wrap(spacing: 8, children: [
          for (final e in buddySlots.entries)
            FilterChip(
              label: Text(e.value),
              selected: _slots.contains(e.key),
              onSelected: (v) => setState(() => v ? _slots.add(e.key) : _slots.remove(e.key)),
            ),
        ]),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.place_outlined),
          title: Text(_area == null ? 'Area lari (opsional)' : 'Area lari dipilih (±2 km)'),
          subtitle: const Text('Pilih area umum tempat kamu biasa lari, bukan rumah. Dibulatkan ±2 km sebelum disimpan'),
          trailing: _area == null ? null : IconButton(icon: const Icon(Icons.close), onPressed: () => setState(() => _area = null)),
          onTap: () async {
            final p = await PointPickerScreen.pick(context, title: 'Area lari', initial: _area, hint: 'Geser peta ke area umum tempat kamu biasa lari.');
            if (p != null) setState(() => _area = p);
          },
        ),
        if (!isNew) SwitchListTile(contentPadding: EdgeInsets.zero, value: _enabled, onChanged: (v) => setState(() => _enabled = v), title: const Text('Terlihat di pencarian')),
        if (isNew)
          CheckboxListTile(
            key: const Key('buddy-consent'),
            contentPadding: EdgeInsets.zero,
            value: _consent,
            onChanged: (v) => setState(() => _consent = v ?? false),
            title: const Text('Saya setuju nama, foto, pace, kota, jam favorit, dan perkiraan jarak area saya terlihat oleh pengguna lain yang juga memakai Cari teman lari.'),
          ),
        const SizedBox(height: 16),
        AsyncButton(
          label: 'Simpan',
          onPressed: isNew && !_consent
              ? null
              : () async {
                  final m = RegExp(r'^(\d{1,2}):([0-5]\d)$').firstMatch(_pace.text.trim());
                  if (m == null) throw const ApiError(0, 'invalid_input', 'Isi pace dengan format menit:detik, mis. 6:30');
                  await ref.read(communityPlusRepositoryProvider).saveBuddyProfile({
                    'paceSPerKm': int.parse(m[1]!) * 60 + int.parse(m[2]!),
                    'city': _city.text.trim(),
                    'area': _area?.toJson(),
                    'slots': _slots.toList(),
                    'enabled': _enabled,
                    if (isNew) 'consent': true,
                  });
                  ref.invalidate(buddyProfileProvider);
                  if (context.mounted) Navigator.pop(context);
                },
        ),
        if (!isNew)
          TextButton(
            onPressed: () async {
              if (!await confirm(context, title: 'Matikan Cari teman lari?', message: 'Profil pencarian dan sapaan yang belum dijawab dihapus. Teman yang sudah menerima sapaan tetap.', action: 'Matikan', destructive: true)) return;
              await ref.read(communityPlusRepositoryProvider).deleteBuddyProfile();
              ref.invalidate(buddyProfileProvider);
              if (context.mounted) Navigator.pop(context);
            },
            child: const Text('Matikan dan hapus profil pencarian'),
          ),
      ]),
    );
  }
}

class _SearchTab extends ConsumerStatefulWidget {
  const _SearchTab({required this.filters, required this.profile});
  final bool filters;
  final BuddyProfile profile;

  @override
  ConsumerState<_SearchTab> createState() => _SearchTabState();
}

class _SearchTabState extends ConsumerState<_SearchTab> {
  double? _maxKm;
  RangeValues? _pace;
  final Set<String> _slots = {};
  Future<List<BuddyResult>>? _future;

  Map<String, dynamic> get _query => {
        if (_maxKm != null) 'maxDistanceKm': _maxKm,
        if (_pace != null) 'paceMinSPerKm': _pace!.start.round(),
        if (_pace != null) 'paceMaxSPerKm': _pace!.end.round(),
        if (_slots.isNotEmpty) 'slots': _slots.toList(),
      };

  Future<void> _search() async {
    final f = ref.read(communityPlusRepositoryProvider).searchBuddies(_query);
    setState(() => _future = f);
    try {
      await f;
    } catch (e) {
      final err = ApiError.from(e);
      if (err.code == 'limit_reached' && mounted) await showLimitDialog(context, err.message, kind: err.limitKind);
    }
  }

  /// Filter Premium: untuk akun gratis tampil terkunci dan membuka dialog upgrade.
  void _premium(VoidCallback apply) {
    if (!widget.filters) {
      showLimitDialog(context, 'Filter pace, jarak lokasi, dan jam khusus Premium. Paket gratis mencari per kota', kind: 'buddy_filters');
      return;
    }
    setState(apply);
  }

  @override
  Widget build(BuildContext context) {
    return ListView(padding: const EdgeInsets.all(16), children: [
      Text('Kota: ${widget.profile.city}', style: Theme.of(context).textTheme.titleSmall),
      const SizedBox(height: 8),
      Wrap(spacing: 8, runSpacing: 4, children: [
        FilterChip(
          avatar: widget.filters ? null : const Icon(Icons.lock_outline, size: 16),
          label: Text(_maxKm == null ? 'Jarak' : '≤ ${_maxKm!.round()} km'),
          selected: _maxKm != null,
          onSelected: (_) => _premium(() => _maxKm = _maxKm == null ? 10 : null),
        ),
        FilterChip(
          avatar: widget.filters ? null : const Icon(Icons.lock_outline, size: 16),
          label: Text(_pace == null ? 'Pace' : '${paceLabel(_pace!.start.round())} – ${paceLabel(_pace!.end.round())}'),
          selected: _pace != null,
          onSelected: (_) => _premium(() {
            final p = widget.profile.paceSPerKm.toDouble();
            _pace = _pace == null ? RangeValues((p - 45).clamp(180, 1200), (p + 45).clamp(180, 1200)) : null;
          }),
        ),
        for (final e in buddySlots.entries)
          FilterChip(
            avatar: widget.filters ? null : const Icon(Icons.lock_outline, size: 16),
            label: Text(e.value.split(' ').first),
            selected: _slots.contains(e.key),
            onSelected: (v) => _premium(() => v ? _slots.add(e.key) : _slots.remove(e.key)),
          ),
      ]),
      if (_maxKm != null)
        Slider(value: _maxKm!, min: 1, max: 50, divisions: 49, label: '${_maxKm!.round()} km', onChanged: (v) => setState(() => _maxKm = v)),
      if (_pace != null)
        RangeSlider(values: _pace!, min: 180, max: 900, divisions: 72, onChanged: (v) => setState(() => _pace = v)),
      const SizedBox(height: 8),
      FilledButton.icon(key: const Key('buddy-search'), onPressed: _search, icon: const Icon(Icons.search), label: const Text('Cari')),
      const SizedBox(height: 8),
      if (_future != null)
        FutureBuilder<List<BuddyResult>>(
          future: _future,
          builder: (context, snap) {
            if (snap.hasError) return Text(ApiError.from(snap.error!).message);
            if (!snap.hasData) return const Center(child: CircularProgressIndicator());
            if (snap.data!.isEmpty) return const Padding(padding: EdgeInsets.all(24), child: Text('Belum ada yang cocok. Coba lagi nanti.'));
            return Column(children: [for (final b in snap.data!) BuddyTile(buddy: b, onChanged: _search)]);
          },
        ),
    ]);
  }
}

class BuddyTile extends ConsumerWidget {
  const BuddyTile({super.key, required this.buddy, required this.onChanged});
  final BuddyResult buddy;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final b = buddy;
    final repo = ref.read(communityPlusRepositoryProvider);
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: UserAvatar(name: b.displayName, url: b.avatarUrl),
      title: Text(b.displayName),
      subtitle: Text([
        if (b.paceSPerKm != null) paceLabel(b.paceSPerKm),
        ?b.city,
        if (b.distanceKm != null) '±${b.distanceKm} km',
        if (b.slots.isNotEmpty) b.slots.map((s) => buddySlots[s]?.split(' ').first ?? s).join(', '),
      ].join(' · ')),
      trailing: switch (b.connection) {
        'connected' => IconButton(tooltip: 'Chat', icon: const Icon(Icons.chat_bubble_outline), onPressed: () => openDirectChat(context, ref, b.userId)),
        'sent' => const Text('Terkirim'),
        'received' => const Text('Menyapamu'),
        _ => TextButton(
            onPressed: () async {
              if (await runCommunityAction(context, () => repo.greet(b.userId), success: 'Sapaan terkirim')) onChanged();
            },
            child: const Text('Sapa'),
          ),
      },
      onLongPress: () => showModalBottomSheet<void>(
        context: context,
        builder: (sheet) => SafeArea(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            ListTile(
              leading: const Icon(Icons.flag_outlined),
              title: const Text('Laporkan'),
              onTap: () {
                Navigator.pop(sheet);
                showReportSheet(context, ref, target: ReportTarget.user, targetId: b.userId, title: 'Laporkan ${b.displayName}');
              },
            ),
            ListTile(
              leading: const Icon(Icons.block),
              title: const Text('Blokir'),
              subtitle: const Text('Kalian tidak saling melihat di feed dan Cari teman lari'),
              onTap: () async {
                Navigator.pop(sheet);
                await ref.read(blockUserProvider)(b.userId);
                onChanged();
              },
            ),
          ]),
        ),
      ),
    );
  }
}

class _RequestsTab extends ConsumerWidget {
  const _RequestsTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final r = ref.watch(buddyRequestsProvider);
    final repo = ref.read(communityPlusRepositoryProvider);
    void refresh() => ref.invalidate(buddyRequestsProvider);
    return r.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => Center(child: Text(ApiError.from(e).message)),
      data: (d) => RefreshIndicator(
        onRefresh: () async => refresh(),
        child: ListView(padding: const EdgeInsets.all(16), children: [
          Text('Menyapamu', style: Theme.of(context).textTheme.titleSmall),
          if (d.incoming.isEmpty) const Padding(padding: EdgeInsets.all(8), child: Text('Belum ada sapaan')),
          for (final b in d.incoming)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: UserAvatar(name: b.displayName, url: b.avatarUrl),
              title: Text(b.displayName),
              subtitle: Text([if (b.paceSPerKm != null) paceLabel(b.paceSPerKm), ?b.city].join(' · ')),
              trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                IconButton(
                  tooltip: 'Tolak',
                  icon: const Icon(Icons.close),
                  onPressed: () async {
                    await repo.respondBuddy(b.requestId!, false);
                    refresh();
                  },
                ),
                IconButton(
                  tooltip: 'Terima',
                  icon: const Icon(Icons.check),
                  onPressed: () async {
                    await repo.respondBuddy(b.requestId!, true);
                    refresh();
                  },
                ),
              ]),
            ),
          const Divider(),
          Text('Teman lari', style: Theme.of(context).textTheme.titleSmall),
          if (d.connected.isEmpty) const Padding(padding: EdgeInsets.all(8), child: Text('Belum ada')),
          for (final b in d.connected) BuddyTile(buddy: b, onChanged: refresh),
          if (d.outgoing.isNotEmpty) ...[
            const Divider(),
            Text('Sapaan terkirim', style: Theme.of(context).textTheme.titleSmall),
            for (final b in d.outgoing)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: UserAvatar(name: b.displayName, url: b.avatarUrl),
                title: Text(b.displayName),
                trailing: TextButton(
                  onPressed: () async {
                    await repo.disconnectBuddy(b.userId);
                    refresh();
                  },
                  child: const Text('Batalkan'),
                ),
              ),
          ],
          const SizedBox(height: 16),
          Text('Chat pribadi terbuka setelah sapaan diterima.', style: Theme.of(context).textTheme.bodySmall),
        ]),
      ),
    );
  }
}

/// Blokir lewat endpoint blokir feed (modul 2.1): juga memutus Cari teman lari.
final blockUserProvider = Provider<Future<void> Function(String userId)>((ref) {
  final repo = ref.watch(communityPlusRepositoryProvider);
  return (userId) => repo.blockUser(userId);
});

