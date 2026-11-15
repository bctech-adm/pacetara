import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/common.dart';
import '../../../core/widgets/motion.dart';
import '../../passport/passport_repository.dart';
import '../../passport/passport_screens.dart';
import '../runs_repository.dart';
import '../track.dart';

final myRunsProvider = FutureProvider.autoDispose<RunHistory>((ref) => ref.watch(runsRepositoryProvider).mine());

/// Tab "Riwayat": lari yang sudah tersimpan, plus antrean yang belum terunggah.
class RunsListScreen extends ConsumerStatefulWidget {
  const RunsListScreen({super.key});

  @override
  ConsumerState<RunsListScreen> createState() => _RunsListScreenState();
}

class _RunsListScreenState extends ConsumerState<RunsListScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _flushQueue(silent: true));
  }

  Future<void> _flushQueue({bool silent = false}) async {
    final n = await ref.read(uploadQueueProvider).flush();
    ref.invalidate(pendingUploadsProvider);
    if (n > 0) {
      ref.invalidate(myRunsProvider);
      if (mounted) showInfo(context, '$n lari berhasil diunggah');
    } else if (!silent && mounted && (ref.read(pendingUploadsProvider).value?.isNotEmpty ?? false)) {
      showInfo(context, 'Belum bisa mengunggah. Periksa koneksi');
    }
  }

  @override
  Widget build(BuildContext context) {
    final runs = ref.watch(myRunsProvider);
    final pending = ref.watch(pendingUploadsProvider).value ?? const <PendingUpload>[];

    return Scaffold(
      appBar: AppBar(
        title: const Text('Riwayat lari'),
        actions: [
          IconButton(tooltip: 'Paspor lari', icon: const Icon(Icons.military_tech_outlined), onPressed: () => context.push('/passport')),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async {
          await _flushQueue();
          ref.invalidate(myRunsProvider);
          ref.invalidate(runStatsProvider);
          await ref.read(myRunsProvider.future);
        },
        child: ListView(
          children: [
            const RunStatsCard(),
            if (pending.isNotEmpty)
              Card(
                margin: const EdgeInsets.all(16),
                child: ListTile(
                  leading: const Icon(Icons.cloud_upload_outlined),
                  title: Text('${pending.length} lari belum terunggah'),
                  subtitle: const Text('Tersimpan aman di HP. Tarik ke bawah atau ketuk untuk mencoba lagi.'),
                  onTap: _flushQueue,
                ),
              ),
            ...runs.when(
              loading: () => [const Padding(padding: EdgeInsets.all(48), child: Center(child: CircularProgressIndicator()))],
              error: (e, _) => [
                const SizedBox(height: 96),
                const Center(child: Text('Gagal memuat riwayat')),
                Center(child: TextButton(onPressed: () => ref.invalidate(myRunsProvider), child: const Text('Coba lagi'))),
              ],
              data: (h) => [
                if (h.items.isEmpty && pending.isEmpty)
                  const EmptyState(icon: Icons.directions_run_rounded, title: 'Belum ada lari', message: 'Belum ada lari. Mulai dari tab Lari.'),
                for (var i = 0; i < h.items.length; i++) FadeSlideIn(key: ValueKey(h.items[i].id), index: i, child: _RunTile(run: h.items[i])),
                if (h.hiddenOlder > 0)
                  Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(children: [
                      Text(
                        '${h.hiddenOlder} lari lebih lama dari ${h.historyDays} hari disembunyikan pada paket gratis. '
                        'Datanya tetap tersimpan; upgrade ke Premium untuk melihat semua.',
                        textAlign: TextAlign.center,
                      ),
                      TextButton(onPressed: () => context.push('/subscription'), child: const Text('Lihat Premium')),
                    ]),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _RunTile extends StatelessWidget {
  const _RunTile({required this.run});
  final RunSummary run;

  @override
  Widget build(BuildContext context) {
    final d = run.startedAt;
    final date = '${d.day}/${d.month}/${d.year} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
    final theme = Theme.of(context);
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 5),
      clipBehavior: Clip.antiAlias,
      child: Pressable(
        scale: 0.98,
        child: InkWell(
          onTap: () => context.push('/runs/${run.id}'),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Row(children: [
              const GradientIcon(icon: Icons.directions_run_rounded, size: 48),
              const SizedBox(width: 14),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(run.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.titleSmall),
                  const SizedBox(height: 2),
                  Text('$date · ${visibilityText(run.visibility)}', style: theme.textTheme.bodySmall),
                ]),
              ),
              const SizedBox(width: 8),
              Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
                Text(
                  '${formatDistanceKm(run.distanceM.toDouble())} km',
                  style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800, fontFeatures: tabularFigures),
                ),
                Text('${formatPaceS(run.avgPaceSPerKm?.toDouble())} /km', style: theme.textTheme.labelMedium),
              ]),
            ]),
          ),
        ),
      ),
    );
  }
}
