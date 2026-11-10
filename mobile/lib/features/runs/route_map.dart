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
    if (widget.follow && _ready && last != null) _controller.move(last, _controller.camera.zoom < 15 ? 16 : _controller.camera.zoom);
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
        onMapReady: () => _ready = true,
        interactionOptions: InteractionOptions(
          flags: widget.interactive ? InteractiveFlag.all & ~InteractiveFlag.rotate : InteractiveFlag.none,
        ),
      ),
      children: [
        TileLayer(urlTemplate: AppConfig.mapTileUrl, userAgentPackageName: 'tech.bimacreative.pacetara', maxZoom: 19),
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
              width: 52,
              height: 52,
              child: RunnerMarker(character: widget.character!, heading: widget.runnerHeading),
            ),
          ]),
        // Lisensi data OpenStreetMap (ODbL) mewajibkan atribusi. Tampil 5 detik lalu mengecil menjadi
        // ikon (i) yang bisa diketuk, sesuai pedoman atribusi OSM untuk layar kecil.
        RichAttributionWidget(
          showFlutterMapAttribution: false,
          popupInitialDisplayDuration: const Duration(seconds: 5),
          attributions: [
            TextSourceAttribution(
              AppConfig.mapAttribution,
              onTap: () => launchUrl(Uri.parse(AppConfig.mapAttributionUrl), mode: LaunchMode.externalApplication),
            ),
          ],
        ),
      ],
    );
    return widget.height == null ? map : SizedBox(height: widget.height, child: map);
  }
}

class _Dot extends StatelessWidget {
  const _Dot({required this.color});
  final Color color;

  @override
  Widget build(BuildContext context) =>
      DecoratedBox(decoration: BoxDecoration(color: color, shape: BoxShape.circle, border: Border.all(color: Colors.white, width: 3)));
}
