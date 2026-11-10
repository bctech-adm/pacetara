import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pacetara/core/api/api_error.dart';
import 'package:pacetara/core/realtime/realtime_client.dart';
import 'package:pacetara/features/chat/chat_repository.dart';
import 'package:pacetara/features/chat/chat_room.dart';
import 'package:pacetara/features/chat/chat_screens.dart';

const _conv = 'c0000000-0000-4000-8000-000000000000';
const _me = 'u0000000-0000-4000-8000-000000000001';

Map<String, dynamic> msgJson(int seq, {String? text, String sender = 'other', bool mine = false, String kind = 'text', Map<String, dynamic>? extra}) => {
      'id': 'm$seq',
      'seq': '$seq',
      'conversationId': _conv,
      'sender': {'id': mine ? _me : sender, 'displayName': mine ? 'Saya' : 'Budi', 'avatarUrl': null},
      'isMine': mine,
      'kind': kind,
      'createdAt': DateTime.utc(2026, 11, 10, 6, 0, seq).toIso8601String(),
      'deleted': false,
      'text': ?(kind == 'text' ? (text ?? 'pesan $seq') : null),
      ...?extra,
    };

ChatMessage msg(int seq, {bool mine = false}) => ChatMessage.fromJson(msgJson(seq, mine: mine));

class FakeChatRepository implements ChatRepository {
  /// Semua pesan server, urut seq.
  final server = <ChatMessage>[];
  final sentClientIds = <String>[];
  final reads = <int>[];
  bool failSend = false;
  int nextSeq = 1000;

  @override
  Future<MessagePage> messages(String convId, {int? before, int? after, int limit = 30}) async {
    Iterable<ChatMessage> list = server;
    if (after != null) {
      final page = list.where((m) => m.seq > after).take(limit).toList();
      return MessagePage(page, list.where((m) => m.seq > after).length > limit);
    }
    if (before != null) list = list.where((m) => m.seq < before);
    final all = list.toList();
    final page = all.length > limit ? all.sublist(all.length - limit) : all;
    return MessagePage(page, all.length > limit);
  }

  @override
  Future<ChatMessage> sendText(String convId, String clientMsgId, String text) async {
    sentClientIds.add(clientMsgId);
    if (failSend) throw const ApiError(0, 'network', 'Tidak ada koneksi');
    final existing = server.where((m) => m.id == 'client-$clientMsgId');
    if (existing.isNotEmpty) return existing.first;
    final m = ChatMessage.fromJson({...msgJson(nextSeq++, text: text, mine: true), 'id': 'client-$clientMsgId'});
    server.add(m);
    return m;
  }

  @override
  Future<ChatMessage> message(String id) async => server.firstWhere((m) => m.id == id);

  @override
  Future<void> markRead(String convId, int seq) async => reads.add(seq);

  @override
  Future<ChatMessage> sendInvite(String convId, String clientMsgId, RunInvite invite) => throw UnimplementedError();
  @override
  Future<ChatMessage> sendImage(String convId, String clientMsgId, String path) => throw UnimplementedError();
  @override
  Future<void> delete(String messageId) => throw UnimplementedError();
  @override
  Future<ChatMessage> rsvp(String messageId, {required bool going}) => throw UnimplementedError();
  @override
  Future<List<ConversationSummary>> conversations() async => const [];
  @override
  Future<ConversationSummary> conversation(String id) => throw UnimplementedError();
  @override
  Future<ConversationSummary> direct(String userId) => throw UnimplementedError();
  @override
  Future<ConversationSummary> community(String communityId) => throw UnimplementedError();
}

