import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

import '../../core/api/api_error.dart';
import '../../core/http/api_client.dart';
import '../auth/auth_controller.dart';

enum RunVisibility { public, community, private }

String visibilityText(RunVisibility v) => switch (v) {
      RunVisibility.public => 'Semua orang',
      RunVisibility.community => 'Anggota komunitasku',
      RunVisibility.private => 'Hanya saya',
    };

RunVisibility _vis(Object? v) => switch (v) {
      'public' => RunVisibility.public,
      'private' => RunVisibility.private,
      _ => RunVisibility.community,
    };

class RunSummary {
  const RunSummary({
    required this.id,
    required this.title,
    required this.visibility,
    required this.startedAt,
    required this.distanceM,
    required this.movingTimeS,
    required this.avgPaceSPerKm,
  });
  final String id;
  final String title;
  final RunVisibility visibility;
  final DateTime startedAt;
  final int distanceM;
  final int movingTimeS;
  final int? avgPaceSPerKm;

  factory RunSummary.fromJson(Map<String, dynamic> j) => RunSummary(
        id: j['id'] as String,
        title: j['title'] as String,
        visibility: _vis(j['visibility']),
        startedAt: DateTime.parse(j['startedAt'] as String).toLocal(),
        distanceM: (j['distanceM'] as num).toInt(),
        movingTimeS: (j['movingTimeS'] as num).toInt(),
        avgPaceSPerKm: (j['avgPaceSPerKm'] as num?)?.toInt(),
      );
}

/// Rute: segmen-segmen berisi (lat, lng).
typedef RunRoute = List<List<(double, double)>>;

RunRoute parseRoute(Object? raw) => [
      for (final seg in (raw as List<dynamic>? ?? const []))
        [
          for (final p in seg as List<dynamic>) (((p as List<dynamic>)[0] as num).toDouble(), (p[1] as num).toDouble()),
        ],
    ];

class RunDetail {
  const RunDetail({
    required this.summary,
    required this.notes,
    required this.isOwner,
    required this.route,
    required this.publicRoute,
    required this.photoUrls,
    required this.photoIds,
    required this.elevationGainM,
  });
  final RunSummary summary;
  final String notes;
  final bool isOwner;
  final RunRoute route;

  /// Hanya untuk pemilik: rute seperti yang dilihat orang lain (setelah zona privasi).
  final RunRoute? publicRoute;
  final List<String> photoUrls;
  final List<String> photoIds;
  final int? elevationGainM;

  factory RunDetail.fromJson(Map<String, dynamic> j) {
    final photos = (j['photos'] as List<dynamic>? ?? const []).cast<Map<String, dynamic>>();
    return RunDetail(
      summary: RunSummary.fromJson(j),
      notes: j['notes'] as String? ?? '',
      isOwner: j['isOwner'] as bool? ?? false,
      route: parseRoute(j['route']),
      publicRoute: j['publicRoute'] == null ? null : parseRoute(j['publicRoute']),
      photoUrls: photos.map((p) => p['url'] as String).toList(),
      photoIds: photos.map((p) => p['id'] as String).toList(),
      elevationGainM: (j['elevationGainM'] as num?)?.toInt(),
    );
  }
}

class RunHistory {
  const RunHistory({required this.items, required this.nextBefore, required this.historyDays, required this.hiddenOlder});
  final List<RunSummary> items;
  final String? nextBefore;
  final int? historyDays;
  final int hiddenOlder;
}

class RunsRepository {
  RunsRepository(this._dio);
  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() fn) async {
    try {
      return await fn();
    } catch (e) {
      throw ApiError.from(e);
    }
  }

  Future<RunDetail> create(Map<String, dynamic> body) => _call(() async {
        final res = await _dio.post<Map<String, dynamic>>('/v1/runs', data: body);
        return RunDetail.fromJson(res.data!);
      });

  Future<RunHistory> mine({String? before}) => _call(() async {
        final res = await _dio.get<Map<String, dynamic>>('/v1/runs/mine', queryParameters: {'before': ?before});
        final d = res.data!;
        final limit = d['historyLimit'] as Map<String, dynamic>? ?? const {};
        return RunHistory(
          items: (d['items'] as List<dynamic>).map((e) => RunSummary.fromJson(e as Map<String, dynamic>)).toList(),
          nextBefore: d['nextBefore'] as String?,
          historyDays: (limit['days'] as num?)?.toInt(),
          hiddenOlder: (limit['hiddenOlderRuns'] as num?)?.toInt() ?? 0,
        );
      });

  Future<RunDetail> detail(String id) => _call(() async => RunDetail.fromJson((await _dio.get<Map<String, dynamic>>('/v1/runs/$id')).data!));

  Future<RunDetail> update(String id, Map<String, dynamic> patch) =>
      _call(() async => RunDetail.fromJson((await _dio.patch<Map<String, dynamic>>('/v1/runs/$id', data: patch)).data!));

  Future<void> delete(String id) => _call(() => _dio.delete<void>('/v1/runs/$id'));

  Future<RunDetail> addPhoto(String id, String path) => _call(() async {
        final form = FormData.fromMap({'file': await MultipartFile.fromFile(path, filename: 'photo')});
        return RunDetail.fromJson((await _dio.post<Map<String, dynamic>>('/v1/runs/$id/photos', data: form)).data!);
      });

  Future<RunDetail> removePhoto(String id, String photoId) =>
      _call(() async => RunDetail.fromJson((await _dio.delete<Map<String, dynamic>>('/v1/runs/$id/photos/$photoId')).data!));

  Future<void> setPrivacyRadius(int meters) => _call(() => _dio.put<void>('/v1/runs/privacy-zone', data: {'radiusM': meters}));
}

