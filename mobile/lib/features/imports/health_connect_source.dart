import 'package:flutter/services.dart';
import 'package:health/health.dart';

import 'health_connect_mapping.dart';

enum HcAvailability { available, needsUpdate, notInstalled }

/// Pembaca Health Connect di HP (paket `health`). Hanya membaca sesi olahraga lari, jarak, kalori, langkah
/// (dibutuhkan plugin untuk ringkasan sesi), dan rute. Tidak menulis apa pun ke Health Connect dan tidak
/// membaca di latar belakang: impor selalu dipicu pengguna.
class HealthConnectSource {
  HealthConnectSource([Health? health]) : _health = health ?? Health();
  final Health _health;
  bool _configured = false;

  static const _types = [
    HealthDataType.WORKOUT,
    HealthDataType.DISTANCE_DELTA,
    HealthDataType.TOTAL_CALORIES_BURNED,
    HealthDataType.STEPS,
    HealthDataType.WORKOUT_ROUTE,
  ];
  static final _read = List.filled(_types.length, HealthDataAccess.READ);

  Future<void> _configure() async {
    if (_configured) return;
    await _health.configure();
    _configured = true;
  }

  Future<HcAvailability> availability() async {
    await _configure();
    return switch (await _health.getHealthConnectSdkStatus()) {
      HealthConnectSdkStatus.sdkAvailable => HcAvailability.available,
      HealthConnectSdkStatus.sdkUnavailableProviderUpdateRequired => HcAvailability.needsUpdate,
      _ => HcAvailability.notInstalled,
    };
  }

  Future<void> install() => _health.installHealthConnect();

  Future<bool> hasPermissions() async {
    await _configure();
    return await _health.hasPermissions(_types, permissions: _read) ?? false;
  }

  Future<bool> requestPermissions() async {
    await _configure();
    return _health.requestAuthorization(_types, permissions: _read);
  }

  /// Sesi lari [days] hari terakhir (Health Connect membatasi bacaan 30 hari sebelum izin diberikan).
  Future<List<HcRunSession>> runSessions({int days = 30}) async {
    await _configure();
    final end = DateTime.now();
    final start = end.subtract(Duration(days: days));
    final workouts = await _health.getHealthDataFromTypes(types: [HealthDataType.WORKOUT], startTime: start, endTime: end);
    final sessions = <String, HcRunSession>{};
    for (final p in workouts) {
      final v = p.value;
      if (v is! WorkoutHealthValue) continue;
      final type = v.workoutActivityType;
      if (type != HealthWorkoutActivityType.RUNNING && type != HealthWorkoutActivityType.RUNNING_TREADMILL) continue;
      if (p.sourceName == ownPackage || !validSessionId(p.uuid)) continue;
      sessions[p.uuid] = HcRunSession(
        id: p.uuid,
        start: p.dateFrom,
        end: p.dateTo,
        origin: p.sourceName,
        treadmill: type == HealthWorkoutActivityType.RUNNING_TREADMILL,
        distanceM: v.totalDistance?.toDouble(),
      );
    }
    if (sessions.isEmpty) return const [];
    // Rute: Health Connect hanya memberikannya saat aplikasi di latar depan; rute dari aplikasi lain bisa
    // butuh izin "Rute olahraga" tambahan (ditandai routeNeedsConsent).
    try {
      final routes = await _health.getHealthDataFromTypes(types: [HealthDataType.WORKOUT_ROUTE], startTime: start, endTime: end);
      for (final r in routes) {
        final v = r.value;
        if (v is! WorkoutRouteHealthValue) continue;
        final s = sessions[v.workoutUuid ?? r.uuid];
        if (s == null) continue;
        if (r.metadata?['route_requires_consent'] == true) {
          s.routeNeedsConsent = true;
          continue;
        }
        s.route = [
          for (final l in v.locations) HcRoutePoint(lat: l.latitude, lng: l.longitude, time: l.timestamp, altitude: l.altitude),
        ];
      }
    } on PlatformException {
      // Tanpa rute: statistik sesi tetap bisa diimpor (ditandai tidak diverifikasi GPS di server).
    }
    final list = sessions.values.toList()..sort((a, b) => b.start.compareTo(a.start));
    return list;
  }
}

/// Aksi intent yang membuka aplikasi (mis. Health Connect meminta penjelasan izin). Null jika tidak tersedia.
Future<String?> launchAction() async {
  try {
    return await const MethodChannel('pacetara/launch').invokeMethod<String>('launchAction');
  } on PlatformException {
    return null;
  } on MissingPluginException {
    return null;
  }
}

const hcRationaleActions = {'androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE', 'android.intent.action.VIEW_PERMISSION_USAGE'};
