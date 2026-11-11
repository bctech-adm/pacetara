import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/widgets/common.dart';
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
                  const Padding(
                    padding: EdgeInsets.all(48),
                    child: Text('Belum ada lari. Mulai dari tab Lari.', textAlign: TextAlign.center),
                  ),
                for (final r in h.items) _RunTile(run: r),
                if (h.hiddenOlder > 0)
                  Padding(
                    padding: const EdgeInsets.all(16),
                    child: Text(
                      '${h.hiddenOlder} lari lebih lama dari ${h.historyDays} hari disembunyikan pada paket gratis. '
                      'Datanya tetap tersimpan; upgrade ke Premium untuk melihat semua.',
                      textAlign: TextAlign.center,
                    ),
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
    return ListTile(
      onTap: () => context.push('/runs/${run.id}'),
      leading: const CircleAvatar(child: Icon(Icons.directions_run)),
      title: Text(run.title),
      subtitle: Text('$date · ${visibilityText(run.visibility)}'),
      trailing: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Text('${formatDistanceKm(run.distanceM.toDouble())} km', style: const TextStyle(fontWeight: FontWeight.w700)),
          Text('${formatPaceS(run.avgPaceSPerKm?.toDouble())} /km'),
        ],
      ),
    );
  }
}
