import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_error.dart';
import '../../core/http/api_client.dart';
import '../runs/runs_repository.dart';

/// Visibilitas postingan, sama dengan server.
enum PostVisibility { public, community, followers }

String postVisibilityText(PostVisibility v) => switch (v) {
      PostVisibility.public => 'Semua orang',
      PostVisibility.community => 'Anggota komunitasku',
      PostVisibility.followers => 'Pengikutku',
    };

PostVisibility _vis(Object? v) => switch (v) {
      'public' => PostVisibility.public,
      'followers' => PostVisibility.followers,
      _ => PostVisibility.community,
    };

enum FeedTab { following, community, explore }

String feedTabText(FeedTab t) => switch (t) {
      FeedTab.following => 'Mengikuti',
      FeedTab.community => 'Komunitas',
      FeedTab.explore => 'Jelajah',
    };

/// Visibilitas postingan yang diizinkan untuk lari dengan [run] visibilitas tertentu.
/// Server menolak postingan yang lebih luas dari visibilitas larinya.
List<PostVisibility> allowedForRun(RunVisibility run) =>
    run == RunVisibility.public ? PostVisibility.values : const [PostVisibility.community];

class FeedAuthor {
  const FeedAuthor({required this.id, required this.displayName, required this.avatarUrl, this.badges = const []});
  final String id;
  final String displayName;
  final String? avatarUrl;

  /// Lencana di avatar (mis. premium).
  final List<String> badges;

  factory FeedAuthor.fromJson(Map<String, dynamic> j) => FeedAuthor(
        id: j['id'] as String,
        displayName: j['displayName'] as String,
        avatarUrl: j['avatarUrl'] as String?,
        badges: (j['badges'] as List<dynamic>? ?? const []).whereType<String>().toList(),
      );
}

/// Kartu hasil lari di feed. Rute selalu versi publik (setelah zona privasi), sudah diringkas server.
class FeedRun {
  const FeedRun({
    required this.id,
    required this.title,
    required this.startedAt,
    required this.distanceM,
    required this.movingTimeS,
    required this.avgPaceSPerKm,
    required this.route,
  });
  final String id;
  final String title;
  final DateTime startedAt;
  final int distanceM;
  final int movingTimeS;
  final int? avgPaceSPerKm;
  final RunRoute route;

  factory FeedRun.fromJson(Map<String, dynamic> j) => FeedRun(
        id: j['id'] as String,
        title: j['title'] as String,
        startedAt: DateTime.parse(j['startedAt'] as String).toLocal(),
        distanceM: (j['distanceM'] as num).toInt(),
        movingTimeS: (j['movingTimeS'] as num).toInt(),
        avgPaceSPerKm: (j['avgPaceSPerKm'] as num?)?.toInt(),
        route: parseRoute(j['route']),
      );
}

class FeedPost {
  const FeedPost({
    required this.id,
    required this.kind,
    required this.text,
    required this.visibility,
    required this.createdAt,
    required this.author,
    required this.isMine,
    required this.likeCount,
    required this.commentCount,
    required this.likedByMe,
    required this.photoUrls,
    required this.run,
    required this.runUnavailable,
    required this.underReview,
    required this.hidden,
  });
  final String id;
  final String kind;
  final String? text;
  final PostVisibility visibility;
  final DateTime createdAt;
  final FeedAuthor author;
  final bool isMine;
  final int likeCount;
  final int commentCount;
  final bool likedByMe;
  final List<String> photoUrls;
  final FeedRun? run;

  /// Postingan hasil lari yang larinya dihapus/dijadikan privat/tidak boleh kulihat.
  final bool runUnavailable;

  /// Hanya untuk penulis: sedang dilaporkan / disembunyikan sambil ditinjau.
  final bool underReview;
  final bool hidden;

