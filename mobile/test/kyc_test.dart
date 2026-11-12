import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pacetara/core/api/api_error.dart';
import 'package:pacetara/core/http/api_client.dart';
import 'package:pacetara/features/kyc/kyc_repository.dart';
import 'package:pacetara/features/kyc/kyc_screens.dart';
import 'package:pacetara/features/notifications/notifications_repository.dart';

Map<String, dynamic> statusJson({bool verified = false, int level = 1, Map<String, dynamic>? last, int attemptsLeft = 5}) => {
      'enabled': true,
      'level': verified ? 2 : level,
      'verified': verified,
      'verifiedAt': null,
      'consentVersion': '2026-11-12',
      'attemptsLeft': attemptsLeft,
      'last': last,
    };

Dio fakeDio(List<RequestOptions> seen, {required Map<String, dynamic> status, Map<String, dynamic>? submitResult}) => Dio()
  ..interceptors.add(InterceptorsWrapper(onRequest: (o, h) {
    seen.add(o);
    if (o.path == '/v1/kyc' && o.method == 'GET') return h.resolve(Response(requestOptions: o, statusCode: 200, data: status));
    if (o.path == '/v1/kyc' && o.method == 'POST') return h.resolve(Response(requestOptions: o, statusCode: 200, data: submitResult));
    h.reject(DioException(requestOptions: o, response: Response(requestOptions: o, statusCode: 404)));
  }));

void main() {
  test('model status dan galat Level 2', () {
    final s = KycStatus.fromJson(statusJson(last: {'status': 'review', 'auto': true, 'messages': ['Nama berbeda'], 'note': null}));
    expect(s.inReview, isTrue);
    expect(s.last!.messages, ['Nama berbeda']);
    final err = ApiError.from(DioException(
      requestOptions: RequestOptions(),
      response: Response(requestOptions: RequestOptions(), statusCode: 403, data: {'error': 'verification_required', 'message': 'Verifikasi KTP', 'requiredLevel': 2}),
    ));
    expect(err.requiredLevel, 2);
  });

  test('notifikasi hasil verifikasi membuka layar verifikasi', () {
    expect(routeForPush({'type': 'kyc_approved'}), '/verification');
    expect(notificationCategories.keys, contains('account'));
  });

  testWidgets('terverifikasi: tidak ada tombol mulai', (tester) async {
    final seen = <RequestOptions>[];
    await tester.pumpWidget(ProviderScope(
      overrides: [dioProvider.overrideWithValue(fakeDio(seen, status: statusJson(verified: true)))],
      child: const MaterialApp(home: KycScreen()),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Akunmu Terverifikasi (Level 2)'), findsOneWidget);
    expect(find.byKey(const Key('kyc-start')), findsNothing);
  });

  testWidgets('alur: persetujuan wajib, foto dari kamera, kirim multipart tanpa data di URL', (tester) async {
    final seen = <RequestOptions>[];
    final captured = <bool>[];
    Future<Uint8List?> fakeCapture({required bool selfie}) async {
      captured.add(selfie);
      // PNG 1×1 yang valid agar Image.memory bisa menggambar pratinjau.
      return base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
    }

    await tester.pumpWidget(ProviderScope(
      overrides: [
        dioProvider.overrideWithValue(fakeDio(seen,
            status: statusJson(last: {'status': 'retry', 'auto': true, 'messages': ['NIK tidak terbaca'], 'note': null}),
            submitResult: {'status': 'review', 'reasons': ['name_mismatch'], 'messages': ['Nama berbeda']})),
        capturePhotoProvider.overrideWithValue(fakeCapture),
      ],
      child: const MaterialApp(home: KycScreen()),
    ));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('kyc-last')), findsOneWidget);
    await tester.tap(find.byKey(const Key('kyc-start')));
    await tester.pumpAndSettle();

    // Tombol lanjut nonaktif sampai persetujuan dicentang.
    final next = find.byKey(const Key('kyc-consent-next'));
    await tester.scrollUntilVisible(next, 200, scrollable: find.byType(Scrollable).first);
    expect(tester.widget<FilledButton>(next).onPressed, isNull);
    await tester.tap(find.byKey(const Key('kyc-consent')));
    await tester.pump();
    await tester.tap(next);
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('kyc-nik')), '3174011205900001');
    await tester.enterText(find.byKey(const Key('kyc-name')), 'BUDI SANTOSO');
    await tester.tap(find.byKey(const Key('kyc-photo-ktp')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('kyc-photo-selfie')));
    await tester.pumpAndSettle();
    expect(captured, [false, true]);

    await tester.tap(find.byKey(const Key('kyc-submit')));
    // Tombol tetap memutar indikator selama dialog hasil terbuka, jadi tidak memakai pumpAndSettle.
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 200));
    }
    final post = seen.lastWhere((o) => o.method == 'POST');
    expect(post.uri.query, isEmpty);
    final form = post.data as FormData;
    final data = jsonDecode(form.fields.firstWhere((f) => f.key == 'data').value) as Map<String, dynamic>;
    expect(data, {'nik': '3174011205900001', 'name': 'BUDI SANTOSO', 'consent': true, 'consentVersion': '2026-11-12'});
    expect(form.files.map((f) => f.key), ['ktp', 'selfie']);
    expect(find.text('Sedang ditinjau'), findsOneWidget);
  });
}
