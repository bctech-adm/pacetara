import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pacetara/core/http/api_client.dart';
import 'package:pacetara/features/ads/ads.dart';
import 'package:pacetara/features/auth/auth_controller.dart';
import 'package:pacetara/features/auth/models.dart';
import 'package:pacetara/features/events/events_screens.dart';
import 'package:pacetara/features/feed/feed_screens.dart';

MyProfile profile({required bool premium, bool? ads}) => MyProfile.fromJson({
      'id': 'me',
      'displayName': 'Saya',
      'badges': [if (premium) 'premium'],
      'ads': ?ads,
    });

/// Status login palsu: profil dari "server" tanpa Keystore atau HTTP.
class FakeAuth extends AuthController {
  FakeAuth(this.initial);
  final MyProfile? initial;

  @override
  Future<MyProfile?> build() async => initial;

  void set(MyProfile p) => state = AsyncData(p);
}

/// Pengganti tampilan iklan: SDK Google Mobile Ads tidak pernah dipanggil di tes.
class FakeAd extends StatelessWidget {
  const FakeAd(this.unit, {super.key});
  final AdUnit unit;

  @override
  Widget build(BuildContext context) => SizedBox(height: 40, child: Text('IKLAN ${unit.format.name}'));
}

Map<String, dynamic> post(int i) => {
      'id': 'p$i',
      'kind': 'text',
      'text': 'Postingan $i',
      'visibility': 'public',
      'createdAt': '2026-11-11T05:00:00.000Z',
      'author': {'id': 'u1', 'displayName': 'Ani', 'avatarUrl': null},
      'isMine': false,
      'likeCount': 0,
      'commentCount': 0,
      'likedByMe': false,
      'photos': <Object>[],
      'run': null,
      'runUnavailable': false,
    };

Map<String, dynamic> event(int i) => {
      'id': 'e$i',
      'name': 'Event $i',
      'date': '2026-12-${(i + 1).toString().padLeft(2, '0')}',
      'startTime': '05:00',
      'city': 'Bandung',
      'venue': 'Gedung Sate',
      'categories': ['10k'],
      'archived': false,
      'goingCount': 0,
      'iAmGoing': false,
      'friendsGoing': 0,
    };

Dio fakeDio() => Dio()
  ..interceptors.add(InterceptorsWrapper(onRequest: (o, h) {
    final Object data = switch (o.path) {
      '/v1/feed' || '/v1/feed/users/u1/posts' => {'items': [for (var i = 0; i < 12; i++) post(i)], 'nextCursor': null},
      '/v1/feed/users/u1' => {'id': 'u1', 'displayName': 'Ani', 'avatarUrl': null, 'badges': <String>[], 'isMe': false},
      '/v1/events' => {'items': [for (var i = 0; i < 12; i++) event(i)], 'nextCursor': null},
      '/v1/events/cities' => <Object>[],
      '/v1/invitations' => <Object>[],
      '/v1/notifications' => {'items': <Object>[], 'unread': 0, 'hasMore': false},
      _ => <String, dynamic>{},
    };
    h.resolve(Response(requestOptions: o, statusCode: 200, data: data));
  }));

const configured = AdUnits(
  nativeFeed: 'ca-app-pub-1234567890123456/1111111111',
  bannerEvents: 'ca-app-pub-1234567890123456/2222222222',
);

Widget host(Widget child, {MyProfile? me, AdUnits units = configured}) => ProviderScope(
      overrides: [
        dioProvider.overrideWithValue(fakeDio()),
        authControllerProvider.overrideWith(() => FakeAuth(me)),
        adUnitsProvider.overrideWithValue(units),
        adViewBuilderProvider.overrideWithValue((unit) => FakeAd(unit)),
      ],
      child: MaterialApp(home: child),
    );

