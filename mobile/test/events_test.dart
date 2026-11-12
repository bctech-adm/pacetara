import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pacetara/core/http/api_client.dart';
import 'package:pacetara/features/chat/chat_repository.dart';
import 'package:pacetara/features/chat/chat_screens.dart';
import 'package:pacetara/features/notifications/notifications_repository.dart';
import 'package:pacetara/features/events/event_submit_screens.dart';
import 'package:pacetara/features/events/events_repository.dart';
import 'package:pacetara/features/events/events_screens.dart';

Map<String, dynamic> eventJson({
  String id = 'e1',
  String name = 'Bandung Marathon',
  String date = '2026-12-14',
  bool iAmGoing = false,
  int friendsGoing = 0,
}) =>
    {
      'id': id,
      'name': name,
      'date': date,
      'startTime': '05:00',
      'city': 'Bandung',
      'venue': 'Gedung Sate',
      'categories': ['10k', 'hm'],
      'archived': false,
      'goingCount': 3,
      'iAmGoing': iAmGoing,
      'friendsGoing': friendsGoing,
    };

Map<String, dynamic> detailJson({bool iAmGoing = false}) => {
      ...eventJson(iAmGoing: iAmGoing, friendsGoing: 1),
      'description': 'Lomba tahunan',
      'registrationUrl': 'https://contoh-lari.id/daftar',
      'source': {'origin': 'scrape', 'name': 'Kalender Lari Uji', 'url': 'https://kalender.uji.id/event/bm'},
      'friendsPreview': [
        {'id': 'u2', 'displayName': 'Teman', 'avatarUrl': null, 'communities': ['Lari Pagi']},
      ],
    };

/// Dio palsu: mencatat permintaan dan menjawab sesuai path.
Dio fakeDio(List<RequestOptions> seen) => Dio()
  ..interceptors.add(InterceptorsWrapper(onRequest: (o, h) {
    seen.add(o);
    final Object data = switch (o.path) {
      '/v1/events/cities' => [
          {'city': 'Bandung', 'events': 2},
        ],
      '/v1/events' => {
          'items': o.queryParameters['going'] == 'true'
              ? [eventJson(iAmGoing: true)]
              : [eventJson(), eventJson(id: 'e2', name: 'Jakarta Run', date: '2027-01-05', friendsGoing: 2)],
          'nextCursor': null,
        },
      '/v1/events/e1/going' => detailJson(iAmGoing: o.method == 'POST'),
      '/v1/event-submissions' => o.method == 'POST'
          ? {'id': 's9', 'status': 'pending'}
          : {
              'items': [
                {'id': 's1', 'status': 'pending', 'name': 'Bogor Trail', 'date': '2026-12-20', 'city': 'Bogor', 'rejectReason': null, 'eventId': null, 'createdAt': '2026-11-12T00:00:00Z'},
                {'id': 's2', 'status': 'rejected', 'name': 'Lari Palsu', 'date': '2026-12-21', 'city': 'Depok', 'rejectReason': 'Tautan tidak resmi', 'eventId': null, 'createdAt': '2026-11-12T00:00:00Z'},
                {'id': 's3', 'status': 'approved', 'name': 'Bandung Marathon', 'date': '2026-12-14', 'city': 'Bandung', 'rejectReason': null, 'eventId': 'e1', 'createdAt': '2026-11-12T00:00:00Z'},
              ],
              'dailyLimit': 5,
            },
      _ => detailJson(),
    };
    h.resolve(Response(requestOptions: o, statusCode: 200, data: data));
  }));

Widget host(List<RequestOptions> seen, Widget child) => ProviderScope(
      overrides: [dioProvider.overrideWithValue(fakeDio(seen))],
      child: MaterialApp(home: child),
    );

