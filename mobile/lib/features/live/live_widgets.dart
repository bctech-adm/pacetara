import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/realtime/realtime_client.dart';
import '../communities/communities_repository.dart';
import '../communities/models.dart';
import '../communities/widgets.dart';
import '../runs/route_map.dart';
import '../runs/track.dart';
import 'live_repository.dart';
import 'live_share.dart';

/// Daftar "sedang lari" satu komunitas: dimuat saat dibuka, dimuat ulang setiap ada sinyal dari
/// WebSocket, dan cadangan polling 30 detik jika WebSocket terputus.
final communityLiveProvider = StreamProvider.autoDispose.family<List<LiveRunner>, String>((ref, communityId) {
  final api = ref.watch(liveApiProvider);
  final realtime = ref.watch(realtimeClientProvider);
  final out = StreamController<List<LiveRunner>>();
  Timer? debounce;
  var loading = false;
  var again = false;

  Future<void> load() async {
    if (loading) {
      again = true;
      return;
    }
    loading = true;
    try {
      final items = await api.community(communityId);
      if (!out.isClosed) out.add(items);
    } catch (e, st) {
      if (!out.isClosed) out.addError(e, st);
    } finally {
      loading = false;
      if (again && !out.isClosed) {
        again = false;
        unawaited(load());
      }
    }
  }

  final sub = realtime.channel('community:$communityId:live').listen((_) {
    debounce?.cancel();
    debounce = Timer(const Duration(milliseconds: 800), () => unawaited(load()));
  });
  final poll = Timer.periodic(const Duration(seconds: 30), (_) => unawaited(load()));
  unawaited(load());

  ref.onDispose(() {
    debounce?.cancel();
    poll.cancel();
    unawaited(sub.cancel());
    unawaited(out.close());
  });
  return out.stream;
});

// ---------- Pemilih berbagi di layar Lari ----------

/// Chip "Status lari" di layar rekam. Mati secara bawaan; ketuk untuk memilih komunitas.
class LiveShareChip extends ConsumerWidget {
  const LiveShareChip({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(liveShareProvider);
    final scheme = Theme.of(context).colorScheme;
    final label = !s.isOn
        ? 'Status lari: mati'
        : 'Status lari: ${s.shares.length} komunitas${s.lastSentOk == false ? ' (belum terkirim)' : ''}';
    return ActionChip(
      key: const Key('live-share-chip'),
      avatar: Icon(s.isOn ? Icons.sensors : Icons.sensors_off, size: 18, color: s.isOn ? scheme.primary : null),
      label: Text(label),
      onPressed: () => showLiveShareSheet(context, ref),
    );
  }
}

Future<void> showLiveShareSheet(BuildContext context, WidgetRef ref) async {
  final current = ref.read(liveShareProvider).shares;
  final result = await showModalBottomSheet<Map<String, bool>>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => _LiveShareSheet(initial: current),
  );
  if (result != null) ref.read(liveShareProvider.notifier).setShares(result);
}

class _LiveShareSheet extends ConsumerStatefulWidget {
  const _LiveShareSheet({required this.initial});
  final Map<String, bool> initial;

  @override
  ConsumerState<_LiveShareSheet> createState() => _LiveShareSheetState();
}

class _LiveShareSheetState extends ConsumerState<_LiveShareSheet> {
  late final Map<String, bool> _shares = Map.of(widget.initial);

  @override
  Widget build(BuildContext context) {
    final mine = ref.watch(myCommunitiesProvider);
    final theme = Theme.of(context);
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Bagikan status lari', style: theme.textTheme.titleLarge),
                const SizedBox(height: 4),
                Text(
                  'Anggota komunitas yang kamu pilih melihat nama, durasi, dan jarakmu selama lari. '
                  'Posisi di peta hanya jika kamu izinkan, dan tetap disembunyikan selama kamu masih dekat titik mulai. '
                  'Status dan titik lokasinya dihapus dari server begitu lari selesai.',
                  style: theme.textTheme.bodySmall,
                ),
              ]),
            ),
            Flexible(
              child: mine.when(
                loading: () => const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator())),
                error: (e, _) => const ListTile(title: Text('Gagal memuat komunitasmu')),
                data: (m) {
                  final active = m.items.where((c) => c.myStatus == MyStatus.active).toList();
                  if (active.isEmpty) {
                    return const ListTile(title: Text('Kamu belum bergabung ke komunitas mana pun.'));
                  }
                  return ListView(shrinkWrap: true, children: [for (final c in active) _communityRow(c)]);
                },
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
              child: Row(children: [
                if (_shares.isNotEmpty)
                  TextButton(onPressed: () => setState(_shares.clear), child: const Text('Matikan semua')),
                const Spacer(),
                FilledButton(
                  key: const Key('live-share-save'),
                  onPressed: () => Navigator.pop(context, Map<String, bool>.of(_shares)),
                  child: const Text('Simpan'),
                ),
              ]),
            ),
          ],
        ),
      ),
    );
  }

  Widget _communityRow(CommunitySummary c) {
    final on = _shares.containsKey(c.id);
    return Column(mainAxisSize: MainAxisSize.min, children: [
      SwitchListTile(
        key: Key('live-share-${c.id}'),
        secondary: CommunityLogo(name: c.name, logoUrl: c.logoUrl, size: 40),
        title: Text(c.name),
        value: on,
        onChanged: (v) => setState(() {
          if (v) {
            _shares[c.id] = false;
          } else {
            _shares.remove(c.id);
          }
        }),
      ),
      if (on)
        CheckboxListTile(
          key: Key('live-share-loc-${c.id}'),
          contentPadding: const EdgeInsets.only(left: 72, right: 16),
          dense: true,
          title: const Text('Tampilkan posisiku di peta'),
          value: _shares[c.id] ?? false,
          onChanged: (v) => setState(() => _shares[c.id] = v ?? false),
        ),
    ]);
  }
}

