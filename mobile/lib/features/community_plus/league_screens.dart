import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/api_error.dart';
import 'community_plus_repository.dart';
import 'models.dart';

/// Liga antar komunitas: papan peringkat bulanan per kota. Pesertanya hanya Komunitas Pro; admin komunitas gratis
/// melihat ajakan upgrade.
class LeagueScreen extends ConsumerStatefulWidget {
  const LeagueScreen({super.key});

  @override
  ConsumerState<LeagueScreen> createState() => _LeagueScreenState();
}

class _LeagueScreenState extends ConsumerState<LeagueScreen> {
  DateTime _month = DateTime(DateTime.now().year, DateTime.now().month);
  String? _city;
  late Future<League> _future = _load();

  Future<League> _load() => ref.read(communityPlusRepositoryProvider).league(
        month: '${_month.year}-${_month.month.toString().padLeft(2, '0')}',
        city: _city,
      );

  void _reload() => setState(() => _future = _load());

  @override
  Widget build(BuildContext context) {
    const months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    final now = DateTime(DateTime.now().year, DateTime.now().month);
    return Scaffold(
      appBar: AppBar(title: const Text('Liga komunitas')),
      body: FutureBuilder<League>(
        future: _future,
        builder: (context, snap) {
          if (snap.hasError) return Center(child: Text(ApiError.from(snap.error!).message));
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final l = snap.data!;
          return RefreshIndicator(
            onRefresh: () async => _reload(),
            child: ListView(padding: const EdgeInsets.only(bottom: 32), children: [
              Row(children: [
                IconButton(
                  icon: const Icon(Icons.chevron_left),
                  onPressed: () {
                    _month = DateTime(_month.year, _month.month - 1);
                    _reload();
                  },
                ),
                Expanded(child: Text('${months[_month.month - 1]} ${_month.year}', textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleMedium)),
                IconButton(
                  icon: const Icon(Icons.chevron_right),
                  onPressed: _month.isBefore(now)
                      ? () {
                          _month = DateTime(_month.year, _month.month + 1);
                          _reload();
                        }
                      : null,
                ),
              ]),
              if (l.cities.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: DropdownButtonFormField<String>(
                    initialValue: l.cities.contains(l.city) ? l.city : null,
                    decoration: const InputDecoration(labelText: 'Kota'),
                    items: [for (final c in l.cities) DropdownMenuItem(value: c, child: Text(c))],
                    onChanged: (v) {
                      _city = v;
                      _reload();
                    },
                  ),
                ),
              for (final m in l.mine.where((m) => m.upgradeRequired))
                Card(
                  margin: const EdgeInsets.all(16),
                  child: ListTile(
                    leading: const Icon(Icons.workspace_premium_outlined),
                    title: Text('${m.name} belum ikut liga'),
                    subtitle: const Text('Liga antar komunitas khusus Komunitas Pro'),
                    trailing: m.isOwner ? const Icon(Icons.chevron_right) : null,
                    onTap: m.isOwner ? () => context.push('/subscription/community/${m.communityId}') : null,
                  ),
                ),
              if (l.items.isEmpty)
                const Padding(padding: EdgeInsets.all(32), child: Center(child: Text('Belum ada komunitas Pro di liga kota ini')))
              else
                for (final e in l.items)
                  ListTile(
                    leading: CircleAvatar(child: Text('${e.rank}')),
                    title: Row(children: [
                      Flexible(child: Text(e.name, overflow: TextOverflow.ellipsis)),
                      if (l.mine.any((m) => m.communityId == e.communityId)) ...[const SizedBox(width: 6), const Icon(Icons.star, size: 16)],
                    ]),
                    subtitle: Text('${kmLabel(e.totalM)} · ${e.runs} lari · ${e.activeMembers} pelari aktif'),
                    trailing: Text('${kmLabel(e.scoreM)}\n/pelari', textAlign: TextAlign.right, style: Theme.of(context).textTheme.labelSmall),
                  ),
              Padding(padding: const EdgeInsets.all(16), child: Text(l.rules, style: Theme.of(context).textTheme.bodySmall)),
            ]),
          );
        },
      ),
    );
  }
}