final runsRepositoryProvider = Provider<RunsRepository>((ref) => RunsRepository(ref.watch(dioProvider)));

final runDetailProvider = FutureProvider.autoDispose.family<RunDetail, String>((ref, id) => ref.watch(runsRepositoryProvider).detail(id));

/// Antrean upload: lari yang sudah selesai disimpan dulu di HP, lalu diunggah. Jika sinyal buruk,
/// tetap aman dan dicoba lagi nanti (server menolak duplikat lewat clientRunId).
class PendingUpload {
  const PendingUpload({required this.clientRunId, required this.body, required this.photoPaths, this.ownerId});
  final String clientRunId;
  final Map<String, dynamic> body;
  final List<String> photoPaths;

  /// Akun pemilik lari. Antrean hanya diunggah ke akun ini (HP bisa dipakai bergantian).
  final String? ownerId;

  Map<String, dynamic> toJson() => {'clientRunId': clientRunId, 'body': body, 'photoPaths': photoPaths, 'ownerId': ?ownerId};

  static PendingUpload fromJson(Map<String, dynamic> j) => PendingUpload(
        ownerId: j['ownerId'] as String?,
        clientRunId: j['clientRunId'] as String,
        body: j['body'] as Map<String, dynamic>,
        photoPaths: (j['photoPaths'] as List<dynamic>).cast<String>(),
      );
}

class UploadQueue {
  UploadQueue(this._repo, [this._ownerId]);
  final RunsRepository _repo;

  /// Akun yang sedang login. Lari milik akun lain di HP yang sama tidak ditampilkan dan tidak diunggah
  /// (tetap disimpan, terunggah saat pemiliknya login lagi). Entri lama tanpa pemilik tetap diunggah.
  final String? _ownerId;

  Future<Directory> _dir() async {
    final d = Directory('${(await getApplicationSupportDirectory()).path}/pending_runs');
    if (!d.existsSync()) d.createSync(recursive: true);
    return d;
  }

  Future<List<PendingUpload>> list() async {
    final d = await _dir();
    final items = <PendingUpload>[];
    for (final f in d.listSync().whereType<File>().where((f) => f.path.endsWith('.json'))) {
      try {
        final item = PendingUpload.fromJson(jsonDecode(await f.readAsString()) as Map<String, dynamic>);
        if (item.ownerId == null || item.ownerId == _ownerId) items.add(item);
      } catch (_) {
        // berkas rusak dilewati
      }
    }
    return items;
  }

  /// Menyalin foto ke folder antrean (berkas dari galeri bisa hilang), lalu menyimpan entri.
  Future<PendingUpload> enqueue(Map<String, dynamic> body, List<String> photos) async {
    final d = await _dir();
    final id = body['clientRunId'] as String;
    final copied = <String>[];
    for (var i = 0; i < photos.length; i++) {
      final dest = '${d.path}/$id-$i.img';
      await File(photos[i]).copy(dest);
      copied.add(dest);
    }
    final item = PendingUpload(clientRunId: id, body: body, photoPaths: copied, ownerId: _ownerId);
    await File('${d.path}/$id.json').writeAsString(jsonEncode(item.toJson()), flush: true);
    return item;
  }

  /// Mengunggah satu entri. Berhasil → entri dan fotonya dihapus dari HP.
  Future<RunDetail> upload(PendingUpload item) async {
    var run = await _repo.create(item.body);
    // Foto yang sudah ada di server (upload ulang setelah putus) tidak dikirim lagi.
    for (final path in item.photoPaths.skip(run.photoIds.length)) {
      run = await _repo.addPhoto(run.summary.id, path);
    }
    final d = await _dir();
    for (final p in item.photoPaths) {
      final f = File(p);
      if (f.existsSync()) await f.delete();
    }
    final f = File('${d.path}/${item.clientRunId}.json');
    if (f.existsSync()) await f.delete();
    return run;
  }

  /// Mencoba mengunggah semua antrean; mengembalikan jumlah yang berhasil.
  Future<int> flush() async {
    var ok = 0;
    for (final item in await list()) {
      try {
        await upload(item);
        ok++;
      } catch (_) {
        // tetap di antrean
      }
    }
    return ok;
  }
}

final uploadQueueProvider = Provider<UploadQueue>(
  (ref) => UploadQueue(ref.watch(runsRepositoryProvider), ref.watch(authControllerProvider.select((a) => a.value?.id))),
);

final pendingUploadsProvider = FutureProvider.autoDispose<List<PendingUpload>>((ref) => ref.watch(uploadQueueProvider).list());
