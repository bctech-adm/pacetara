import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pacetara/core/http/api_client.dart';
import 'package:pacetara/features/notifications/notifications_repository.dart';
import 'package:pacetara/features/notifications/notifications_screens.dart';

final communityJson = {
  'id': 'c1',
  'name': 'Lari Pagi',
  'city': 'Bandung',
  'visibility': 'private',
  'memberCount': 3,
  'logoUrl': null,
  'isPro': false,
  'myStatus': 'none',
  'myRole': null,
};

Dio fakeDio(List<RequestOptions> seen, {List<Map<String, dynamic>>? invitations}) => Dio()
  ..interceptors.add(InterceptorsWrapper(onRequest: (o, h) {
    seen.add(o);
    final Object? data = switch (o.path) {
      '/v1/notifications' => {
          'items': [
            {
              'id': 'n1',
              'type': 'join_request',
              'createdAt': '2026-11-11T01:00:00Z',
              'read': false,
              'actor': {'id': 'u2', 'displayName': 'Budi', 'avatarUrl': null},
              'community': {'id': 'c1', 'name': 'Lari Pagi'},
              'data': <String, dynamic>{},
            },
          ],
          'unread': 1,
          'hasMore': false,
        },
      '/v1/invitations' => invitations ??
          [
            {'id': 'i1', 'createdAt': '2026-11-11T01:00:00Z', 'invitedBy': {'id': 'u3', 'displayName': 'Admin'}, 'community': communityJson},
          ],
      '/v1/me/notification-settings' => {'chat': true, 'community': true, 'run_invite': true, 'friend_running': o.method == 'PUT' ? false : true},
      _ => null,
    };
    h.resolve(Response(requestOptions: o, statusCode: data == null ? 204 : 200, data: data));
  }));

Widget host(List<RequestOptions> seen, Widget child) => ProviderScope(
      overrides: [dioProvider.overrideWithValue(fakeDio(seen))],
      child: MaterialApp(home: child),
    );

void main() {
  test('rute saat push diketuk', () {
    expect(routeForPush({'type': 'chat', 'conversationId': 'v1'}), '/chat/v1');
    expect(routeForPush({'type': 'run_invite', 'conversationId': 'v1'}), '/chat/v1');
    expect(routeForPush({'type': 'community_invite', 'communityId': 'c1'}), '/notifications');
    expect(routeForPush({'type': 'friend_running', 'communityId': 'c1'}), '/communities/c1');
    expect(routeForPush({'type': 'chat'}), isNull);
    expect(routeForPush({'type': 'lain'}), isNull);
  });

  test('teks dan tujuan notifikasi', () {
    final n = AppNotification.fromJson({
      'id': 'n1',
      'type': 'run_invite',
      'createdAt': '2026-11-11T01:00:00Z',
      'actor': {'id': 'u1', 'displayName': 'Ani'},
      'community': {'id': 'c1', 'name': 'Lari Pagi'},
      'data': {'conversationId': 'v1', 'messageId': 'm1'},
    });
    expect(n.text, 'Ani mengajak lari bareng di Lari Pagi');
    expect(n.route, '/chat/v1');
    expect(AppNotification.fromJson({'id': 'x', 'type': 'join_approved', 'createdAt': '2026-11-11T01:00:00Z', 'community': {'id': 'c1', 'name': 'Lari Pagi'}}).text,
        'Permintaanmu bergabung ke Lari Pagi diterima');
  });

  testWidgets('layar notifikasi: undangan bisa ditolak, entri tampil, dibuka = ditandai dibaca', (tester) async {
    final seen = <RequestOptions>[];
    await tester.pumpWidget(host(seen, const NotificationsScreen()));
    await tester.pumpAndSettle();

    expect(find.text('Undangan komunitas'), findsOneWidget);
    expect(find.text('Lari Pagi'), findsOneWidget);
    expect(find.text('Budi ingin bergabung ke Lari Pagi'), findsOneWidget);
    expect(seen.any((o) => o.path == '/v1/notifications/read' && o.method == 'POST'), isTrue);

    await tester.tap(find.byKey(const Key('decline-i1')));
    await tester.pumpAndSettle();
    expect(seen.any((o) => o.path == '/v1/invitations/i1/decline' && o.method == 'POST'), isTrue);
  });

  testWidgets('pengaturan notifikasi: mematikan satu jenis mengirim PUT', (tester) async {
    final seen = <RequestOptions>[];
    await tester.pumpWidget(host(seen, const NotificationSettingsScreen()));
    await tester.pumpAndSettle();
    expect(find.text('Teman mulai lari'), findsOneWidget);

    await tester.tap(find.byKey(const Key('pref-friend_running')));
    await tester.pumpAndSettle();
    final put = seen.lastWhere((o) => o.method == 'PUT');
    expect(put.path, '/v1/me/notification-settings');
    expect(put.data, {'friend_running': false});
  });
}