/// Statistik komunitas (Komunitas Pro, admin): total km, jumlah lari, pelari aktif per minggu/bulan.
class CommunityStatsScreen extends ConsumerStatefulWidget {
  const CommunityStatsScreen({super.key, required this.communityId, this.isOwner = false});
  final String communityId;
  final bool isOwner;

  @override
  ConsumerState<CommunityStatsScreen> createState() => _CommunityStatsScreenState();
}

class _CommunityStatsScreenState extends ConsumerState<CommunityStatsScreen> {
  String _period = 'week';
  late Future<List<StatsPoint>> _future = _load();

  Future<List<StatsPoint>> _load() => ref.read(communityPlusRepositoryProvider).stats(widget.communityId, period: _period);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Statistik komunitas')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        SegmentedButton<String>(
          segments: const [ButtonSegment(value: 'week', label: Text('Mingguan')), ButtonSegment(value: 'month', label: Text('Bulanan'))],
          selected: {_period},
          onSelectionChanged: (v) => setState(() {
            _period = v.first;
            _future = _load();
          }),
        ),
        const SizedBox(height: 12),
        FutureBuilder<List<StatsPoint>>(
          future: _future,
          builder: (context, snap) {
            if (snap.hasError) {
              final err = ApiError.from(snap.error!);
              if (err.code == 'limit_reached') {
                return Column(children: [
                  Text(err.message),
                  const SizedBox(height: 8),
                  if (widget.isOwner)
                    FilledButton(onPressed: () => context.push('/subscription/community/${widget.communityId}'), child: const Text('Lihat Komunitas Pro')),
                ]);
              }
              return Text(err.message);
            }
            if (!snap.hasData) return const Center(child: CircularProgressIndicator());
            final series = snap.data!;
            final maxM = series.fold<int>(1, (a, p) => p.totalM > a ? p.totalM : a);
            return Column(children: [
              for (final p in series.reversed)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(p.start),
                  subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    LinearProgressIndicator(value: p.totalM / maxM),
                    const SizedBox(height: 4),
                    Text('${kmLabel(p.totalM)} · ${p.runs} lari · ${p.activeMembers} pelari aktif · ${p.sessions} sesi (${p.attendees} hadir)'),
                  ]),
                ),
              const SizedBox(height: 8),
              Text(
                'Lari Strava, lari tanpa rute terverifikasi, dan lari "hanya saya" tidak dihitung.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ]);
          },
        ),
      ]),
    );
  }
}

/// Ubin pintasan fitur komunitas modul 2.6 di halaman komunitas.
class CommunityPlusTiles extends StatelessWidget {
  const CommunityPlusTiles({super.key, required this.communityId, required this.isStaff, required this.isOwner, required this.isPro});
  final String communityId;
  final bool isStaff;
  final bool isOwner;
  final bool isPro;

  @override
  Widget build(BuildContext context) {
    final q = '?staff=$isStaff&owner=$isOwner';
    Widget tile(IconData icon, String title, String subtitle, String route, {bool pro = false, Key? key}) => ListTile(
          key: key,
          leading: Icon(icon),
          title: Text(title),
          subtitle: Text(pro && !isPro ? '$subtitle · Komunitas Pro' : subtitle),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => context.push(route),
        );
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Padding(padding: const EdgeInsets.fromLTRB(16, 16, 16, 0), child: Text('Kegiatan', style: Theme.of(context).textTheme.titleMedium)),
      tile(Icons.event_repeat, 'Jadwal lari', 'RSVP sesi lari bareng dan absensi', '/communities/$communityId/sessions$q', key: const Key('tile-sessions')),
      tile(Icons.account_balance_wallet_outlined, 'Kas komunitas', 'Pencatatan pemasukan dan pengeluaran', '/communities/$communityId/cash$q', pro: true),
      tile(Icons.checkroom_outlined, 'Pre-order jersey', 'Catat pesanan jersey anggota', '/communities/$communityId/jersey$q', pro: true),
      if (isStaff) tile(Icons.insights_outlined, 'Statistik komunitas', 'Aktivitas anggota per minggu/bulan', '/communities/$communityId/stats$q', pro: true),
      tile(Icons.emoji_events_outlined, 'Liga komunitas', 'Papan peringkat bulanan per kota', '/league', pro: true),
    ]);
  }
}

