import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:geolocator/geolocator.dart';
import 'package:latlong2/latlong.dart';

import '../../core/widgets/common.dart';
import '../runs/route_map.dart';
import 'models.dart';

/// Tengah peta bawaan (Monas) jika belum ada titik.
const _defaultCenter = LatLng(-6.1754, 106.8272);

/// Pilih satu titik di peta dengan menggeser peta (penanda tetap di tengah). Dipakai untuk titik kumpul sesi,
/// area cari teman (dibulatkan server ±2 km), dan lokasi spot. Tombol "lokasi saya" hanya memusatkan peta;
/// titik yang disimpan tetap yang dipilih pengguna.
class PointPickerScreen extends StatefulWidget {
  const PointPickerScreen({super.key, required this.title, this.initial, this.hint});
  final String title;
  final GeoPoint? initial;
  final String? hint;

  static Future<GeoPoint?> pick(BuildContext context, {required String title, GeoPoint? initial, String? hint}) =>
      Navigator.of(context).push<GeoPoint>(MaterialPageRoute(builder: (_) => PointPickerScreen(title: title, initial: initial, hint: hint)));

  @override
  State<PointPickerScreen> createState() => _PointPickerScreenState();
}

class _PointPickerScreenState extends State<PointPickerScreen> {
  final _map = MapController();
  late LatLng _center = widget.initial == null ? _defaultCenter : LatLng(widget.initial!.lat, widget.initial!.lng);

  Future<void> _locate() async {
    try {
      var perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
      if (perm != LocationPermission.whileInUse && perm != LocationPermission.always) {
        if (mounted) showInfo(context, 'Izin lokasi tidak diberikan. Geser peta secara manual');
        return;
      }
      final p = await Geolocator.getCurrentPosition(locationSettings: const LocationSettings(timeLimit: Duration(seconds: 10)));
      _map.move(LatLng(p.latitude, p.longitude), 16);
    } catch (_) {
      if (mounted) showInfo(context, 'Lokasi belum tersedia. Geser peta secara manual');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: Stack(children: [
        FlutterMap(
          mapController: _map,
          options: MapOptions(
            initialCenter: _center,
            initialZoom: widget.initial == null ? 11 : 15,
            interactionOptions: const InteractionOptions(flags: InteractiveFlag.all & ~InteractiveFlag.rotate),
            onPositionChanged: (camera, _) => _center = camera.center,
          ),
          children: [mapTileLayer(), mapAttribution()],
        ),
        const IgnorePointer(child: Center(child: Padding(padding: EdgeInsets.only(bottom: 40), child: Icon(Icons.location_on, size: 44, color: Colors.red)))),
        if (widget.hint != null)
          Positioned(
            left: 12,
            right: 12,
            top: 12,
            child: Card(child: Padding(padding: const EdgeInsets.all(12), child: Text(widget.hint!))),
          ),
        Positioned(
          right: 12,
          bottom: 96,
          child: FloatingActionButton.small(heroTag: null, tooltip: 'Lokasi saya', onPressed: _locate, child: const Icon(Icons.my_location)),
        ),
      ]),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: FilledButton(
            key: const Key('pick-point'),
            onPressed: () => Navigator.pop(context, GeoPoint(_center.latitude, _center.longitude)),
            child: const Text('Pilih titik ini'),
          ),
        ),
      ),
    );
  }
}