void main() {
  test('format tanggal event dan daftar bulan', () {
    expect(formatEventDate('2026-12-14', '05:00'), 'Sen, 14 Des 2026 · 05:00');
    expect(formatEventDate('2026-12-14', null), 'Sen, 14 Des 2026');
    expect(categoryLabels(['10k', 'hm']), '10K · Half marathon');
    final months = upcomingMonths(DateTime(2026, 11, 11));
    expect(months.first, '2026-11');
    expect(months[2], '2027-01');
    expect(months, hasLength(12));
    expect(monthLabel('2027-01'), 'Januari 2027');
  });

  test('model event dan kartu chat', () {
    final e = EventDetail.fromJson(detailJson());
    expect(e.summary.name, 'Bandung Marathon');
    expect(e.friendsPreview.single.communities, ['Lari Pagi']);

    final m = ChatMessage.fromJson({
      'id': 'm1',
      'seq': '7',
      'sender': {'id': 'u1', 'displayName': 'Budi'},
      'kind': 'event',
      'createdAt': '2026-11-11T00:00:00Z',
      'event': {'id': 'e1', 'name': 'Bandung Marathon', 'available': false},
    });
    expect(m.event!.available, isFalse);
    final last = LastMessage.fromJson({'kind': 'event', 'preview': 'Bandung Marathon', 'createdAt': '2026-11-11T00:00:00Z', 'senderName': 'Budi'});
    expect(last.describe(showSender: true), 'Budi: Event: Bandung Marathon');
  });

  testWidgets('daftar event: dikelompokkan per bulan, filter "yang saya ikuti"', (tester) async {
    final seen = <RequestOptions>[];
    await tester.pumpWidget(host(seen, const EventsScreen()));
    await tester.pumpAndSettle();

    expect(find.text('Desember 2026'), findsOneWidget);
    expect(find.text('Januari 2027'), findsOneWidget);
    expect(find.text('Jakarta Run'), findsOneWidget);
    expect(find.text('2 anggota komunitasmu ikut'), findsOneWidget);

    await tester.tap(find.byKey(const Key('filter-going')));
    await tester.pumpAndSettle();
    final last = seen.lastWhere((o) => o.path == '/v1/events');
    expect(last.queryParameters['going'], 'true');
    expect(find.text('Jakarta Run'), findsNothing);
    expect(find.text('Kamu ikut'), findsOneWidget);
  });

  testWidgets('detail event: anggota komunitas yang ikut, tombol ikut mengirim POST', (tester) async {
    final seen = <RequestOptions>[];
    await tester.pumpWidget(host(seen, const EventDetailScreen(id: 'e1')));
    await tester.pumpAndSettle();

    expect(find.text('Bandung Marathon'), findsOneWidget);
    expect(find.text('Sen, 14 Des 2026 · 05:00'), findsOneWidget);
    expect(find.text('3 pelari menandai ikut'), findsOneWidget);
    expect(find.text('Teman'), findsOneWidget);
    expect(find.text('Daftar di contoh-lari.id'), findsOneWidget);
    // PRD 2.4: sumber dan tautan resmi selalu tampil.
    expect(find.text('Sumber: Kalender Lari Uji · '), findsOneWidget);
    expect(find.text('Lihat halaman resmi'), findsOneWidget);

    await tester.ensureVisible(find.byKey(const Key('event-going')));
    await tester.tap(find.byKey(const Key('event-going')));
    await tester.pumpAndSettle();
    expect(seen.any((o) => o.method == 'POST' && o.path == '/v1/events/e1/going'), isTrue);
  });

  testWidgets('kartu event di chat: tersedia dan tidak tersedia', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(
        body: Column(children: [
          EventChatCard(event: SharedEvent(id: 'e1', name: 'Bandung Marathon', available: true, date: '2026-12-14', city: 'Bandung', categories: ['fm'])),
          EventChatCard(event: SharedEvent(id: 'e2', name: 'Event Lama', available: false)),
        ]),
      ),
    ));
    expect(find.text('Sen, 14 Des 2026'), findsOneWidget);
    expect(find.text('Marathon'), findsOneWidget);
    expect(find.text('Event tidak tersedia lagi'), findsOneWidget);
  });

  test('sumber event: dari server dan cadangan untuk respons lama', () {
    final d = EventDetail.fromJson(detailJson());
    expect(d.source.label, 'Sumber: Kalender Lari Uji');
    expect(d.source.url, 'https://kalender.uji.id/event/bm');
    final old = EventDetail.fromJson({...detailJson()}..remove('source'));
    expect(old.source.label, 'Sumber: Tim PaceTara');
    expect(old.source.url, 'https://contoh-lari.id/daftar');
    expect(const EventSourceInfo(origin: 'user', name: 'Bogor Trail', url: 'https://x.id').label, 'Sumber: Bogor Trail (kiriman penyelenggara)');
  });

  test('formulir kirim event: validasi tautan dan body', () {
    expect(validateHttpsUrl('https://daftar.id/x'), isNull);
    expect(validateHttpsUrl('http://daftar.id/x'), isNotNull);
    expect(validateHttpsUrl('https://localhost'), isNotNull);
    expect(validateHttpsUrl(''), 'Wajib diisi');
    expect(validateHttpsUrl('', required: false), isNull);
    final body = const EventSubmissionInput(
      name: ' Bogor Trail ',
      date: '2026-12-20',
      city: 'Bogor',
      categories: ['10k'],
      registrationUrl: 'https://daftar.id/x',
      officialUrl: ' ',
      organizer: 'Komunitas',
      contact: '',
    ).toJson();
    expect(body['name'], 'Bogor Trail');
    expect(body['officialUrl'], isNull);
    expect(body['contact'], isNull);
  });

  testWidgets('formulir kirim event: field wajib divalidasi, tidak ada permintaan', (tester) async {
    final seen = <RequestOptions>[];
    await tester.pumpWidget(host(seen, const SubmitEventScreen()));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const Key('submit-send')));
    await tester.tap(find.byKey(const Key('submit-send')));
    await tester.pumpAndSettle();
    expect(find.text('Minimal 3 karakter'), findsOneWidget);
    expect(seen.where((o) => o.path == '/v1/event-submissions'), isEmpty);
  });

  testWidgets('kiriman saya: status dan alasan penolakan', (tester) async {
    final seen = <RequestOptions>[];
    await tester.pumpWidget(host(seen, const MySubmissionsScreen()));
    await tester.pumpAndSettle();
    expect(find.text('Menunggu ditinjau'), findsOneWidget);
    expect(find.text('Ditolak'), findsOneWidget);
    expect(find.text('Alasan: Tautan tidak resmi'), findsOneWidget);
    expect(find.text('Tayang'), findsOneWidget);
  });

  test('notifikasi kiriman event: teks dan tujuan', () {
    AppNotification n(String type, Map<String, String> data) =>
        AppNotification.fromJson({'id': 'n1', 'type': type, 'createdAt': '2026-11-12T00:00:00Z', 'read': false, 'actor': null, 'community': null, 'data': data});
    final ok = n('event_submission_approved', {'submissionId': 's1', 'eventId': 'e1'});
    expect(ok.text, 'Event kirimanmu sudah tayang di kalender');
    expect(ok.route, '/events/e1');
    expect(n('event_submission_rejected', {'submissionId': 's1'}).route, '/events/submissions');
    expect(routeForPush({'type': 'event_submission_approved', 'eventId': 'e1'}), '/events/e1');
    expect(routeForPush({'type': 'event_submission_rejected'}), '/events/submissions');
    expect(notificationCategories.containsKey('event'), isTrue);
  });
}
