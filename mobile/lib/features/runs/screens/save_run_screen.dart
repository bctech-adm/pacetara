import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:latlong2/latlong.dart';

import '../../../core/api/api_error.dart';
import '../../../core/widgets/common.dart';
import '../recorder.dart';
import '../route_map.dart';
import '../runs_repository.dart';
import '../track.dart';

/// Judul bawaan menurut jam mulai.
String defaultRunTitle(DateTime start) {
  final h = start.hour;
  final part = h < 11 ? 'pagi' : h < 15 ? 'siang' : h < 18 ? 'sore' : 'malam';
  return 'Lari $part';
}

/// Setelah selesai merekam: judul, catatan, foto, visibilitas, lalu simpan (antrean upload).
class SaveRunScreen extends ConsumerStatefulWidget {
  const SaveRunScreen({super.key});

  @override
  ConsumerState<SaveRunScreen> createState() => _SaveRunScreenState();
}

class _SaveRunScreenState extends ConsumerState<SaveRunScreen> {
  late final TextEditingController _title;
  final _notes = TextEditingController();
  RunVisibility _visibility = RunVisibility.community;
  final List<String> _photos = [];

  @override
  void initState() {
    super.initState();
    final start = ref.read(recorderProvider).track?.startedAt ?? DateTime.now();
    _title = TextEditingController(text: defaultRunTitle(start));
  }

  @override
  void dispose() {
    _title.dispose();
    _notes.dispose();
    super.dispose();
  }

  Future<void> _addPhoto() async {
    final picked = await ImagePicker().pickMultiImage(limit: 4 - _photos.length, maxWidth: 2048, imageQuality: 90);
    if (picked.isEmpty) return;
    setState(() => _photos.addAll(picked.take(4 - _photos.length).map((x) => x.path)));
  }

  Future<void> _save() async {
    final s = ref.read(recorderProvider);
    final track = s.track!;
    final title = _title.text.trim().isEmpty ? defaultRunTitle(track.startedAt) : _title.text.trim();
    final body = {
      'clientRunId': s.clientRunId,
      'title': title,
      'notes': _notes.text.trim(),
      'visibility': _visibility.name,
      'startedAt': track.startedAt.toUtc().toIso8601String(),
      'endedAt': (s.endedAt ?? DateTime.now()).toUtc().toIso8601String(),
      'segments': track.segmentsJson(),
    };
    final queue = ref.read(uploadQueueProvider);
    final router = GoRouter.of(context);
    final messenger = ScaffoldMessenger.of(context);

    // Simpan ke antrean di HP dulu: lari aman walau upload gagal.
    final item = await queue.enqueue(body, _photos);
    await ref.read(recorderProvider.notifier).reset();
    ref.invalidate(pendingUploadsProvider);
    try {
      final run = await queue.upload(item);
      ref.invalidate(pendingUploadsProvider);
      router.go('/');
      router.push('/runs/${run.summary.id}');
    } catch (e) {
      final err = ApiError.from(e);
      messenger.showSnackBar(SnackBar(
        content: Text(err.code == 'network'
            ? 'Lari tersimpan di HP dan akan diunggah saat koneksi tersedia'
            : 'Lari tersimpan di HP, unggah gagal: ${err.message}'),
      ));
      router.go('/');
    }
  }

  Future<void> _discard() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Buang lari ini?'),
        content: const Text('Rekaman dihapus dari HP dan tidak bisa dikembalikan.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Batal')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Theme.of(context).colorScheme.error),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Buang'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    await ref.read(recorderProvider.notifier).reset();
    if (mounted) context.go('/');
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(recorderProvider);
    final track = s.track;
    if (track == null) return const Scaffold(body: Center(child: Text('Tidak ada rekaman')));
    final segments = [for (final seg in track.segments) [for (final p in seg) LatLng(p.lat, p.lng)]];

    return FormPage(
      title: 'Simpan lari',
      children: [
        ClipRRect(borderRadius: BorderRadius.circular(12), child: RouteMap(segments: segments, height: 200, interactive: false)),
        const SizedBox(height: 16),
        Row(children: [
          _Mini(label: 'Jarak', value: '${formatDistanceKm(track.distanceM)} km'),
          _Mini(label: 'Durasi', value: formatDuration(s.activeSeconds)),
          _Mini(label: 'Pace', value: '${formatPaceS(track.avgPaceSPerKm)} /km'),
        ]),
        const SizedBox(height: 16),
        TextField(
          controller: _title,
          maxLength: 80,
          decoration: const InputDecoration(labelText: 'Judul', border: OutlineInputBorder()),
        ),
        const SizedBox(height: 8),
        TextField(
          controller: _notes,
          maxLength: 2000,
          minLines: 2,
          maxLines: 5,
          decoration: const InputDecoration(labelText: 'Catatan', alignLabelWithHint: true, border: OutlineInputBorder()),
        ),
        const SizedBox(height: 8),
        Text('Foto (${_photos.length}/4)', style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: 8),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final p in _photos)
            Stack(children: [
              ClipRRect(borderRadius: BorderRadius.circular(8), child: Image.file(File(p), width: 80, height: 80, fit: BoxFit.cover)),
              Positioned(
                right: 0,
                top: 0,
                child: InkWell(
                  onTap: () => setState(() => _photos.remove(p)),
                  child: const CircleAvatar(radius: 12, child: Icon(Icons.close, size: 14)),
                ),
              ),
            ]),
          if (_photos.length < 4)
            OutlinedButton(
              style: OutlinedButton.styleFrom(fixedSize: const Size(80, 80), padding: EdgeInsets.zero),
              onPressed: _addPhoto,
              child: const Icon(Icons.add_a_photo_outlined),
            ),
        ]),
        const SizedBox(height: 16),
        Text('Siapa yang bisa melihat', style: Theme.of(context).textTheme.titleSmall),
        RadioGroup<RunVisibility>(
          groupValue: _visibility,
          onChanged: (v) => setState(() => _visibility = v ?? _visibility),
          child: Column(children: [
            for (final v in RunVisibility.values)
              RadioListTile<RunVisibility>(value: v, contentPadding: EdgeInsets.zero, title: Text(visibilityText(v))),
          ]),
        ),
        const Text('Area sekitar titik awal dan akhir lari disembunyikan dari orang lain (zona privasi).'),
        const SizedBox(height: 16),
        AsyncButton(label: 'Simpan', onPressed: _save),
        const SizedBox(height: 8),
        TextButton(onPressed: _discard, child: const Text('Buang lari')),
      ],
    );
  }
}

class _Mini extends StatelessWidget {
  const _Mini({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Expanded(
      child: Column(children: [
        Text(value, style: t.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
        Text(label, style: t.labelSmall),
      ]),
    );
  }
}
