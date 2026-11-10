import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:latlong2/latlong.dart';

import '../../../core/api/api_error.dart';
import '../../../core/widgets/common.dart';
import '../../auth/auth_controller.dart';
import '../route_map.dart';
import '../runs_repository.dart';
import '../track.dart';
import 'runs_list_screen.dart';

class RunDetailScreen extends ConsumerStatefulWidget {
  const RunDetailScreen({super.key, required this.id});
  final String id;

  @override
  ConsumerState<RunDetailScreen> createState() => _RunDetailScreenState();
}

class _RunDetailScreenState extends ConsumerState<RunDetailScreen> {
  bool _showPublic = false;

  List<List<LatLng>> _toLatLng(RunRoute r) => [for (final s in r) [for (final (lat, lng) in s) LatLng(lat, lng)]];

  Future<void> _edit(RunDetail run) async {
    final title = TextEditingController(text: run.summary.title);
    final notes = TextEditingController(text: run.notes);
    var visibility = run.summary.visibility;
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (sheet) => StatefulBuilder(
        builder: (sheet, setSheet) => Padding(
          padding: EdgeInsets.fromLTRB(24, 24, 24, 24 + MediaQuery.of(sheet).viewInsets.bottom),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            TextField(controller: title, maxLength: 80, decoration: const InputDecoration(labelText: 'Judul', border: OutlineInputBorder())),
            TextField(
              controller: notes,
              maxLength: 2000,
              maxLines: 4,
              decoration: const InputDecoration(labelText: 'Catatan', border: OutlineInputBorder()),
            ),
            RadioGroup<RunVisibility>(
              groupValue: visibility,
              onChanged: (v) => setSheet(() => visibility = v ?? visibility),
              child: Column(children: [
                for (final v in RunVisibility.values)
                  RadioListTile<RunVisibility>(value: v, contentPadding: EdgeInsets.zero, title: Text(visibilityText(v))),
              ]),
            ),
            FilledButton(onPressed: () => Navigator.pop(sheet, true), child: const Text('Simpan')),
          ]),
        ),
      ),
    );
    if (saved != true) return;
    try {
      await ref.read(runsRepositoryProvider).update(run.summary.id, {
        'title': title.text.trim().isEmpty ? run.summary.title : title.text.trim(),
        'notes': notes.text.trim(),
        'visibility': visibility.name,
      });
      ref.invalidate(runDetailProvider(widget.id));
      ref.invalidate(myRunsProvider);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _delete(RunDetail run) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Hapus lari ini?'),
        content: const Text('Rute, statistik, dan foto lari ini dihapus permanen.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Batal')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Theme.of(context).colorScheme.error),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Hapus'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await ref.read(runsRepositoryProvider).delete(run.summary.id);
      ref.invalidate(myRunsProvider);
      if (mounted) context.pop();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final detail = ref.watch(runDetailProvider(widget.id));
    return detail.when(
      loading: () => Scaffold(appBar: AppBar(), body: const Center(child: CircularProgressIndicator())),
      error: (e, _) {
        final err = ApiError.from(e);
        return Scaffold(
          appBar: AppBar(),
          body: Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(err.message, textAlign: TextAlign.center))),
        );
      },
      data: (run) {
        final s = run.summary;
        final route = _showPublic && run.publicRoute != null ? run.publicRoute! : run.route;
        final d = s.startedAt;
        return Scaffold(
          appBar: AppBar(
            title: Text(s.title, overflow: TextOverflow.ellipsis),
            actions: [
              if (run.isOwner)
                PopupMenuButton<String>(
                  onSelected: (v) => v == 'edit' ? _edit(run) : _delete(run),
                  itemBuilder: (_) => const [
                    PopupMenuItem(value: 'edit', child: Text('Ubah')),
                    PopupMenuItem(value: 'delete', child: Text('Hapus')),
                  ],
                ),
            ],
          ),
          body: ListView(children: [
            if (route.isNotEmpty)
              RouteMap(segments: _toLatLng(route), height: 280)
            else
              Container(
                height: 120,
                alignment: Alignment.center,
                child: Text(run.isOwner ? 'Tidak ada rute GPS' : 'Rute disembunyikan oleh zona privasi'),
              ),
            if (run.isOwner && run.publicRoute != null)
              SwitchListTile(
                value: _showPublic,
                onChanged: (v) => setState(() => _showPublic = v),
                title: const Text('Lihat seperti orang lain'),
                subtitle: const Text('Area sekitar titik awal dan akhir disembunyikan'),
              ),
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(
                  '${d.day}/${d.month}/${d.year} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')} · ${visibilityText(s.visibility)}',
                  style: Theme.of(context).textTheme.labelLarge,
                ),
                const SizedBox(height: 16),
                Row(children: [
                  _Big(label: 'Jarak', value: '${formatDistanceKm(s.distanceM.toDouble())} km'),
                  _Big(label: 'Waktu bergerak', value: formatDuration(s.movingTimeS)),
                  _Big(label: 'Pace', value: '${formatPaceS(s.avgPaceSPerKm?.toDouble())} /km'),
                ]),
                if (run.elevationGainM != null) ...[
                  const SizedBox(height: 8),
                  Text('Total naik ${run.elevationGainM} m'),
                ],
                if (run.notes.isNotEmpty) ...[const SizedBox(height: 16), Text(run.notes)],
              ]),
            ),
            if (run.photoUrls.isNotEmpty)
              SizedBox(
                height: 180,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  itemCount: run.photoUrls.length,
                  separatorBuilder: (_, _) => const SizedBox(width: 8),
                  itemBuilder: (_, i) => _Photo(url: run.photoUrls[i]),
                ),
              ),
            const SizedBox(height: 32),
          ]),
        );
      },
    );
  }
}

class _Big extends StatelessWidget {
  const _Big({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Expanded(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(value, style: t.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
        Text(label, style: t.labelMedium),
      ]),
    );
  }
}

class _Photo extends ConsumerWidget {
  const _Photo({required this.url});
  final String url;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final bytes = ref.watch(avatarBytesProvider(url)).value;
    return ClipRRect(
      borderRadius: BorderRadius.circular(12),
      child: Container(
        width: 180,
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        child: bytes == null ? const Center(child: CircularProgressIndicator()) : Image.memory(Uint8List.fromList(bytes), fit: BoxFit.cover),
      ),
    );
  }
}
