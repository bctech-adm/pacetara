import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_error.dart';
import '../../core/http/api_client.dart';

enum ConversationKind { direct, community }

class LastMessage {
  const LastMessage({
    required this.kind,
    required this.preview,
    required this.deleted,
    required this.isMine,
    required this.senderName,
    required this.createdAt,
    this.hidden = false,
    this.blocked = false,
  });
  final String kind;
  final String? preview;
  final bool deleted;

  /// Dari pengguna yang kamu blokir (chat komunitas): isi tidak dikirim server.
  final bool blocked;

  /// Disembunyikan sambil ditinjau (banyak laporan).
  final bool hidden;
  final bool isMine;
  final String? senderName;
  final DateTime createdAt;

  factory LastMessage.fromJson(Map<String, dynamic> j) => LastMessage(
        kind: j['kind'] as String,
        preview: j['preview'] as String?,
        deleted: j['deleted'] as bool? ?? false,
        hidden: j['hidden'] as bool? ?? false,
        blocked: j['blocked'] as bool? ?? false,
        isMine: j['isMine'] as bool? ?? false,
        senderName: j['senderName'] as String?,
        createdAt: DateTime.parse(j['createdAt'] as String),
      );

  /// Teks ringkas untuk daftar percakapan.
  String describe({required bool showSender}) {
    final body = deleted
        ? 'Pesan dihapus'
        : blocked
            ? 'Pesan dari pengguna yang kamu blokir'
            : hidden
            ? 'Pesan disembunyikan'
            : switch (kind) {
            'image' => 'Gambar',
            'run_invite' => 'Ajakan lari: ${preview ?? ''}',
            'event' => 'Event: ${preview ?? ''}',
            _ => preview ?? '',
          };
    if (isMine) return 'Kamu: $body';
    return showSender && senderName != null ? '$senderName: $body' : body;
  }
}

class ConversationSummary {
  const ConversationSummary({
    required this.id,
    required this.kind,
    required this.title,
    required this.avatarUrl,
    required this.communityId,
    required this.otherUserId,
    required this.otherUserActive,
    required this.unread,
    required this.lastMessage,
    this.otherUserBlockedByMe = false,
  });

  final String id;
  final ConversationKind kind;
  final String title;
  final String? avatarUrl;
  final String? communityId;
  final String? otherUserId;
  final bool otherUserActive;

  /// Chat pribadi: kamu memblokir pengguna ini (tidak bisa saling mengirim pesan sampai blokir dibuka).
  final bool otherUserBlockedByMe;
  final int unread;
  final LastMessage? lastMessage;

  factory ConversationSummary.fromJson(Map<String, dynamic> j) {
    final other = j['otherUser'] as Map<String, dynamic>?;
    final last = j['lastMessage'] as Map<String, dynamic>?;
    return ConversationSummary(
      id: j['id'] as String,
      kind: j['kind'] == 'direct' ? ConversationKind.direct : ConversationKind.community,
      title: j['title'] as String,
      avatarUrl: j['avatarUrl'] as String?,
      communityId: j['communityId'] as String?,
      otherUserId: other?['id'] as String?,
      otherUserActive: other?['active'] as bool? ?? true,
      otherUserBlockedByMe: other?['blockedByMe'] as bool? ?? false,
      unread: (j['unread'] as num?)?.toInt() ?? 0,
      lastMessage: last == null ? null : LastMessage.fromJson(last),
    );
  }
}

class RunInvite {
  const RunInvite({
    required this.title,
    required this.startsAt,
    required this.place,
    required this.note,
    this.goingCount = 0,
    this.iAmGoing = false,
    this.going = const [],
  });
  final String title;
  final DateTime startsAt;
  final String place;
  final String note;
  final int goingCount;
  final bool iAmGoing;
  final List<String> going;

  factory RunInvite.fromJson(Map<String, dynamic> j) => RunInvite(
        title: j['title'] as String,
        startsAt: DateTime.parse(j['startsAt'] as String),
        place: j['place'] as String,
        note: j['note'] as String? ?? '',
        goingCount: (j['goingCount'] as num?)?.toInt() ?? 0,
        iAmGoing: j['iAmGoing'] as bool? ?? false,
        going: (j['going'] as List<dynamic>? ?? const []).map((e) => e as String).toList(),
      );

