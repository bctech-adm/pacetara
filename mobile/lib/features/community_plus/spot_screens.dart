import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:latlong2/latlong.dart';

import '../../core/api/api_error.dart';
import '../../core/widgets/common.dart';
import '../moderation/moderation.dart';
import '../runs/route_map.dart';
import 'community_plus_repository.dart';
import 'models.dart';
import 'point_picker.dart';

/// Peta spot lari lokal (penerangan, toilet, parkir). Spot tayang setelah disetujui tim PaceTara.
/// Area peta dikirim di body permintaan (bukan URL) dan hanya dimuat saat peta cukup diperbesar.
class SpotsMapScreen extends ConsumerStatefulWidget {
  const SpotsMapScreen({super.key});

  @override
  ConsumerState<SpotsMapScreen> createState() => _SpotsMapScreenState();
}

class _SpotsMapScreenState extends ConsumerState<SpotsMapScreen> {
  final _map = MapController();
  List<RunSpot> _spots = const [];
  Timer? _debounce;
  bool _tooWide = false;

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  void _onMove(MapCamera camera) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 600), () => _load(camera));
  }

  Future<void> _load(MapCamera camera) async {
    final b = camera.visibleBounds;
    final wide = (b.north - b.south) > 1 || (b.east - b.west) > 1;
    if (wide) {
      if (mounted) setState(() => _tooWide = true);
      return;
    }
    try {
      final spots = await ref.read(communityPlusRepositoryProvider).spotsInBox(minLat: b.south, minLng: b.west, maxLat: b.north, maxLng: b.east);
      if (mounted) {
        setState(() {
          _spots = spots;
          _tooWide = false;
        });
      }
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  void _show(RunSpot s) {
    showModalBottomSheet<void>(
      context: context,
      builder: (sheet) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(s.name, style: Theme.of(context).textTheme.titleLarge),
            Text(s.city),
            const SizedBox(height: 8),
            Text(lightingLabel(s.lighting)),
            Text(yesNo(s.toilet, 'Toilet')),
            Text(yesNo(s.parking, 'Parkir')),
            if (s.notes.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text(s.notes)),
            TextButton.icon(
              icon: const Icon(Icons.flag_outlined),
              label: const Text('Laporkan spot'),
              onPressed: () {
                Navigator.pop(sheet);
                showReportSheet(context, ref, target: ReportTarget.spot, targetId: s.id, title: 'Laporkan ${s.name}');
              },
            ),
          ]),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Spot lari'),
        actions: [
          IconButton(
            tooltip: 'Kiriman saya',
            icon: const Icon(Icons.history),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const MySpotsScreen())),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        key: const Key('add-spot'),
        icon: const Icon(Icons.add_location_alt_outlined),
        label: const Text('Kirim spot'),
        onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const SpotFormScreen())),
      ),
      body: Stack(children: [
        FlutterMap(
          mapController: _map,
          options: MapOptions(
            initialCenter: const LatLng(-6.2, 106.82),
            initialZoom: 12,
            interactionOptions: const InteractionOptions(flags: InteractiveFlag.all & ~InteractiveFlag.rotate),
            onMapReady: () => _load(_map.camera),
            onPositionChanged: (camera, _) => _onMove(camera),
          ),
          children: [
            mapTileLayer(),
            MarkerLayer(markers: [
              for (final s in _spots)
                Marker(
                  point: LatLng(s.point.lat, s.point.lng),
                  width: 40,
                  height: 40,
                  child: GestureDetector(onTap: () => _show(s), child: const Icon(Icons.directions_run, color: Colors.deepOrange, size: 32)),
                ),
            ]),
            mapAttribution(),
          ],
        ),
        if (_tooWide)
          const Positioned(left: 12, right: 12, top: 12, child: Card(child: Padding(padding: EdgeInsets.all(12), child: Text('Perbesar peta untuk melihat spot lari')))),
      ]),
    );
  }
}

/// Kirim spot baru (masuk antrean tinjauan).
class SpotFormScreen extends ConsumerStatefulWidget {
  const SpotFormScreen({super.key});

  @override
  ConsumerState<SpotFormScreen> createState() => _SpotFormScreenState();
}