/// Layar tinggi agar seluruh daftar (12 item) dibangun sekaligus.
void tall(WidgetTester tester) {
  tester.view.physicalSize = const Size(1080, 12000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
}

void main() {
  group('konfigurasi unit iklan', () {
    test('build rilis tanpa ID unit: tidak ada iklan sama sekali (bukan iklan uji)', () {
      const units = AdUnits();
      expect(units.unitFor(AdPlacement.feed), isNull);
      expect(units.unitFor(AdPlacement.events), isNull);
    });

    test('build debug tanpa ID unit: unit uji resmi Google', () {
      const units = AdUnits(useTestUnits: true);
      expect(units.unitFor(AdPlacement.feed), const AdUnit(testNativeUnit, AdFormat.native));
      expect(units.unitFor(AdPlacement.events), const AdUnit(testBannerUnit, AdFormat.banner));
    });

    test('ID terkonfigurasi dipakai; native feed diutamakan, banner feed sebagai cadangan; format salah diabaikan', () {
      expect(configured.unitFor(AdPlacement.feed), const AdUnit('ca-app-pub-1234567890123456/1111111111', AdFormat.native));
      expect(configured.unitFor(AdPlacement.events), const AdUnit('ca-app-pub-1234567890123456/2222222222', AdFormat.banner));
      const bannerOnly = AdUnits(bannerFeed: 'ca-app-pub-1234567890123456/3333333333');
      expect(bannerOnly.unitFor(AdPlacement.feed)?.format, AdFormat.banner);
      const invalid = AdUnits(nativeFeed: 'bukan-id', bannerEvents: 'ca-app-pub-123~456');
      expect(invalid.unitFor(AdPlacement.feed), isNull);
      expect(invalid.unitFor(AdPlacement.events), isNull);
    });

    test('kerapatan iklan', () {
      final feed = [for (var i = 0; i < 20; i++) if (AdCadence.feed.after(i)) i];
      expect(feed, [3, 11, 19]);
      final events = [for (var i = 0; i < 20; i++) if (AdCadence.events.after(i)) i];
      expect(events, [4, 14]);
    });

    test('flag iklan dari server; server lama tanpa field: Premium = tanpa iklan', () {
      expect(profile(premium: false, ads: true).ads, isTrue);
      expect(profile(premium: true, ads: false).ads, isFalse);
      // Server yang berkata tanpa iklan selalu menang.
      expect(profile(premium: false, ads: false).ads, isFalse);
      expect(profile(premium: true).ads, isFalse);
      expect(profile(premium: false).ads, isTrue);
    });
  });

  group('slot iklan', () {
    testWidgets('feed pengguna gratis: iklan native setelah postingan ke-4 dan ke-12', (tester) async {
      tall(tester);
      await tester.pumpWidget(host(const FeedScreen(), me: profile(premium: false, ads: true)));
      await tester.pumpAndSettle();
      expect(find.text('Postingan 11'), findsOneWidget);
      expect(find.byType(FakeAd), findsNWidgets(2));
      expect(find.text('IKLAN native'), findsNWidgets(2));
    });

    testWidgets('feed Premium: tidak ada slot iklan', (tester) async {
      tall(tester);
      await tester.pumpWidget(host(const FeedScreen(), me: profile(premium: true, ads: false)));
      await tester.pumpAndSettle();
      expect(find.text('Postingan 11'), findsOneWidget);
      expect(find.byType(FakeAd), findsNothing);
      expect(find.byType(AdSlot), findsWidgets); // slot ada di pohon, tetapi kosong
    });

    testWidgets('status paket berubah saat sesi: iklan hilang begitu profil berkata Premium, muncul lagi saat berakhir', (tester) async {
      tall(tester);
      await tester.pumpWidget(host(const FeedScreen(), me: profile(premium: false, ads: true)));
      await tester.pumpAndSettle();
      expect(find.byType(FakeAd), findsNWidgets(2));

      final container = ProviderScope.containerOf(tester.element(find.byType(FeedScreen)));
      final auth = container.read(authControllerProvider.notifier) as FakeAuth;
      auth.set(profile(premium: true, ads: false));
      await tester.pumpAndSettle();
      expect(find.byType(FakeAd), findsNothing);

      auth.set(profile(premium: false, ads: true));
      await tester.pumpAndSettle();
      expect(find.byType(FakeAd), findsNWidgets(2));
    });

    testWidgets('belum masuk / profil belum diketahui: tanpa iklan', (tester) async {
      tall(tester);
      await tester.pumpWidget(host(const FeedScreen()));
      await tester.pumpAndSettle();
      expect(find.byType(FakeAd), findsNothing);
    });

    testWidgets('ID unit kosong (build rilis tanpa konfigurasi): slot kosong walau pengguna gratis', (tester) async {
      tall(tester);
      await tester.pumpWidget(host(const FeedScreen(), me: profile(premium: false, ads: true), units: const AdUnits()));
      await tester.pumpAndSettle();
      expect(find.text('Postingan 11'), findsOneWidget);
      expect(find.byType(FakeAd), findsNothing);
    });

    testWidgets('profil feed pengguna lain: tidak ada iklan', (tester) async {
      tall(tester);
      await tester.pumpWidget(host(const FeedProfileScreen(userId: 'u1'), me: profile(premium: false, ads: true)));
      await tester.pumpAndSettle();
      expect(find.text('Postingan 11'), findsOneWidget);
      expect(find.byType(AdSlot), findsNothing);
    });

    testWidgets('daftar event pengguna gratis: banner setelah event ke-5; Premium tanpa iklan', (tester) async {
      tall(tester);
      await tester.pumpWidget(host(const EventsScreen(), me: profile(premium: false, ads: true)));
      await tester.pumpAndSettle();
      expect(find.text('Event 11'), findsOneWidget);
      expect(find.text('IKLAN banner'), findsOneWidget);

      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(host(const EventsScreen(), me: profile(premium: true, ads: false)));
      await tester.pumpAndSettle();
      expect(find.text('Event 11'), findsOneWidget);
      expect(find.byType(FakeAd), findsNothing);
    });
  });

  group('struktur: iklan hanya di feed dan daftar event', () {
    final sources = {
      for (final f in Directory('lib').listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')))
        f.path.replaceAll(r'\', '/'): f.readAsStringSync(),
    };

    test('SDK iklan hanya dipakai modul ads', () {
      final users = sources.entries.where((e) => e.value.contains('package:google_mobile_ads')).map((e) => e.key).toList();
      expect(users, ['lib/features/ads/gma_ad_view.dart']);
    });

    test('slot iklan hanya di layar feed dan daftar event', () {
      final users = sources.entries
          .where((e) => !e.key.startsWith('lib/features/ads/') && e.value.contains('AdSlot('))
          .map((e) => e.key)
          .toList()
        ..sort();
      expect(users, ['lib/features/events/events_screens.dart', 'lib/features/feed/feed_screens.dart']);
    });

    test('tidak ada iklan layar penuh (interstitial / app open / rewarded)', () {
      for (final e in sources.entries) {
        expect(e.value, isNot(matches(RegExp(r'InterstitialAd|AppOpenAd|RewardedAd'))), reason: e.key);
      }
    });

    test('layar rekam lari, status lari, chat, SOS, dan langganan tidak menyentuh modul iklan', () {
      const forbidden = ['lib/features/runs/', 'lib/features/live/', 'lib/features/chat/', 'lib/features/safety/', 'lib/features/subscriptions/'];
      for (final e in sources.entries.where((e) => forbidden.any(e.key.startsWith))) {
        expect(e.value.contains('ads/ads.dart') || e.value.contains('google_mobile_ads'), isFalse, reason: e.key);
      }
    });
  });
}