  Map<String, Object> toJson() => {'title': title, 'startsAt': startsAt.toUtc().toIso8601String(), 'place': place, 'note': note};
}

/// Kartu "bagikan event". Data terkini dari server; [available] false jika event sudah dihapus.
class SharedEvent {
  const SharedEvent({
    required this.id,
    required this.name,
    required this.available,
    this.date,
    this.startTime,
    this.city,
    this.categories = const [],
    this.archived = false,
  });
  final String id;
  final String name;
  final bool available;
  final String? date;
  final String? startTime;
  final String? city;
  final List<String> categories;
  final bool archived;

  factory SharedEvent.fromJson(Map<String, dynamic> j) => SharedEvent(
        id: j['id'] as String,
        name: j['name'] as String,
        available: j['available'] as bool? ?? false,
        date: j['date'] as String?,
        startTime: j['startTime'] as String?,
        city: j['city'] as String?,
        categories: (j['categories'] as List<dynamic>? ?? const []).map((e) => e as String).toList(),
        archived: j['archived'] as bool? ?? false,
      );
}

enum SendState { sent, sending, failed }

class ChatMessage {
  const ChatMessage({
    required this.id,
    required this.seq,
    required this.senderId,
    required this.senderName,
    required this.senderAvatarUrl,
    required this.isMine,
    required this.kind,
    required this.createdAt,
    this.deleted = false,
    this.removedByAdmin = false,
    this.hidden = false,
    this.blocked = false,
    this.text,
    this.imageUrl,
    this.imageExpired = false,
    this.invite,
    this.event,
    this.clientMsgId,
    this.sendState = SendState.sent,
    this.localImagePath,
  });

  final String id;

  /// Urutan server; pesan yang belum terkirim memakai -1 (tampil paling bawah).
  final int seq;
  final String senderId;
  final String senderName;
  final String? senderAvatarUrl;
  final bool isMine;
  final String kind;
  final DateTime createdAt;
  final bool deleted;

  /// Diturunkan tim moderasi.
  final bool removedByAdmin;

  /// Disembunyikan otomatis sambil ditinjau (banyak laporan); pengirim tetap melihat isinya.
  final bool hidden;

  /// Dari pengguna yang kamu blokir (chat komunitas): isi tidak dikirim server.
  final bool blocked;
  final String? text;
  final String? imageUrl;
  final bool imageExpired;
  final RunInvite? invite;
  final SharedEvent? event;

  /// Hanya untuk pesan lokal yang sedang/gagal dikirim.
  final String? clientMsgId;
  final SendState sendState;
  final String? localImagePath;

  bool get isPending => sendState != SendState.sent;

  factory ChatMessage.fromJson(Map<String, dynamic> j) {
    final sender = j['sender'] as Map<String, dynamic>;
    final invite = j['invite'] as Map<String, dynamic>?;
    final event = j['event'] as Map<String, dynamic>?;
    return ChatMessage(
      id: j['id'] as String,
      seq: int.parse(j['seq'] as String),
      senderId: sender['id'] as String,
      senderName: sender['displayName'] as String,
      senderAvatarUrl: sender['avatarUrl'] as String?,
      isMine: j['isMine'] as bool? ?? false,
      kind: j['kind'] as String,
      createdAt: DateTime.parse(j['createdAt'] as String),
      deleted: j['deleted'] as bool? ?? false,
      removedByAdmin: j['removedByAdmin'] as bool? ?? false,
      hidden: j['hidden'] as bool? ?? false,
      blocked: j['blocked'] as bool? ?? false,
      text: j['text'] as String?,
      imageUrl: j['imageUrl'] as String?,
      imageExpired: j['imageExpired'] as bool? ?? false,
      invite: invite == null ? null : RunInvite.fromJson(invite),
      event: event == null ? null : SharedEvent.fromJson(event),
    );
  }

  ChatMessage withState(SendState s) => ChatMessage(
        id: id,
        seq: seq,
        senderId: senderId,
        senderName: senderName,
        senderAvatarUrl: senderAvatarUrl,
        isMine: isMine,
        kind: kind,
        createdAt: createdAt,
        text: text,
        invite: invite,
        event: event,
        clientMsgId: clientMsgId,
        sendState: s,
        localImagePath: localImagePath,
      );
}