void main() {
  group('ChatRoomController', () {
    late FakeChatRepository repo;
    late StreamController<RealtimeEvent> events;
    late ProviderContainer container;

    setUp(() {
      repo = FakeChatRepository();
      events = StreamController<RealtimeEvent>.broadcast();
      container = ProviderContainer(overrides: [
        chatRepositoryProvider.overrideWithValue(repo),
        chatEventsProvider.overrideWithValue((ch) => events.stream.where((e) => e.channel == ch)),
      ]);
    });
    tearDown(() async {
      container.dispose();
      await events.close();
    });

    Future<void> settle() async {
      for (var i = 0; i < 5; i++) {
        await Future<void>.delayed(Duration.zero);
      }
    }

    ChatRoomState read() => container.read(chatRoomProvider(_conv));

    test('memuat 30 pesan terbaru, lalu yang lebih lama saat digulir, dan menandai sudah dibaca', () async {
      repo.server.addAll([for (var i = 1; i <= 45; i++) msg(i)]);
      container.listen(chatRoomProvider(_conv), (_, _) {});
      await settle();
      expect(read().messages.map((m) => m.seq), [for (var i = 16; i <= 45; i++) i]);
      expect(read().hasMore, isTrue);
      expect(repo.reads, [45]);

      await container.read(chatRoomProvider(_conv).notifier).loadOlder();
      expect(read().messages, hasLength(45));
      expect(read().messages.first.seq, 1);
      expect(read().hasMore, isFalse);
    });

    test('sinyal message.new mengambil pesan baru tanpa duplikat', () async {
      repo.server.addAll([msg(1), msg(2)]);
      container.listen(chatRoomProvider(_conv), (_, _) {});
      await settle();
      repo.server.addAll([msg(3), msg(4)]);
      events.add(const RealtimeEvent('conv:$_conv', 'message.new', {'seq': '4'}));
      events.add(const RealtimeEvent('conv:$_conv', 'message.new', {'seq': '4'}));
      await settle();
      expect(read().messages.map((m) => m.seq), [1, 2, 3, 4]);
      // Kanal percakapan lain diabaikan.
      repo.server.add(msg(5));
      events.add(const RealtimeEvent('conv:lain', 'message.new'));
      await settle();
      expect(read().messages, hasLength(4));
    });

    test('kirim: tampil langsung, gagal ditandai, kirim ulang memakai id klien yang sama', () async {
      container.listen(chatRoomProvider(_conv), (_, _) {});
      await settle();
      final room = container.read(chatRoomProvider(_conv).notifier);

      repo.failSend = true;
      await expectLater(room.sendText('halo', senderId: _me, senderName: 'Saya'), throwsA(isA<ApiError>()));
      final failed = read().messages.single;
      expect(failed.sendState, SendState.failed);
      expect(failed.text, 'halo');

      repo.failSend = false;
      await room.retry(failed);
      expect(repo.sentClientIds, hasLength(2));
      expect(repo.sentClientIds.toSet(), hasLength(1));
      final sent = read().messages.single;
      expect(sent.sendState, SendState.sent);
      expect(sent.text, 'halo');

      // Sinyal dari pesan sendiri tidak membuat salinan ganda.
      events.add(RealtimeEvent('conv:$_conv', 'message.new', {'seq': '${sent.seq}'}));
      await settle();
      expect(read().messages, hasLength(1));
    });

    test('pesan yang belum terkirim tetap di bawah walau pesan lain masuk', () async {
      repo.server.add(msg(1));
      container.listen(chatRoomProvider(_conv), (_, _) {});
      await settle();
      final room = container.read(chatRoomProvider(_conv).notifier);
      repo.failSend = true;
      await expectLater(room.sendText('tertahan', senderId: _me, senderName: 'Saya'), throwsA(isA<ApiError>()));
      repo.server.add(msg(2));
      await room.sync();
      expect(read().messages.map((m) => m.text), ['pesan 1', 'pesan 2', 'tertahan']);
      room.discard(read().messages.last);
      expect(read().messages, hasLength(2));
    });
  });

  test('model: pesan terhapus, gambar kedaluwarsa, ajakan lari, ringkasan percakapan', () {
    final deleted = ChatMessage.fromJson({...msgJson(1, kind: 'text'), 'deleted': true, 'text': null});
    expect(deleted.deleted, isTrue);
    expect(deleted.text, isNull);

    final expired = ChatMessage.fromJson(msgJson(2, kind: 'image', extra: {'imageExpired': true}));
    expect(expired.imageExpired, isTrue);
    expect(expired.imageUrl, isNull);

    final invite = ChatMessage.fromJson(msgJson(3, kind: 'run_invite', extra: {
      'invite': {'title': 'Long run', 'startsAt': '2026-11-15T23:00:00.000Z', 'place': 'GBK', 'note': '', 'goingCount': 2, 'iAmGoing': true, 'going': ['Ani', 'Budi']},
    }));
    expect(invite.invite!.goingCount, 2);
    expect(invite.invite!.iAmGoing, isTrue);
    expect(invite.invite!.toJson()['startsAt'], '2026-11-15T23:00:00.000Z');

    final last = LastMessage.fromJson({'kind': 'text', 'preview': 'halo', 'deleted': false, 'isMine': false, 'senderName': 'Ani', 'createdAt': '2026-11-10T06:00:00Z'});
    expect(last.describe(showSender: true), 'Ani: halo');
    expect(last.describe(showSender: false), 'halo');
    final mine = LastMessage.fromJson({'kind': 'image', 'deleted': false, 'isMine': true, 'createdAt': '2026-11-10T06:00:00Z'});
    expect(mine.describe(showSender: true), 'Kamu: Gambar');

    expect(newClientId(), matches(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')));
  });

  testWidgets('gelembung pesan: terhapus, kedaluwarsa, gagal terkirim, ajakan lari dengan tombol ikut', (tester) async {
    bool? rsvp;
    var retried = false;
    Widget wrap(ChatMessage m) => ProviderScope(
          child: MaterialApp(
            home: Scaffold(
              body: MessageBubble(message: m, showSender: true, onLongPress: () {}, onRetry: () => retried = true, onDiscard: () {}, onRsvp: (g) => rsvp = g),
            ),
          ),
        );

    await tester.pumpWidget(wrap(ChatMessage.fromJson({...msgJson(1), 'deleted': true, 'text': null})));
    expect(find.text('Pesan dihapus'), findsOneWidget);

    await tester.pumpWidget(wrap(ChatMessage.fromJson(msgJson(2, kind: 'image', extra: {'imageExpired': true}))));
    expect(find.text('Gambar sudah kedaluwarsa'), findsOneWidget);

    final failed = ChatMessage(
      id: 'local-x',
      seq: -1,
      senderId: _me,
      senderName: 'Saya',
      senderAvatarUrl: null,
      isMine: true,
      kind: 'text',
      createdAt: DateTime(2026, 11, 10, 6),
      text: 'halo',
      clientMsgId: 'x',
      sendState: SendState.failed,
    );
    await tester.pumpWidget(wrap(failed));
    expect(find.textContaining('Gagal terkirim'), findsOneWidget);
    await tester.tap(find.textContaining('Gagal terkirim'));
    expect(retried, isTrue);

    final startsAt = DateTime.now().add(const Duration(days: 1)).toUtc().toIso8601String();
    await tester.pumpWidget(wrap(ChatMessage.fromJson(msgJson(3, kind: 'run_invite', extra: {
      'invite': {'title': 'Long run Minggu', 'startsAt': startsAt, 'place': 'GOR Saparua', 'note': '15 km', 'goingCount': 0, 'iAmGoing': false, 'going': <String>[]},
    }))));
    expect(find.text('Long run Minggu'), findsOneWidget);
    expect(find.text('Belum ada yang ikut'), findsOneWidget);
    await tester.tap(find.text('Ikut'));
    expect(rsvp, isTrue);
  });
}
