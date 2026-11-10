import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pacetara/core/api/api_error.dart';
import 'package:pacetara/core/http/api_client.dart';
import 'package:pacetara/features/chat/chat_repository.dart';
import 'package:pacetara/features/chat/chat_screens.dart';
import 'package:pacetara/features/moderation/moderation.dart';

/// Dio palsu: mencatat permintaan dan menjawab tanpa jaringan.
Dio fakeDio(List<RequestOptions> seen, {int status = 201}) => Dio()
  ..interceptors.add(InterceptorsWrapper(onRequest: (o, h) {
    seen.add(o);
    if (status >= 400) {
      h.reject(DioException(
        requestOptions: o,
        response: Response(requestOptions: o, statusCode: status, data: {'error': 'user_not_found', 'message': 'Pengguna tidak ditemukan'}),
      ));
    } else {
      h.resolve(Response(requestOptions: o, statusCode: status, data: {'id': 'r1'}));
    }
  }));

Widget host(List<RequestOptions> seen, {int status = 201}) => ProviderScope(
      overrides: [dioProvider.overrideWithValue(fakeDio(seen, status: status))],
      child: MaterialApp(
        home: Consumer(
          builder: (context, ref, _) => Scaffold(
            body: Center(
              child: FilledButton(
                onPressed: () => showReportSheet(context, ref, target: ReportTarget.message, targetId: 'm1', title: 'Laporkan pesan Budi'),
                child: const Text('buka'),
              ),
            ),
          ),
        ),
      ),
    );

void main() {
  testWidgets('lapor: alasan wajib dipilih, keterangan ikut terkirim, lembar tertutup', (tester) async {
    final seen = <RequestOptions>[];
    await tester.pumpWidget(host(seen));
    await tester.tap(find.text('buka'));
    await tester.pumpAndSettle();

    expect(find.text('Laporkan pesan Budi'), findsOneWidget);
    final submit = find.byKey(const Key('report-submit'));
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);

    await tester.tap(find.byKey(const Key('reason-harassment')));
    await tester.enterText(find.byType(TextField), 'Menghina anggota');
    await tester.pump();
    await tester.ensureVisible(submit);
    await tester.tap(submit);
    await tester.pumpAndSettle();

    expect(seen.single.path, '/v1/reports');
    expect(seen.single.data, {'targetType': 'message', 'targetId': 'm1', 'reason': 'harassment', 'details': 'Menghina anggota'});
    expect(find.text('Laporkan pesan Budi'), findsNothing);
    expect(find.textContaining('Laporan terkirim'), findsOneWidget);
  });

  testWidgets('lapor: galat server ditampilkan dan lembar tetap terbuka', (tester) async {
    final seen = <RequestOptions>[];
    await tester.pumpWidget(host(seen, status: 404));
    await tester.tap(find.text('buka'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('reason-spam')));
    await tester.pump();
    await tester.ensureVisible(find.byKey(const Key('report-submit')));
    await tester.tap(find.byKey(const Key('report-submit')));
    await tester.pumpAndSettle();
    expect(find.text('Pengguna tidak ditemukan'), findsOneWidget);
    expect(find.text('Laporkan pesan Budi'), findsOneWidget);
  });

  testWidgets('pesan disembunyikan dan diturunkan tidak menampilkan isi', (tester) async {
    Map<String, dynamic> json(Map<String, dynamic> extra) => {
          'id': 'm1',
          'seq': '1',
          'conversationId': 'c1',
          'sender': {'id': 'u2', 'displayName': 'Budi', 'avatarUrl': null},
          'isMine': false,
          'kind': 'text',
          'createdAt': '2026-11-10T06:00:00.000Z',
          'deleted': false,
          ...extra,
        };
    Widget wrap(ChatMessage m) => ProviderScope(
          child: MaterialApp(
            home: Scaffold(body: MessageBubble(message: m, showSender: false, onLongPress: () {}, onRetry: () {}, onDiscard: () {}, onRsvp: (_) {})),
          ),
        );

    await tester.pumpWidget(wrap(ChatMessage.fromJson(json({'hidden': true}))));
    expect(find.text('Pesan disembunyikan sambil ditinjau'), findsOneWidget);

    await tester.pumpWidget(wrap(ChatMessage.fromJson(json({'deleted': true, 'removedByAdmin': true}))));
    expect(find.text('Pesan diturunkan karena melanggar aturan'), findsOneWidget);
  });

  test('ringkasan percakapan dan deteksi akun diblokir', () {
    final hidden = LastMessage.fromJson({'kind': 'text', 'preview': null, 'deleted': false, 'hidden': true, 'isMine': false, 'senderName': 'Ani', 'createdAt': '2026-11-10T06:00:00Z'});
    expect(hidden.describe(showSender: true), 'Ani: Pesan disembunyikan');
    expect(isAccountBlocked(const ApiError(403, 'account_suspended', 'x')), isTrue);
    expect(isAccountBlocked(const ApiError(403, 'account_banned', 'x')), isTrue);
    expect(isAccountBlocked(const ApiError(401, 'invalid_credentials', 'x')), isFalse);
    expect(const PasswordCredentials('a@b.c', 'pw').toJson(), {'email': 'a@b.c', 'password': 'pw'});
    expect(const GoogleCredentials('tok').toJson(), {'googleIdToken': 'tok'});
  });
}
