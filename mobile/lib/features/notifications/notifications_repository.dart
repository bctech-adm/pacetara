import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_error.dart';
import '../../core/http/api_client.dart';
import '../auth/auth_controller.dart';
import '../chat/chat_room.dart';
import '../communities/models.dart';

class AppNotification {
  const AppNotification({
    required this.id,
    required this.type,
    required this.createdAt,
    required this.read,
    this.actorId,
    this.actorName,
    this.actorAvatarUrl,
    this.communityId,
    this.communityName,
    this.data = const {},
  });

  final String id;

  /// community_invite | join_request | join_approved | run_invite
  final String type;
  final DateTime createdAt;
  final bool read;
  final String? actorId;
  final String? actorName;
  final String? actorAvatarUrl;
  final String? communityId;
  final String? communityName;
  final Map<String, String> data;

  factory AppNotification.fromJson(Map<String, dynamic> j) {
    final actor = j['actor'] as Map<String, dynamic>?;
    final community = j['community'] as Map<String, dynamic>?;
    return AppNotification(
      id: j['id'] as String,
      type: j['type'] as String,
      createdAt: DateTime.parse(j['createdAt'] as String),
      read: j['read'] as bool? ?? false,
      actorId: actor?['id'] as String?,
      actorName: actor?['displayName'] as String?,
      actorAvatarUrl: actor?['avatarUrl'] as String?,
      communityId: community?['id'] as String?,
      communityName: community?['name'] as String?,
      data: (j['data'] as Map<String, dynamic>? ?? const {}).map((k, v) => MapEntry(k, '$v')),
    );
  }

  /// Kalimat untuk daftar notifikasi.
  String get text {
    final who = actorName ?? 'Seseorang';
    final where = communityName ?? 'komunitas';
    return switch (type) {
      'community_invite' => '$who mengundangmu ke $where',
      'join_request' => '$who ingin bergabung ke $where',
      'join_approved' => 'Permintaanmu bergabung ke $where diterima',
      'run_invite' => communityName == null ? '$who mengajakmu lari bareng' : '$who mengajak lari bareng di $where',
      'new_follower' => '$who mulai mengikutimu',
      'post_like' => '$who menyukai postinganmu',
      'post_comment' => '$who mengomentari postinganmu',
      'badge_earned' => 'Kamu mendapat lencana baru',
      _ => 'Notifikasi baru',
    };
  }

  /// Tujuan saat diketuk (rute go_router), atau null.
  String? get route => switch (type) {
        'run_invite' => data['conversationId'] == null ? null : '/chat/${data['conversationId']}',
        'join_request' || 'join_approved' => communityId == null ? null : '/communities/$communityId',
        'post_like' || 'post_comment' => data['postId'] == null ? null : '/feed/posts/${data['postId']}',
        'new_follower' => data['userId'] == null ? null : '/feed/users/${data['userId']}',
        'badge_earned' => '/passport',
        _ => null,
      };
}

class NotificationPage {
  const NotificationPage(this.items, this.unread);
  final List<AppNotification> items;
  final int unread;
}

class Invitation {
  const Invitation({required this.id, required this.community, required this.invitedBy, required this.createdAt});
  final String id;
  final CommunitySummary community;
  final String? invitedBy;
  final DateTime createdAt;

  factory Invitation.fromJson(Map<String, dynamic> j) => Invitation(
        id: j['id'] as String,
        community: CommunitySummary.fromJson(j['community'] as Map<String, dynamic>),
        invitedBy: (j['invitedBy'] as Map<String, dynamic>?)?['displayName'] as String?,
        createdAt: DateTime.parse(j['createdAt'] as String),
      );
}

class InviteCandidate {
  const InviteCandidate({required this.id, required this.displayName, required this.avatarUrl, required this.invited});
  final String id;
  final String displayName;
  final String? avatarUrl;
  final bool invited;

  factory InviteCandidate.fromJson(Map<String, dynamic> j) => InviteCandidate(
        id: j['id'] as String,
        displayName: j['displayName'] as String,
        avatarUrl: j['avatarUrl'] as String?,
        invited: j['invited'] as bool? ?? false,
      );
}

/// Kategori pengaturan push, sama dengan server (NOTIF_CATEGORIES).
const notificationCategories = <String, (String, String)>{
  'chat': ('Pesan baru', 'Chat pribadi dan chat komunitas'),
  'community': ('Komunitas', 'Undangan, permintaan bergabung, dan persetujuan'),
  'run_invite': ('Ajakan lari bareng', 'Saat ada yang mengajak lari di chat'),
  'friend_running': ('Teman mulai lari', 'Saat anggota komunitasmu menyalakan status lari'),
  'social': ('Feed', 'Pengikut baru, suka, dan komentar di postinganmu'),
  'achievement': ('Lencana', 'Saat kamu mendapat lencana pencapaian baru'),
};

