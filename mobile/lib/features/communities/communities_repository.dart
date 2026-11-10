import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_error.dart';
import '../../core/http/api_client.dart';
import 'models.dart';

class DirectoryPage {
  const DirectoryPage(this.items, this.nextCursor);
  final List<CommunitySummary> items;
  final String? nextCursor;
}

/// Semua panggilan API komunitas. Galat selalu dilempar sebagai [ApiError].
class CommunitiesRepository {
  CommunitiesRepository(this._dio);
  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() fn) async {
    try {
      return await fn();
    } catch (e) {
      throw ApiError.from(e);
    }
  }

  Future<Map<String, dynamic>> _getMap(String path, [Map<String, dynamic>? query]) =>
      _call(() async => (await _dio.get<Map<String, dynamic>>(path, queryParameters: query)).data!);

  Future<MyCommunities> mine() async => MyCommunities.fromJson(await _getMap('/v1/communities/mine'));

  Future<DirectoryPage> directory({String? city, String? search, String? cursor}) async {
    final data = await _getMap('/v1/communities', {
      if (city != null && city.isNotEmpty) 'city': city,
      if (search != null && search.isNotEmpty) 'q': search,
      'cursor': ?cursor,
    });
    return DirectoryPage(
      (data['items'] as List<dynamic>).map((e) => CommunitySummary.fromJson(e as Map<String, dynamic>)).toList(),
      data['nextCursor'] as String?,
    );
  }

  Future<List<String>> cities() => _call(() async {
        final res = await _dio.get<List<dynamic>>('/v1/communities/cities');
        return res.data!.map((e) => (e as Map<String, dynamic>)['city'] as String).toList();
      });

  Future<CommunityDetail> detail(String id) async => CommunityDetail.fromJson(await _getMap('/v1/communities/$id'));

  Future<CommunityDetail> create({required String name, required String city, required String description, required CommunityVisibility visibility}) =>
      _call(() async {
        final res = await _dio.post<Map<String, dynamic>>('/v1/communities', data: {
          'name': name,
          'city': city,
          'description': description,
          'visibility': visibility.name,
        });
        return CommunityDetail.fromJson(res.data!);
      });

  Future<CommunityDetail> update(String id, Map<String, dynamic> patch) => _call(() async {
        final res = await _dio.patch<Map<String, dynamic>>('/v1/communities/$id', data: patch);
        return CommunityDetail.fromJson(res.data!);
      });

  Future<void> uploadLogo(String id, String path) => _call(() async {
        final form = FormData.fromMap({'file': await MultipartFile.fromFile(path, filename: 'logo')});
        await _dio.post<void>('/v1/communities/$id/logo', data: form);
      });

  Future<void> delete(String id) => _call(() => _dio.delete<void>('/v1/communities/$id'));

  Future<MyStatus> join(String id) => _call(() async {
        final res = await _dio.post<Map<String, dynamic>>('/v1/communities/$id/join');
        return res.data!['status'] == 'pending' ? MyStatus.pending : MyStatus.active;
      });

  Future<void> cancelRequest(String id) => _call(() => _dio.delete<void>('/v1/communities/$id/join'));
  Future<void> leave(String id) => _call(() => _dio.post<void>('/v1/communities/$id/leave'));

  Future<CommunityDetail> previewInvite(String code) => _call(() async {
        final res = await _dio.post<Map<String, dynamic>>('/v1/communities/invites/preview', data: {'code': code});
        return CommunityDetail.fromJson(res.data!);
      });

  Future<CommunityDetail> joinByCode(String code) => _call(() async {
        final res = await _dio.post<Map<String, dynamic>>('/v1/communities/join-by-code', data: {'code': code});
        return CommunityDetail.fromJson(res.data!);
      });

  Future<List<Member>> members(String id, {String status = 'active'}) => _call(() async {
        final res = await _dio.get<List<dynamic>>('/v1/communities/$id/members', queryParameters: {'status': status});
        return res.data!.map((e) => Member.fromJson(e as Map<String, dynamic>)).toList();
      });

  Future<void> approve(String id, String userId) => _call(() => _dio.post<void>('/v1/communities/$id/members/$userId/approve'));
  Future<void> reject(String id, String userId) => _call(() => _dio.post<void>('/v1/communities/$id/members/$userId/reject'));
  Future<void> removeMember(String id, String userId, {bool ban = false}) =>
      _call(() => _dio.post<void>('/v1/communities/$id/members/$userId/remove', data: {'ban': ban}));
  Future<void> unban(String id, String userId) => _call(() => _dio.post<void>('/v1/communities/$id/members/$userId/unban'));
  Future<void> setRole(String id, String userId, Role role) =>
      _call(() => _dio.post<void>('/v1/communities/$id/members/$userId/role', data: {'role': role.name}));
  Future<void> transfer(String id, String userId) => _call(() => _dio.post<void>('/v1/communities/$id/transfer', data: {'userId': userId}));

  Future<Invite> createInvite(String id, {int expiresInDays = 7, int? maxUses}) => _call(() async {
        final res = await _dio.post<Map<String, dynamic>>('/v1/communities/$id/invites',
            data: {'expiresInDays': expiresInDays, 'maxUses': ?maxUses});
        return Invite.fromJson(res.data!);
      });

  Future<List<Invite>> invites(String id) => _call(() async {
        final res = await _dio.get<List<dynamic>>('/v1/communities/$id/invites');
        return res.data!.map((e) => Invite.fromJson(e as Map<String, dynamic>)).toList();
      });

  Future<void> revokeInvite(String id, String inviteId) => _call(() => _dio.delete<void>('/v1/communities/$id/invites/$inviteId'));
}

final communitiesRepositoryProvider = Provider<CommunitiesRepository>((ref) => CommunitiesRepository(ref.watch(dioProvider)));

final myCommunitiesProvider = FutureProvider.autoDispose<MyCommunities>((ref) => ref.watch(communitiesRepositoryProvider).mine());

final communityDetailProvider =
    FutureProvider.autoDispose.family<CommunityDetail, String>((ref, id) => ref.watch(communitiesRepositoryProvider).detail(id));

final communityMembersProvider = FutureProvider.autoDispose.family<List<Member>, (String, String)>(
  (ref, arg) => ref.watch(communitiesRepositoryProvider).members(arg.$1, status: arg.$2),
);

final communityInvitesProvider =
    FutureProvider.autoDispose.family<List<Invite>, String>((ref, id) => ref.watch(communitiesRepositoryProvider).invites(id));

final citiesProvider = FutureProvider.autoDispose<List<String>>((ref) => ref.watch(communitiesRepositoryProvider).cities());

/// Muat ulang semua data komunitas setelah ada perubahan keanggotaan.
void refreshCommunity(WidgetRef ref, String id) {
  ref.invalidate(communityDetailProvider(id));
  ref.invalidate(communityMembersProvider);
  ref.invalidate(myCommunitiesProvider);
}
