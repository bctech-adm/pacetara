import 'dart:ui' as ui;

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:pacetara/core/http/api_client.dart';
import 'package:pacetara/features/feed/feed_repository.dart';
import 'package:pacetara/features/feed/feed_screens.dart';
import 'package:pacetara/features/feed/share_card.dart';
import 'package:pacetara/features/notifications/notifications_repository.dart';
import 'package:pacetara/features/runs/runs_repository.dart';

Map<String, dynamic> postJson({
  String id = 'p1',
  String? text = 'Lari pagi yang segar',
  bool liked = false,
  int likes = 2,
  Map<String, dynamic>? run,
  bool runUnavailable = false,
  bool isMine = false,
}) =>
    {
      'id': id,
      'kind': run != null || runUnavailable ? 'run' : 'text',
      'text': text,
      'visibility': 'public',
      'createdAt': '2026-11-11T05:00:00.000Z',
      'author': {'id': 'u1', 'displayName': 'Ani', 'avatarUrl': null},
      'isMine': isMine,
      'likeCount': likes,
      'commentCount': 1,
      'likedByMe': liked,
      'photos': <Object>[],
      'run': run,
      'runUnavailable': runUnavailable,
    };

final runJson = {
  'id': 'r1',
  'title': '5K pagi',
  'startedAt': '2026-11-11T04:00:00.000Z',
  'distanceM': 5012,
  'movingTimeS': 1800,
  'avgPaceSPerKm': 359,
  'route': [
    [
      [-6.9, 107.6, 0, null],
      [-6.91, 107.61, 60, null],
    ],
  ],
};

Dio fakeDio(List<RequestOptions> seen) => Dio()
  ..interceptors.add(InterceptorsWrapper(onRequest: (o, h) {
    seen.add(o);
    final Object data = switch (o.path) {
      '/v1/feed' => {
          'items': o.queryParameters['tab'] == 'explore'
              ? [postJson(), postJson(id: 'p2', text: null, run: runJson)]
              : [postJson(id: 'p3', text: 'Dari yang kuikuti')],
          'nextCursor': null,
        },
      '/v1/feed/posts/p1/like' => postJson(liked: o.method == 'POST', likes: o.method == 'POST' ? 3 : 2),
      '/v1/feed/posts' => postJson(id: 'new', isMine: true),
      '/v1/invitations' => <Object>[],
      '/v1/notifications' => {'items': <Object>[], 'unread': 0, 'hasMore': false},
      _ => postJson(),
    };
    h.resolve(Response(requestOptions: o, statusCode: 200, data: data));
  }));

Widget host(List<RequestOptions> seen, Widget child) => ProviderScope(
      overrides: [dioProvider.overrideWithValue(fakeDio(seen))],
      child: MaterialApp(home: child),
    );

void main() {
  test('model postingan: hasil lari, lari tidak tersedia, dan visibilitas yang diizinkan', () {
    final p = FeedPost.fromJson(postJson(run: runJson));
    expect(p.kind, 'run');
    expect(p.run!.distanceM, 5012);
    expect(p.run!.route.first, hasLength(2));
    final gone = FeedPost.fromJson(postJson(runUnavailable: true));
    expect(gone.run, isNull);
    expect(gone.runUnavailable, isTrue);
    // Lari komunitas hanya boleh jadi postingan komunitas; lari publik boleh semua.
    expect(allowedForRun(RunVisibility.community), [PostVisibility.community]);
    expect(allowedForRun(RunVisibility.public), PostVisibility.values);
  });

  test('notifikasi feed: teks dan tujuan', () {
    expect(routeForPush({'type': 'post_comment', 'postId': 'p1'}), '/feed/posts/p1');
    expect(routeForPush({'type': 'new_follower', 'userId': 'u9'}), '/feed/users/u9');
    expect(notificationCategories.keys, contains('social'));
  });

  test('proyeksi rute masuk ke dalam kotak dan mempertahankan rasio', () {
    final route = <List<(double, double)>>[
      [(-6.90, 107.60), (-6.92, 107.60), (-6.92, 107.61)],
    ];
    const box = Rect.fromLTWH(100, 200, 800, 800);
    final pts = projectRoute(route, box).expand((s) => s).toList();
    expect(pts, hasLength(3));
    for (final p in pts) {
      expect(box.inflate(0.001).contains(p), isTrue);
    }
    // Utara di atas: titik pertama (lintang lebih besar) punya y lebih kecil.
    expect(pts[0].dy, lessThan(pts[1].dy));
    expect(projectRoute(const [], box), isEmpty);
  });

  testWidgets('kartu Instagram Story berukuran 1080x1920', (tester) async {
    await tester.runAsync(() async {
      final png = await renderShareCard(ShareCardData(
        title: '5K pagi',
        startedAt: DateTime(2026, 11, 11),
        distanceM: 5012,
        movingTimeS: 1800,
        avgPaceSPerKm: 359,
        route: parseRoute(runJson['route']),
        communityName: 'Lari Pagi Bandung',
      ));
      final codec = await ui.instantiateImageCodec(png);
      final frame = await codec.getNextFrame();
      expect(frame.image.width, 1080);
      expect(frame.image.height, 1920);
    });
  });

  testWidgets('tab Jelajah menampilkan postingan publik dan kartu lari; suka dikirim ke server', (tester) async {
    final seen = <RequestOptions>[];
    await tester.pumpWidget(host(seen, const FeedScreen()));
    await tester.pumpAndSettle();
    expect(find.text('Dari yang kuikuti'), findsOneWidget);

    await tester.tap(find.text('Jelajah'));
    await tester.pumpAndSettle();
    expect(find.text('Lari pagi yang segar'), findsOneWidget);
    expect(find.text('5K pagi'), findsOneWidget);
    expect(find.text('5.01 km'), findsOneWidget);
    expect(seen.any((o) => o.path == '/v1/feed' && o.queryParameters['tab'] == 'explore'), isTrue);

    await tester.tap(find.byKey(const Key('like-p1')));
    await tester.pumpAndSettle();
    expect(seen.last.method, 'POST');
    expect(seen.last.path, '/v1/feed/posts/p1/like');
    expect(find.text('3'), findsOneWidget);
  });

  testWidgets('buat postingan teks: data di body, bukan URL', (tester) async {
    final seen = <RequestOptions>[];
    final router = GoRouter(routes: [
      GoRoute(path: '/', builder: (_, _) => const ComposePostScreen()),
      GoRoute(path: '/feed/posts/:id', builder: (_, state) => Text('detail ${state.pathParameters['id']}')),
    ]);
    await tester.pumpWidget(ProviderScope(
      overrides: [dioProvider.overrideWithValue(fakeDio(seen))],
      child: MaterialApp.router(routerConfig: router),
    ));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('post-text')), 'Halo pelari');
    await tester.tap(find.byKey(const Key('vis-followers')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('post-submit')));
    await tester.pumpAndSettle();
    expect(find.text('detail new'), findsOneWidget);
    final req = seen.firstWhere((o) => o.path == '/v1/feed/posts');
    expect(req.method, 'POST');
    expect(req.queryParameters, isEmpty);
    expect(req.data, {'text': 'Halo pelari', 'visibility': 'followers'});
  });
}