class NotificationsRepository {
  NotificationsRepository(this._dio);
  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() fn) async {
    try {
      return await fn();
    } catch (e) {
      throw ApiError.from(e);
    }
  }

  Future<NotificationPage> list() => _call(() async {
        final data = (await _dio.get<Map<String, dynamic>>('/v1/notifications')).data!;
        return NotificationPage(
          (data['items'] as List<dynamic>).map((e) => AppNotification.fromJson(e as Map<String, dynamic>)).toList(),
          (data['unread'] as num?)?.toInt() ?? 0,
        );
      });

  Future<void> markAllRead() => _call(() => _dio.post<void>('/v1/notifications/read'));

  Future<Map<String, bool>> settings() => _call(() async {
        final data = (await _dio.get<Map<String, dynamic>>('/v1/me/notification-settings')).data!;
        return data.map((k, v) => MapEntry(k, v as bool));
      });

  Future<Map<String, bool>> updateSettings(Map<String, bool> patch) => _call(() async {
        final data = (await _dio.put<Map<String, dynamic>>('/v1/me/notification-settings', data: patch)).data!;
        return data.map((k, v) => MapEntry(k, v as bool));
      });

  Future<void> registerPushToken(String token) => _call(() => _dio.put<void>('/v1/me/push-token', data: {'token': token}));

  Future<List<Invitation>> invitations() => _call(() async {
        final res = await _dio.get<List<dynamic>>('/v1/invitations');
        return res.data!.map((e) => Invitation.fromJson(e as Map<String, dynamic>)).toList();
      });

  Future<void> respond(String invitationId, {required bool accept}) =>
      _call(() => _dio.post<void>('/v1/invitations/$invitationId/${accept ? 'accept' : 'decline'}'));

  Future<List<InviteCandidate>> candidates(String communityId) => _call(() async {
        final res = await _dio.get<List<dynamic>>('/v1/communities/$communityId/invite-candidates');
        return res.data!.map((e) => InviteCandidate.fromJson(e as Map<String, dynamic>)).toList();
      });

  Future<void> invite(String communityId, String userId) =>
      _call(() => _dio.post<void>('/v1/communities/$communityId/invitations', data: {'userId': userId}));
}

final notificationsRepositoryProvider = Provider<NotificationsRepository>((ref) => NotificationsRepository(ref.watch(dioProvider)));

/// Kotak notifikasi: dimuat ulang saat ada sinyal `user:<id>:notif`, cadangan polling 2 menit.
final notificationsProvider = StreamProvider.autoDispose<NotificationPage>((ref) {
  final me = ref.watch(authControllerProvider.select((a) => a.value?.id));
  final repo = ref.watch(notificationsRepositoryProvider);
  final out = StreamController<NotificationPage>();
  Future<void> load() async {
    try {
      final page = await repo.list();
      if (!out.isClosed) out.add(page);
    } catch (e, st) {
      if (!out.isClosed) out.addError(e, st);
    }
  }

  final sub = me == null ? null : ref.read(chatEventsProvider)('user:$me:notif').listen((_) => unawaited(load()));
  final poll = Timer.periodic(const Duration(minutes: 2), (_) => unawaited(load()));
  unawaited(load());
  ref.onDispose(() {
    poll.cancel();
    unawaited(sub?.cancel());
    unawaited(out.close());
  });
  return out.stream;
});

final unreadNotificationsProvider = Provider.autoDispose<int>((ref) => ref.watch(notificationsProvider).value?.unread ?? 0);

final invitationsProvider = FutureProvider.autoDispose<List<Invitation>>((ref) {
  // Undangan baru datang bersama notifikasi; muat ulang saat kotak notifikasi berubah.
  ref.watch(notificationsProvider);
  return ref.watch(notificationsRepositoryProvider).invitations();
});

final notificationSettingsProvider = FutureProvider.autoDispose<Map<String, bool>>((ref) => ref.watch(notificationsRepositoryProvider).settings());

final inviteCandidatesProvider =
    FutureProvider.autoDispose.family<List<InviteCandidate>, String>((ref, id) => ref.watch(notificationsRepositoryProvider).candidates(id));

/// Rute tujuan saat push diketuk, dari `data` FCM. Null = cukup buka aplikasi.
String? routeForPush(Map<String, dynamic> data) {
  final conv = data['conversationId'];
  final community = data['communityId'];
  return switch (data['type']) {
    'chat' || 'run_invite' when conv is String => '/chat/$conv',
    'community_invite' => '/notifications',
    'join_request' || 'join_approved' || 'friend_running' when community is String => '/communities/$community',
    'post_like' || 'post_comment' when data['postId'] is String => '/feed/posts/${data['postId']}',
    'new_follower' when data['userId'] is String => '/feed/users/${data['userId']}',
    'badge_earned' => '/passport',
    _ => null,
  };
}
