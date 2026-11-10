import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/config.dart';
import 'runner_character.dart';

/// Peta rute lari. Tile peta diambil langsung dari penyedia peta (bukan server PaceTara).
class RouteMap extends StatefulWidget {
  const RouteMap({
    super.key,
    required this.segments,
    this.follow = false,
    this.interactive = true,
    this.height,
    this.showEndpoints = true,
    this.runnerAt,
    this.runnerHeading,
    this.character,
    this.runnerMoving = false,
    this.onLocate,
  });

  final List<List<LatLng>> segments;

  /// Rekam langsung: kamera mengikuti titik terakhir.
  final bool follow;
  final bool interactive;
  final double? height;
  final bool showEndpoints;

  /// Posisi karakter pelari (posisi terkini). Null = tidak ditampilkan.
  final LatLng? runnerAt;
  final double? runnerHeading;
  final RunnerCharacter? character;
  final bool runnerMoving;

  /// Diisi → tampil tombol "lokasi saya". Dipanggil setelah kamera dipusatkan (mis. untuk meminta izin lokasi).
  final Future<void> Function()? onLocate;

  @override
  State<RouteMap> createState() => _RouteMapState();
}

class _RouteMapState extends State<RouteMap> {
  final _controller = MapController();
  bool _ready = false;

  LatLng? get _last {
    for (final s in widget.segments.reversed) {
      if (s.isNotEmpty) return s.last;
    }
    return null;
  }

  @override
  void didUpdateWidget(covariant RouteMap old) {
    super.didUpdateWidget(old);
    final last = widget.runnerAt ?? _last;
    // Hanya menggeser kamera, tidak membangun ulang peta (hemat baterai dan kuota tile).
    if (widget.follow && _ready && last != null) {
      _centerOn(last);
    } else if (_ready && old.runnerAt == null && widget.runnerAt != null) {
      // Posisi baru didapat (GPS/izin datang belakangan): pindahkan kamera ke karakter.
      _centerOn(widget.runnerAt!);
    }
  }

  void _centerOn(LatLng p) => _controller.move(p, _controller.camera.zoom < 15 ? 16 : _controller.camera.zoom);

  Future<void> _locate() async {
    final p = widget.runnerAt ?? _last;
    if (p != null && _ready) _centerOn(p);
    await widget.onLocate?.call();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final all = widget.segments.expand((s) => s).toList();
    final scheme = Theme.of(context).colorScheme;
    final map = FlutterMap(
      mapController: _controller,
      options: MapOptions(
        initialCenter: widget.runnerAt ?? (all.isNotEmpty ? all.last : const LatLng(-6.2, 106.8)),
        initialZoom: all.isEmpty && widget.runnerAt == null ? 11 : 16,
        initialCameraFit: !widget.follow && all.length >= 2
            ? CameraFit.bounds(bounds: LatLngBounds.fromPoints(all), padding: const EdgeInsets.all(32))
            : null,
        onMapReady: () {
          _ready = true;
          // runnerAt bisa datang di antara build pertama dan peta siap.
          if (widget.runnerAt != null && widget.segments.every((s) => s.isEmpty)) _centerOn(widget.runnerAt!);
        },
        interactionOptions: InteractionOptions(
          flags: widget.interactive ? InteractiveFlag.all & ~InteractiveFlag.rotate : InteractiveFlag.none,
        ),
      ),
      children: [
        mapTileLayer(),
        PolylineLayer(
          polylines: [
            for (final s in widget.segments)
              if (s.length >= 2) Polyline(points: s, strokeWidth: 5, color: scheme.primary),
          ],
        ),
        if (widget.showEndpoints && all.isNotEmpty)
          MarkerLayer(markers: [
            Marker(point: all.first, width: 18, height: 18, child: _Dot(color: Colors.green.shade600)),
            if (all.length > 1) Marker(point: all.last, width: 18, height: 18, child: _Dot(color: scheme.error)),
          ]),
        if (widget.runnerAt != null && widget.character != null)
          MarkerLayer(markers: [
            Marker(
              point: widget.runnerAt!,
              width: 56,
              height: 56,
              child: RunnerMarker(character: widget.character!, heading: widget.runnerHeading, moving: widget.runnerMoving),
            ),
          ]),
        if (widget.onLocate != null)
          Align(
            alignment: Alignment.bottomRight,
            child: Padding(
              padding: const EdgeInsets.only(right: 12, bottom: 52),
              child: FloatingActionButton.small(
                heroTag: null,
                tooltip: 'Lokasi saya',
                onPressed: _locate,
                child: const Icon(Icons.my_location),
              ),
            ),
          ),
        mapAttribution(),
      ],
    );
    return widget.height == null ? map : SizedBox(height: widget.height, child: map);
  }
}

/// Lapisan tile peta, dipakai semua peta di aplikasi.
Widget mapTileLayer() => TileLayer(urlTemplate: AppConfig.mapTileUrl, userAgentPackageName: 'tech.bimacreative.pacetara', maxZoom: 19);

/// Lisensi data OpenStreetMap (ODbL) mewajibkan atribusi. Tampil 5 detik lalu mengecil menjadi
/// ikon (i) yang bisa diketuk, sesuai pedoman atribusi OSM untuk layar kecil.
Widget mapAttribution() => RichAttributionWidget(
      showFlutterMapAttribution: false,
      popupInitialDisplayDuration: const Duration(seconds: 5),
      attributions: [
        TextSourceAttribution(
          AppConfig.mapAttribution,
          onTap: () => launchUrl(Uri.parse(AppConfig.mapAttributionUrl), mode: LaunchMode.externalApplication),
        ),
      ],
    );

class _Dot extends StatelessWidget {
  const _Dot({required this.color});
  final Color color;

  @override
  Widget build(BuildContext context) =>
      DecoratedBox(decoration: BoxDecoration(color: color, shape: BoxShape.circle, border: Border.all(color: Colors.white, width: 3)));
}
