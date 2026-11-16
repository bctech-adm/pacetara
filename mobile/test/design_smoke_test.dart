import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pacetara/app.dart';
import 'package:pacetara/core/http/api_client.dart';
import 'package:pacetara/core/theme/app_theme.dart';
import 'package:pacetara/features/auth/auth_controller.dart';
import 'package:pacetara/features/auth/models.dart';
import 'package:pacetara/features/chat/chat_screens.dart';
import 'package:pacetara/features/communities/screens/my_communities_screen.dart';
import 'package:pacetara/features/feed/feed_screens.dart';
import 'package:pacetara/features/profile/profile_screen.dart';
import 'package:pacetara/features/runs/screens/record_screen.dart';

/// Tes asap tampilan: layar utama dirender dengan tema PaceTara yang sebenarnya (terang dan gelap).
/// Galat layout yang di build rilis hanya muncul sebagai layar kosong akan gagal di sini.

MyProfile me() => MyProfile.fromJson({
      'id': 'me',
      'displayName': 'Saya Pelari',
      'city': 'Bandung',
      'avgPaceSecPerKm': 390,
      'badges': <String>[],
      'emailVerified': true,
      'phoneVerified': true,
    });

class FakeAuth extends AuthController {
  FakeAuth(this.initial);
  final MyProfile? initial;

  @override
  Future<MyProfile?> build() async => initial;
}

/// Tidak pernah selesai: aplikasi tetap di splash.
class PendingAuth extends AuthController {
  @override
  Future<MyProfile?> build() => Completer<MyProfile?>().future;
}

Dio fakeDio() => Dio()
  ..interceptors.add(InterceptorsWrapper(onRequest: (o, h) {
    final Object data = switch (o.path) {
      '/v1/feed' => {'items': <Object>[], 'nextCursor': null},
      '/v1/notifications' => {'items': <Object>[], 'unread': 0, 'hasMore': false},
      '/v1/invitations' => <Object>[],
      _ => <String, dynamic>{},
    };
    h.resolve(Response(requestOptions: o, statusCode: 200, data: data));
  }));

Widget scope(AuthController Function() auth, Widget child) => ProviderScope(
      overrides: [dioProvider.overrideWithValue(fakeDio()), authControllerProvider.overrideWith(auth)],
      child: child,
    );

Widget themed(Widget child, Brightness b) =>
    scope(() => FakeAuth(me()), MaterialApp(theme: b == Brightness.light ? AppTheme.light() : AppTheme.dark(), home: child));

void phone(WidgetTester tester) {
  tester.view.physicalSize = const Size(1080, 2340);
  tester.view.devicePixelRatio = 2.75;
  tester.view.padding = const FakeViewPadding(top: 66, bottom: 44);
  addTearDown(tester.view.reset);
}

void main() {
  testWidgets('aplikasi: splash tampil dengan tema baru', (tester) async {
    phone(tester);
    await tester.pumpWidget(scope(PendingAuth.new, const PaceTaraApp()));
    await tester.pump(const Duration(milliseconds: 1500));
    expect(find.text('PaceTara'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });

  testWidgets('aplikasi: belum masuk → layar login', (tester) async {
    phone(tester);
    await tester.pumpWidget(scope(() => FakeAuth(null), const PaceTaraApp()));
    await tester.pumpAndSettle();
    expect(find.text('Masuk ke akunmu'), findsOneWidget);
  });

  testWidgets('aplikasi: sudah masuk → beranda tampil', (tester) async {
    phone(tester);
    await tester.pumpWidget(scope(() => FakeAuth(me()), const PaceTaraApp()));
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(tester.takeException(), isNull);
    expect(find.text('Feed'), findsWidgets);
    expect(find.text('Mulai lari'), findsOneWidget);
    // Bersihkan timer peta/animasi sebelum tes selesai.
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 1));
  });

  for (final b in Brightness.values) {
    testWidgets('layar utama dirender tanpa galat ($b)', (tester) async {
      phone(tester);
      final screens = <String, Widget>{
        'Profil': const ProfileScreen(asTab: true),
        'Komunitas': const MyCommunitiesScreen(),
        'Chat': const ChatListScreen(),
        'Feed': const FeedScreen(),
      };
      for (final e in screens.entries) {
        await tester.pumpWidget(themed(e.value, b));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull, reason: e.key);
      }
    });

    testWidgets('layar Lari dirender tanpa galat ($b)', (tester) async {
      phone(tester);
      await tester.pumpWidget(themed(const RecordScreen(), b));
      // Tombol mulai berdenyut terus: jangan pumpAndSettle.
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Mulai lari'), findsOneWidget);
      // Panel statistik bisa digeser ke bawah (ringkas) dan ke atas lagi; tombol mulai tetap ada.
      await tester.drag(find.byKey(const Key('panel-handle')), const Offset(0, 200));
      await tester.pump(const Duration(seconds: 1));
      expect(find.byKey(const Key('panel-compact')), findsOneWidget);
      expect(find.text('Jarak (km)'), findsNothing);
      expect(find.text('Mulai lari'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.drag(find.byKey(const Key('panel-handle')), const Offset(0, -200));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Jarak (km)'), findsOneWidget);
      // Atribusi flutter_map memasang timer; bongkar pohon lalu habiskan timernya.
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(minutes: 1));
    });
  }
}
