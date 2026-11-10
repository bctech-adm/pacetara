import 'dart:math' as math;

/// Satu titik GPS dari perangkat.
class GpsFix {
  const GpsFix({required this.lat, required this.lng, required this.time, this.altitude, this.accuracy = 5});
  final double lat;
  final double lng;
  final DateTime time;
  final double? altitude;

  /// Perkiraan akurasi horizontal (meter).
  final double accuracy;
}

/// Titik rute: detik sejak mulai rekam. Format yang dikirim ke server: [lat, lng, t, alt|null].
class TrackPoint {
  const TrackPoint(this.lat, this.lng, this.t, this.alt);
  final double lat;
  final double lng;
  final double t;
  final double? alt;

  List<Object?> toJson() => [
        double.parse(lat.toStringAsFixed(6)),
        double.parse(lng.toStringAsFixed(6)),
        double.parse(t.toStringAsFixed(1)),
        alt == null ? null : double.parse(alt!.toStringAsFixed(1)),
      ];

  static TrackPoint fromJson(List<dynamic> j) =>
      TrackPoint((j[0] as num).toDouble(), (j[1] as num).toDouble(), (j[2] as num).toDouble(), (j[3] as num?)?.toDouble());
}

const _earthR = 6371008.8;

/// Jarak permukaan bumi (meter). Rumus yang sama dengan server (backend/src/runs/geo.ts).
double haversine(double lat1, double lng1, double lat2, double lng2) {
  double rad(double d) => d * math.pi / 180;
  final dLat = rad(lat2 - lat1);
  final dLng = rad(lng2 - lng1);
  final h = math.pow(math.sin(dLat / 2), 2) + math.cos(rad(lat1)) * math.cos(rad(lat2)) * math.pow(math.sin(dLng / 2), 2);
  return 2 * _earthR * math.asin(math.min(1.0, math.sqrt(h)));
}

/// Batas penyaringan, disamakan dengan server.
const maxSpeedMps = 12.5;
const maxAccuracyM = 25.0;
const maxGapSeconds = 30.0;

/// Rekaman lari yang sedang berlangsung: segmen-segmen (dipisah jeda) beserta statistik berjalan.
/// Murni logika (tanpa GPS/plugin) agar bisa diuji dengan rute buatan.
class Track {
  Track({required this.startedAt, List<List<TrackPoint>>? segments}) : segments = segments ?? [[]];

  final DateTime startedAt;
  final List<List<TrackPoint>> segments;

  double distanceM = 0;
  double movingSeconds = 0;

  /// Titik terakhir yang diterima (untuk menyaring lompatan).
  TrackPoint? _last;

  /// Menambah titik; mengembalikan false jika ditolak (akurasi buruk, waktu mundur, atau lompatan).
  bool add(GpsFix fix) {
    if (fix.accuracy > maxAccuracyM) return false;
    final t = fix.time.difference(startedAt).inMilliseconds / 1000;
    if (t < 0) return false;
    final point = TrackPoint(fix.lat, fix.lng, t, fix.altitude);
    final current = segments.last;
    final prev = current.isEmpty ? null : current.last;
    if (prev != null) {
      final dt = t - prev.t;
      if (dt <= 0) return false;
      final d = haversine(prev.lat, prev.lng, point.lat, point.lng);
      if (d / dt > maxSpeedMps) return false;
      distanceM += d;
      if (dt <= maxGapSeconds) movingSeconds += dt;
    }
    current.add(point);
    _last = point;
    return true;
  }

  /// Memulai segmen baru setelah jeda (jarak antar-segmen tidak dihitung).
  void newSegment() {
    if (segments.last.isNotEmpty) segments.add([]);
  }

  TrackPoint? get last => _last;

  int get pointCount => segments.fold(0, (n, s) => n + s.length);

  /// Pace rata-rata (detik/km); null jika jarak < 100 m.
  double? get avgPaceSPerKm => distanceM >= 100 && movingSeconds > 0 ? movingSeconds / (distanceM / 1000) : null;

  /// Pace terkini dari ~300 m terakhir pada segmen aktif.
  double? get currentPaceSPerKm {
    final seg = segments.last;
    if (seg.length < 2) return null;
    var d = 0.0;
    for (var i = seg.length - 1; i > 0; i--) {
      d += haversine(seg[i - 1].lat, seg[i - 1].lng, seg[i].lat, seg[i].lng);
      if (d >= 300) {
        final dt = seg.last.t - seg[i - 1].t;
        return dt > 0 ? dt / (d / 1000) : null;
      }
    }
    return null;
  }

  List<List<List<Object?>>> segmentsJson() =>
      segments.where((s) => s.isNotEmpty).map((s) => s.map((p) => p.toJson()).toList()).toList();

  /// Membangun ulang dari draf tersimpan (pemulihan setelah aplikasi tertutup).
  static Track restore(DateTime startedAt, List<dynamic> json) {
    final track = Track(startedAt: startedAt, segments: []);
    for (final s in json) {
      track.segments.add([]);
      for (final p in s as List<dynamic>) {
        final tp = TrackPoint.fromJson(p as List<dynamic>);
        final seg = track.segments.last;
        if (seg.isNotEmpty) {
          final prev = seg.last;
          final dt = tp.t - prev.t;
          track.distanceM += haversine(prev.lat, prev.lng, tp.lat, tp.lng);
          if (dt > 0 && dt <= maxGapSeconds) track.movingSeconds += dt;
        }
        seg.add(tp);
        track._last = tp;
      }
    }
    if (track.segments.isEmpty) track.segments.add([]);
    return track;
  }
}

String formatDistanceKm(double meters) => (meters / 1000).toStringAsFixed(2);

String formatDuration(int seconds) {
  final h = seconds ~/ 3600;
  final m = (seconds % 3600) ~/ 60;
  final s = seconds % 60;
  final mm = m.toString().padLeft(2, '0');
  final ss = s.toString().padLeft(2, '0');
  return h > 0 ? '$h:$mm:$ss' : '$mm:$ss';
}

String formatPaceS(double? secPerKm) {
  if (secPerKm == null || secPerKm.isInfinite || secPerKm > 3600) return '--:--';
  final total = secPerKm.round();
  return '${total ~/ 60}:${(total % 60).toString().padLeft(2, '0')}';
}
