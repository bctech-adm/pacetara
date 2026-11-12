import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pacetara/core/http/api_client.dart';
import 'package:pacetara/features/auth/auth_controller.dart';
import 'package:pacetara/features/auth/models.dart';
import 'package:pacetara/features/banners/sponsor_banner.dart';

class FakeAuth extends AuthController {
  FakeAuth(this.initial);
  final MyProfile? initial;

  @override
  Future<MyProfile?> build() async => initial;
}

MyProfile profile({required bool premium}) => MyProfile.fromJson({'id': 'me', 'displayName': 'Saya', 'badges': [if (premium) 'premium'], 'ads': !premium});

// PNG 1×1 yang valid.
final png = base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');

Dio fakeDio(List<RequestOptions> seen, {bool hasBanner = true}) => Dio()
  ..interceptors.add(InterceptorsWrapper(onRequest: (o, h) {
    seen.add(o);
    if (o.path == '/v1/banners/pick') {
      return h.resolve(Response(requestOptions: o, statusCode: 200, data: {
        'banner': hasBanner ? {'id': 'b1', 'title': 'Diskon sepatu', 'imageUrl': '/v1/banners/b1/image', 'eventId': null, 'hasLink': true, 'sponsored': true} : null,
      }));
    }
    if (o.path == '/v1/banners/b1/image') return h.resolve(Response(requestOptions: o, statusCode: 200, data: png.toList()));
    if (o.path == '/v1/banners/b1/impression') return h.resolve(Response(requestOptions: o, statusCode: 204));
    h.reject(DioException(requestOptions: o, response: Response(requestOptions: o, statusCode: 404)));
  }));

Widget host(List<RequestOptions> seen, MyProfile me, {bool hasBanner = true}) => ProviderScope(
      overrides: [
        dioProvider.overrideWithValue(fakeDio(seen, hasBanner: hasBanner)),
        authControllerProvider.overrideWith(() => FakeAuth(me)),
      ],
      child: const MaterialApp(home: Scaffold(body: SponsorBanner(slot: 'home', city: 'Bandung'))),
    );

void main() {
  testWidgets('pengguna gratis: banner tampil berlabel Sponsor, kota di body, tayangan dicatat', (tester) async {
    final seen = <RequestOptions>[];
    await tester.pumpWidget(host(seen, profile(premium: false)));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('sponsor-banner')), findsOneWidget);
    expect(find.text('Sponsor'), findsOneWidget);
    final pick = seen.firstWhere((o) => o.path == '/v1/banners/pick');
    expect(pick.method, 'POST');
    expect(pick.uri.query, isEmpty);
    expect(pick.data, {'slot': 'home', 'city': 'Bandung'});
    // Tayangan dikirim setelah frame tergambar.
    await tester.pump(const Duration(milliseconds: 100));
    expect(seen.where((o) => o.path == '/v1/banners/b1/impression'), hasLength(1));
  });

  testWidgets('Premium: tidak meminta banner sama sekali', (tester) async {
    final seen = <RequestOptions>[];
    await tester.pumpWidget(host(seen, profile(premium: true)));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('sponsor-banner')), findsNothing);
    expect(seen, isEmpty);
  });

  testWidgets('tanpa banner: slot tidak memakan tempat', (tester) async {
    final seen = <RequestOptions>[];
    await tester.pumpWidget(host(seen, profile(premium: false), hasBanner: false));
    await tester.pumpAndSettle();
    expect(find.text('Sponsor'), findsNothing);
    expect(tester.getSize(find.byType(SponsorBanner)).height, 0);
  });
}
