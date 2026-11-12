/// Pemetaan sesi Health Connect ke body `POST /v1/imports/health-connect`. Murni (tanpa plugin) agar bisa
/// dites. Server menghitung ulang statistik dari rute dan menerapkan zona privasi; aplikasi hanya mengirim
/// titik mentah (detik sejak mulai), seperti lari yang direkam di aplikasi.
library;

/// Paket aplikasi Strava: lari dari Strava yang masuk Health Connect disimpan server sebagai riwayat pribadi.
const stravaPackage = 'com.strava';

/// Paket aplikasi ini (tidak pernah diimpor ulang).
const ownPackage = 'tech.bimacreative.pacetara';

/// Batas titik per lari (sama dengan server).
const maxRoutePoints = 15000;

class HcRoutePoint {
  const HcRoutePoint({required this.lat, required this.lng, required this.time, this.altitude});
  final double lat;
  final double lng;
  final DateTime time;
  final double? altitude;
}

class HcRunSession {
  HcRunSession({
    required this.id,
    required this.start,
    required this.end,
    required this.origin,
    required this.treadmill,
    this.distanceM,
    this.route = const [],
    this.routeNeedsConsent = false,
  });

  /// Metadata id Health Connect (stabil, dipakai server untuk idempotensi).
  final String id;
  final DateTime start;
  final DateTime end;

  /// Nama paket aplikasi asal data (mis. com.garmin.android.apps.connectmobile).
  final String origin;
  final bool treadmill;
  final double? distanceM;
  List<HcRoutePoint> route;

  /// Rute ada, tetapi Health Connect meminta izin "Rute olahraga" untuk aplikasi ini.
  bool routeNeedsConsent;

  bool get fromStrava => origin == stravaPackage;
  Duration get duration => end.difference(start);
}

/// Nama ramah untuk paket asal yang umum.
String originLabel(String pkg) => switch (pkg) {
      'com.google.android.apps.fitness' => 'Google Fit',
      'com.garmin.android.apps.connectmobile' => 'Garmin Connect',
      'com.samsung.android.app.health' || 'com.sec.android.app.shealth' => 'Samsung Health',
      stravaPackage => 'Strava',
      'com.xiaomi.wearable' || 'com.mi.health' => 'Mi Fitness',
      'com.huawei.health' => 'Huawei Health',
      'com.fitbit.FitbitMobile' => 'Fitbit',
      '' => 'Health Connect',
      _ => pkg,
    };

/// Rute → [[lat, lng, detik sejak mulai, ketinggian|null], ...], urut waktu, titik di luar rentang dibuang,
/// dijarangkan rata jika melebihi [maxRoutePoints].
List<List<num?>> routeToPoints(List<HcRoutePoint> route, DateTime start) {
  final sorted = [...route]..sort((a, b) => a.time.compareTo(b.time));
  final pts = <List<num?>>[];
  for (final p in sorted) {
    final t = p.time.difference(start).inMilliseconds / 1000;
    if (t < 0 || t > 86400) continue;
    if (p.lat.abs() > 90 || p.lng.abs() > 180 || p.lat.isNaN || p.lng.isNaN) continue;
    final alt = p.altitude;
    pts.add([p.lat, p.lng, t.round(), alt == null || alt.isNaN ? null : alt.clamp(-500, 9000).round()]);
  }
  if (pts.length <= maxRoutePoints) return pts;
  final step = pts.length / maxRoutePoints;
  return [for (var i = 0; i < maxRoutePoints; i++) pts[(i * step).floor()]];
}

/// Body untuk server. [visibility] = 'public' | 'community' | 'private' (Strava selalu privat di server).
Map<String, dynamic> sessionToBody(HcRunSession s, String visibility) {
  final distance = s.distanceM;
  return {
    'externalId': s.id,
    'originPackage': s.origin,
    'exerciseType': s.treadmill ? 'running_treadmill' : 'running',
    'visibility': s.fromStrava ? 'private' : visibility,
    'startedAt': s.start.toUtc().toIso8601String(),
    'endedAt': s.end.toUtc().toIso8601String(),
    'distanceM': distance == null || distance <= 0 ? null : distance.clamp(0, 300000).round(),
    'route': routeToPoints(s.route, s.start),
  };
}

/// Id Health Connect yang diterima server (sama dengan validasi `externalId`).
bool validSessionId(String id) => id.isNotEmpty && id.length <= 100 && RegExp(r'^[A-Za-z0-9._:-]+$').hasMatch(id);