class MessagePage {
  const MessagePage(this.items, this.hasMore);
  final List<ChatMessage> items;
  final bool hasMore;
}

/// Semua panggilan API chat. Galat dilempar sebagai [ApiError]. Isi pesan tidak pernah di-log.
class ChatRepository {
  ChatRepository(this._dio);
  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() fn) async {
    try {
      return await fn();
    } catch (e) {
      throw ApiError.from(e);
    }
  }

  Future<List<ConversationSummary>> conversations() => _call(() async {
        final res = await _dio.get<List<dynamic>>('/v1/chat/conversations');
        return res.data!.map((e) => ConversationSummary.fromJson(e as Map<String, dynamic>)).toList();
      });

  Future<ConversationSummary> conversation(String id) => _summary(() => _dio.get<Map<String, dynamic>>('/v1/chat/conversations/$id'));

  Future<ConversationSummary> direct(String userId) =>
      _summary(() => _dio.post<Map<String, dynamic>>('/v1/chat/direct', data: {'userId': userId}));

  Future<ConversationSummary> community(String communityId) =>
      _summary(() => _dio.get<Map<String, dynamic>>('/v1/chat/communities/$communityId'));

  Future<ConversationSummary> _summary(Future<Response<Map<String, dynamic>>> Function() fn) =>
      _call(() async => ConversationSummary.fromJson((await fn()).data!));

  Future<MessagePage> messages(String convId, {int? before, int? after, int limit = 30}) => _call(() async {
        final res = await _dio.get<Map<String, dynamic>>('/v1/chat/conversations/$convId/messages', queryParameters: {
          'before': ?before?.toString(),
          'after': ?after?.toString(),
          'limit': limit,
        });
        final data = res.data!;
        return MessagePage(
          (data['items'] as List<dynamic>).map((e) => ChatMessage.fromJson(e as Map<String, dynamic>)).toList(),
          data['hasMore'] as bool? ?? false,
        );
      });

  Future<ChatMessage> message(String id) => _msg(() => _dio.get<Map<String, dynamic>>('/v1/chat/messages/$id'));

  Future<ChatMessage> sendText(String convId, String clientMsgId, String text) => _msg(
        () => _dio.post<Map<String, dynamic>>('/v1/chat/conversations/$convId/messages', data: {'clientMsgId': clientMsgId, 'kind': 'text', 'text': text}),
      );

  Future<ChatMessage> sendInvite(String convId, String clientMsgId, RunInvite invite) => _msg(
        () => _dio.post<Map<String, dynamic>>('/v1/chat/conversations/$convId/messages',
            data: {'clientMsgId': clientMsgId, 'kind': 'run_invite', 'invite': invite.toJson()}),
      );

  /// Bagikan event dari kalender sebagai kartu.
  Future<ChatMessage> sendEvent(String convId, String clientMsgId, String eventId) => _msg(
        () => _dio.post<Map<String, dynamic>>('/v1/chat/conversations/$convId/messages',
            data: {'clientMsgId': clientMsgId, 'kind': 'event', 'eventId': eventId}),
      );

  Future<ChatMessage> sendImage(String convId, String clientMsgId, String path) => _msg(() async {
        final form = FormData.fromMap({'clientMsgId': clientMsgId, 'file': await MultipartFile.fromFile(path, filename: 'image')});
        return _dio.post<Map<String, dynamic>>('/v1/chat/conversations/$convId/images', data: form);
      });

  Future<void> delete(String messageId) => _call(() => _dio.delete<void>('/v1/chat/messages/$messageId'));

  Future<ChatMessage> rsvp(String messageId, {required bool going}) => _msg(() => going
      ? _dio.post<Map<String, dynamic>>('/v1/chat/messages/$messageId/rsvp')
      : _dio.delete<Map<String, dynamic>>('/v1/chat/messages/$messageId/rsvp'));

  Future<void> markRead(String convId, int seq) =>
      _call(() => _dio.post<void>('/v1/chat/conversations/$convId/read', data: {'seq': seq.toString()}));

  Future<ChatMessage> _msg(Future<Response<Map<String, dynamic>>> Function() fn) =>
      _call(() async => ChatMessage.fromJson((await fn()).data!));
}

final chatRepositoryProvider = Provider<ChatRepository>((ref) => ChatRepository(ref.watch(dioProvider)));