  factory FeedPost.fromJson(Map<String, dynamic> j) => FeedPost(
        id: j['id'] as String,
        kind: j['kind'] as String? ?? 'text',
        text: j['text'] as String?,
        visibility: _vis(j['visibility']),
        createdAt: DateTime.parse(j['createdAt'] as String).toLocal(),
        author: FeedAuthor.fromJson(j['author'] as Map<String, dynamic>),
        isMine: j['isMine'] as bool? ?? false,
        likeCount: (j['likeCount'] as num?)?.toInt() ?? 0,
        commentCount: (j['commentCount'] as num?)?.toInt() ?? 0,
        likedByMe: j['likedByMe'] as bool? ?? false,
        photoUrls: (j['photos'] as List<dynamic>? ?? const []).map((p) => (p as Map<String, dynamic>)['url'] as String).toList(),
        run: j['run'] == null ? null : FeedRun.fromJson(j['run'] as Map<String, dynamic>),
        runUnavailable: j['runUnavailable'] as bool? ?? false,
        underReview: j['underReview'] as bool? ?? false,
        hidden: j['hidden'] as bool? ?? false,
      );
}

class FeedComment {
  const FeedComment({
    required this.id,
    required this.text,
    required this.createdAt,
    required this.author,
    required this.isMine,
    required this.canDelete,
    required this.hidden,
  });
  final String id;
  final String text;
  final DateTime createdAt;
  final FeedAuthor author;
  final bool isMine;
  final bool canDelete;
  final bool hidden;

  factory FeedComment.fromJson(Map<String, dynamic> j) => FeedComment(
        id: j['id'] as String,
        text: j['text'] as String? ?? '',
        createdAt: DateTime.parse(j['createdAt'] as String).toLocal(),
        author: FeedAuthor.fromJson(j['author'] as Map<String, dynamic>),
        isMine: j['isMine'] as bool? ?? false,
        canDelete: j['canDelete'] as bool? ?? false,
        hidden: j['hidden'] as bool? ?? false,
      );
}

class FeedProfile {
  const FeedProfile({
    required this.id,
    required this.displayName,
    required this.avatarUrl,
    required this.isMe,
    required this.followers,
    required this.following,
    required this.iFollow,
    required this.followsMe,
    this.badges = const [],
  });
  final String id;
  final String displayName;
  final String? avatarUrl;
  final List<String> badges;
  final bool isMe;
  final int followers;
  final int following;
  final bool iFollow;
  final bool followsMe;

  factory FeedProfile.fromJson(Map<String, dynamic> j) => FeedProfile(
        id: j['id'] as String,
        displayName: j['displayName'] as String,
        avatarUrl: j['avatarUrl'] as String?,
        badges: (j['badges'] as List<dynamic>? ?? const []).whereType<String>().toList(),
        isMe: j['isMe'] as bool? ?? false,
        followers: (j['followers'] as num?)?.toInt() ?? 0,
        following: (j['following'] as num?)?.toInt() ?? 0,
        iFollow: j['iFollow'] as bool? ?? false,
        followsMe: j['followsMe'] as bool? ?? false,
      );
}

class FeedPage<T> {
  const FeedPage(this.items, this.nextCursor);
  final List<T> items;
  final String? nextCursor;
}

