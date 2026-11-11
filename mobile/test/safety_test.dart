import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pacetara/core/http/api_client.dart';
import 'package:pacetara/features/safety/safety_repository.dart';
import 'package:pacetara/features/safety/safety_screens.dart';

const contactJson = {'id': 'k1', 'name': 'Ibu', 'phone': '+6281234567890'};

Dio fakeDio(List<RequestOptions> seen, {List<Map<String, String>> contacts = const [contactJson], int delivered = 1}) => Dio()
  ..interceptors.add(InterceptorsWrapper(onRequest: (o, h) {
    seen.add(o);
    final Object? data = switch ((o.method, o.path)) {
      ('GET', '/v1/me/emergency-contacts') => contacts,
      ('POST', '/v1/sos') => {
          'delivered': delivered,
          'results': [for (final c in contacts) {...c, 'delivered': delivered > 0}],
        },
      _ => null,
    };
    h.resolve(Response(requestOptions: o, statusCode: data == null ? 204 : 200, data: data));
  }));

Widget host(List<RequestOptions> seen, Widget child, {List<Map<String, String>> contacts = const [contactJson]}) => ProviderScope(
      overrides: [dioProvider.overrideWithValue(fakeDio(seen, contacts: contacts))],
      child: MaterialApp(home: Scaffold(body: child)),
    );

Future<SosLocation?> fixedLocation() async => (lat: -6.2, lng: 106.8, accuracyM: 8.0);

void main() {
  // flutter_secure_storage tidak tersedia di tes: balas kosong.
  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'),
      (call) async => null,
    );
  });

  test('teks dan URI SMS cadangan', () {
    final body = sosSmsText('Ani', -6.2, 106.8);
    expect(body, contains('https://maps.google.com/?q=-6.200000,106.800000'));
    final uri = sosSmsUri(const [EmergencyContact(id: 'a', name: 'A', phone: '+62811'), EmergencyContact(id: 'b', name: 'B', phone: '+62822')], 'tolong saya');
    expect(uri.toString(), 'sms:+62811,+62822?body=tolong%20saya');
  });

  testWidgets('SOS: hitung mundur bisa dibatalkan tanpa mengirim', (tester) async {
    final seen = <RequestOptions>[];
    await tester.pumpWidget(host(seen, const SosSheet(locate: fixedLocation, userName: 'Ani')));
    await tester.pump();
    await tester.pump();
    expect(find.text('Mengirim SOS dalam 5…'), findsOneWidget);
    await tester.tap(find.byKey(const Key('sos-cancel')));
    await tester.pump(const Duration(seconds: 6));
    expect(seen.where((o) => o.path == '/v1/sos'), isEmpty);
  });

  testWidgets('SOS: terkirim otomatis setelah hitung mundur, lokasi di body, SMS cadangan tersedia', (tester) async {
    final seen = <RequestOptions>[];
    await tester.pumpWidget(host(seen, const SosSheet(locate: fixedLocation, userName: 'Ani', countdownSeconds: 2)));
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();

    final sos = seen.singleWhere((o) => o.path == '/v1/sos');
    expect(sos.method, 'POST');
    expect(sos.data, {'lat': -6.2, 'lng': 106.8, 'accuracyM': 8.0});
    expect(sos.queryParameters, isEmpty);
    expect(find.text('Lokasimu terkirim lewat WhatsApp ke 1 kontak darurat.'), findsOneWidget);
    expect(find.byKey(const Key('sos-sms')), findsOneWidget);
    expect(find.text('Telepon 112'), findsOneWidget);
  });

  testWidgets('SOS tanpa kontak darurat: arahkan ke pengaturan dan 112', (tester) async {
    final seen = <RequestOptions>[];
    await tester.pumpWidget(host(seen, const SosSheet(locate: fixedLocation, userName: 'Ani'), contacts: const []));
    await tester.pumpAndSettle();
    expect(find.text('Belum ada kontak darurat'), findsOneWidget);
    expect(find.text('Telepon 112'), findsOneWidget);
    expect(seen.where((o) => o.path == '/v1/sos'), isEmpty);
  });
}