class _SpotFormScreenState extends ConsumerState<SpotFormScreen> {
  final _name = TextEditingController();
  final _city = TextEditingController();
  final _notes = TextEditingController();
  GeoPoint? _point;
  int? _lighting;
  bool? _toilet;
  bool? _parking;

  @override
  void dispose() {
    _name.dispose();
    _city.dispose();
    _notes.dispose();
    super.dispose();
  }

  Widget _tri(String label, bool? value, ValueChanged<bool?> onChanged) => Row(children: [
        Expanded(child: Text(label)),
        SegmentedButton<int>(
          emptySelectionAllowed: true,
          segments: const [ButtonSegment(value: 1, label: Text('Ada')), ButtonSegment(value: 0, label: Text('Tidak'))],
          selected: {if (value != null) (value ? 1 : 0)},
          onSelectionChanged: (s) => onChanged(s.isEmpty ? null : s.first == 1),
        ),
      ]);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Kirim spot lari')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        const Text('Spot tampil di peta setelah ditinjau tim PaceTara. Kirim tempat umum saja (taman, GOR, jalur lari), bukan rumah.'),
        TextField(controller: _name, maxLength: 80, decoration: const InputDecoration(labelText: 'Nama tempat')),
        TextField(controller: _city, maxLength: 60, decoration: const InputDecoration(labelText: 'Kota')),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.place_outlined),
          title: Text(_point == null ? 'Pilih titik di peta' : 'Titik dipilih'),
          onTap: () async {
            final p = await PointPickerScreen.pick(context, title: 'Lokasi spot', initial: _point);
            if (p != null) setState(() => _point = p);
          },
        ),
        DropdownButtonFormField<int?>(
          initialValue: _lighting,
          decoration: const InputDecoration(labelText: 'Penerangan'),
          items: const [
            DropdownMenuItem(value: null, child: Text('Tidak tahu')),
            DropdownMenuItem(value: 0, child: Text('Tidak ada')),
            DropdownMenuItem(value: 1, child: Text('Sebagian')),
            DropdownMenuItem(value: 2, child: Text('Terang')),
          ],
          onChanged: (v) => setState(() => _lighting = v),
        ),
        const SizedBox(height: 8),
        _tri('Toilet', _toilet, (v) => setState(() => _toilet = v)),
        _tri('Parkir', _parking, (v) => setState(() => _parking = v)),
        TextField(controller: _notes, maxLength: 300, maxLines: 3, decoration: const InputDecoration(labelText: 'Catatan (opsional)')),
        const SizedBox(height: 16),
        AsyncButton(
          label: 'Kirim',
          onPressed: () async {
            if (_point == null) throw const ApiError(0, 'invalid_input', 'Pilih titik spot di peta');
            await ref.read(communityPlusRepositoryProvider).submitSpot({
              'name': _name.text.trim(),
              'city': _city.text.trim(),
              'point': _point!.toJson(),
              'lighting': _lighting,
              'toilet': _toilet,
              'parking': _parking,
              if (_notes.text.trim().isNotEmpty) 'notes': _notes.text.trim(),
            });
            if (!context.mounted) return;
            showInfo(context, 'Terima kasih! Spot akan tampil setelah ditinjau');
            Navigator.pop(context);
          },
        ),
      ]),
    );
  }
}

class MySpotsScreen extends ConsumerWidget {
  const MySpotsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      appBar: AppBar(title: const Text('Kiriman spot saya')),
      body: FutureBuilder<List<RunSpot>>(
        future: ref.read(communityPlusRepositoryProvider).mySpots(),
        builder: (context, snap) {
          if (snap.hasError) return Center(child: Text(ApiError.from(snap.error!).message));
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          if (snap.data!.isEmpty) return const Center(child: Text('Belum ada kiriman'));
          return ListView(children: [
            for (final s in snap.data!)
              ListTile(
                title: Text(s.name),
                subtitle: Text([
                  s.city,
                  switch (s.status) { 'approved' => 'Tayang', 'rejected' => 'Ditolak', _ => 'Menunggu tinjauan' },
                  ?s.rejectReason,
                ].join(' · ')),
              ),
          ]);
        },
      ),
    );
  }
}