// ---------- Bagian "Sedang lari" di halaman komunitas ----------

class CommunityLiveSection extends ConsumerStatefulWidget {
  const CommunityLiveSection({super.key, required this.communityId});
  final String communityId;

  @override
  ConsumerState<CommunityLiveSection> createState() => _CommunityLiveSectionState();
}

class _CommunityLiveSectionState extends ConsumerState<CommunityLiveSection> {
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    // Durasi berdetak tiap detik di antara pembaruan server.
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final live = ref.watch(communityLiveProvider(widget.communityId));
    final runners = live.value ?? const <LiveRunner>[];
    final theme = Theme.of(context);
    final now = DateTime.now();
    final withPos = runners.where((r) => r.position != null).toList();

    return Column(
      key: const Key('live-section'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
          child: Row(children: [
            Icon(Icons.circle, size: 10, color: runners.isEmpty ? theme.disabledColor : Colors.green),
            const SizedBox(width: 8),
            Text(runners.isEmpty ? 'Sedang lari' : 'Sedang lari (${runners.length})', style: theme.textTheme.titleMedium),
          ]),
        ),
        if (live.isLoading && !live.hasValue)
          const Padding(padding: EdgeInsets.all(16), child: LinearProgressIndicator())
        else if (runners.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Text(live.hasError ? 'Gagal memuat status lari' : 'Belum ada yang sedang lari.', style: theme.textTheme.bodyMedium),
          )
        else ...[
          if (withPos.isNotEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: ClipRRect(borderRadius: BorderRadius.circular(12), child: _LiveMap(runners: withPos)),
            ),
          for (final r in runners)
            ListTile(
              leading: CommunityLogo(name: r.displayName, logoUrl: r.avatarUrl, size: 40),
              title: Text(r.displayName + (r.isMe ? ' (kamu)' : '')),
              subtitle: Text(_subtitle(r, now)),
              trailing: Text(
                formatDuration(r.durationAt(now)),
                style: theme.textTheme.titleMedium?.copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
              ),
            ),
        ],
      ],
    );
  }

  static String _subtitle(LiveRunner r, DateTime now) {
    final parts = <String>['${formatDistanceKm(r.distanceM)} km'];
    if (r.paused) parts.add('dijeda');
    if (r.isStale(now)) parts.add('sinyal terakhir ${_ago(now.difference(r.updatedAt))}');
    if (r.positionHidden) parts.add('posisi disembunyikan');
    return parts.join(' · ');
  }

  static String _ago(Duration d) => d.inMinutes >= 1 ? '${d.inMinutes} mnt lalu' : '${d.inSeconds} dtk lalu';
}

class _LiveMap extends StatelessWidget {
  const _LiveMap({required this.runners});
  final List<LiveRunner> runners;

  @override
  Widget build(BuildContext context) {
    final points = runners.map((r) => r.position!).toList();
    final scheme = Theme.of(context).colorScheme;
    return SizedBox(
      height: 220,
      child: FlutterMap(
        options: MapOptions(
          initialCenter: points.first,
          initialZoom: 14,
          initialCameraFit: points.length >= 2
              ? CameraFit.bounds(bounds: LatLngBounds.fromPoints(points), padding: const EdgeInsets.all(40), maxZoom: 16)
              : null,
          interactionOptions: const InteractionOptions(flags: InteractiveFlag.all & ~InteractiveFlag.rotate),
        ),
        children: [
          mapTileLayer(),
          MarkerLayer(markers: [
            for (final r in runners)
              Marker(
                point: r.position!,
                width: 120,
                height: 52,
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    decoration: BoxDecoration(color: scheme.surface, borderRadius: BorderRadius.circular(8)),
                    child: Text(r.displayName, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11)),
                  ),
                  const SizedBox(height: 2),
                  Container(
                    width: 18,
                    height: 18,
                    decoration: BoxDecoration(
                      color: r.isMe ? scheme.tertiary : scheme.primary,
                      shape: BoxShape.circle,
                      border: Border.all(color: Colors.white, width: 3),
                    ),
                  ),
                ]),
              ),
          ]),
          mapAttribution(),
        ],
      ),
    );
  }
}