/// Semua panggilan API feed. Galat dilempar sebagai [ApiError].
class FeedRepository {
  FeedRepository(this._dio);
  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() fn) async {
    try {
      return await fn();
    } catch (e) {
      throw ApiError.from(e);
    }
  }

  FeedPage<FeedPost> _posts(Map<String, dynamic> d) =>
      FeedPage((d['items'] as List<dynamic>).map((e) => FeedPost.fromJson(e as Map<String, dynamic>)).toList(), d['nextCursor'] as String?);

  Future<FeedPage<FeedPost>> list(FeedTab tab, {String? cursor}) => _call(() async {
        final res = await _dio.get<Map<String, dynamic>>('/v1/feed', queryParameters: {'tab': tab.name, 'cursor': ?cursor});
        return _posts(res.data!);
      });

  Future<FeedPage<FeedPost>> userPosts(String userId, {String? cursor}) => _call(() async {
        final res = await _dio.get<Map<String, dynamic>>('/v1/feed/users/$userId/posts', queryParameters: {'cursor': ?cursor});
        return _posts(res.data!);
      });

  Future<FeedPost> post(String id) => _call(() async => FeedPost.fromJson((await _dio.get<Map<String, dynamic>>('/v1/feed/posts/$id')).data!));

  /// Buat postingan. Foto dikirim sebagai multipart (maks. 4); data teks ada di field `data` (bukan URL).
  Future<FeedPost> create({String? text, required PostVisibility visibility, String? runId, List<String> photoPaths = const []}) => _call(() async {
        final data = {'text': ?((text?.trim().isEmpty ?? true) ? null : text!.trim()), 'visibility': visibility.name, 'runId': ?runId};
        final Object body = photoPaths.isEmpty
            ? data
            : FormData.fromMap({
                'data': jsonEncode(data),
                'photos': [for (final p in photoPaths) await MultipartFile.fromFile(p, filename: 'photo')],
              });
        return FeedPost.fromJson((await _dio.post<Map<String, dynamic>>('/v1/feed/posts', data: body)).data!);
      });

  Future<void> delete(String id) => _call(() => _dio.delete<void>('/v1/feed/posts/$id'));

  Future<FeedPost> setLike(String id, {required bool like}) => _call(() async {
        final res = like ? await _dio.post<Map<String, dynamic>>('/v1/feed/posts/$id/like') : await _dio.delete<Map<String, dynamic>>('/v1/feed/posts/$id/like');
        return FeedPost.fromJson(res.data!);
      });

  Future<FeedPage<FeedComment>> comments(String postId, {String? cursor}) => _call(() async {
        final res = await _dio.get<Map<String, dynamic>>('/v1/feed/posts/$postId/comments', queryParameters: {'cursor': ?cursor});
        final d = res.data!;
        return FeedPage((d['items'] as List<dynamic>).map((e) => FeedComment.fromJson(e as Map<String, dynamic>)).toList(), d['nextCursor'] as String?);
      });

  Future<FeedComment> addComment(String postId, String text) => _call(() async =>
      FeedComment.fromJson((await _dio.post<Map<String, dynamic>>('/v1/feed/posts/$postId/comments', data: {'text': text.trim()})).data!));

  Future<void> deleteComment(String id) => _call(() => _dio.delete<void>('/v1/feed/comments/$id'));

  Future<FeedProfile> profile(String userId) =>
      _call(() async => FeedProfile.fromJson((await _dio.get<Map<String, dynamic>>('/v1/feed/users/$userId')).data!));

  Future<void> setFollow(String userId, {required bool follow}) =>
      _call(() => follow ? _dio.post<void>('/v1/feed/users/$userId/follow') : _dio.delete<void>('/v1/feed/users/$userId/follow'));

  Future<void> setBlock(String userId, {required bool block}) =>
      _call(() => block ? _dio.post<void>('/v1/feed/users/$userId/block') : _dio.delete<void>('/v1/feed/users/$userId/block'));

  /// [which]: followers, following, blocks.
  Future<List<FeedAuthor>> connections(String which) => _call(() async {
        final res = await _dio.get<Map<String, dynamic>>('/v1/feed/me/$which');
        return (res.data!['items'] as List<dynamic>)
            .map((e) => e as Map<String, dynamic>)
            .map((j) => FeedAuthor(id: j['id'] as String, displayName: j['displayName'] as String, avatarUrl: j['avatarUrl'] as String?))
            .toList();
      });

  Future<void> removeFollower(String userId) => _call(() => _dio.delete<void>('/v1/feed/me/followers/$userId'));
}

final feedRepositoryProvider = Provider<FeedRepository>((ref) => FeedRepository(ref.watch(dioProvider)));

final feedPostProvider = FutureProvider.autoDispose.family<FeedPost, String>((ref, id) => ref.watch(feedRepositoryProvider).post(id));

final feedProfileProvider = FutureProvider.autoDispose.family<FeedProfile, String>((ref, id) => ref.watch(feedRepositoryProvider).profile(id));

final feedConnectionsProvider =
    FutureProvider.autoDispose.family<List<FeedAuthor>, String>((ref, which) => ref.watch(feedRepositoryProvider).connections(which));
