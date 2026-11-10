enum CommunityVisibility { open, private }

enum MyStatus { none, active, pending, banned }

enum Role { owner, admin, member }

CommunityVisibility _visibility(Object? v) => v == 'private' ? CommunityVisibility.private : CommunityVisibility.open;

MyStatus _myStatus(Object? v) => switch (v) {
      'active' => MyStatus.active,
      'pending' => MyStatus.pending,
      'banned' => MyStatus.banned,
      _ => MyStatus.none,
    };

Role? _role(Object? v) => switch (v) {
      'owner' => Role.owner,
      'admin' => Role.admin,
      'member' => Role.member,
      _ => null,
    };

class LimitInfo {
  const LimitInfo({required this.limit, required this.used, required this.reached});
  final int? limit;
  final int used;
  final bool reached;

  factory LimitInfo.fromJson(Map<String, dynamic> j) => LimitInfo(
        limit: (j['limit'] as num?)?.toInt(),
        used: (j['used'] as num?)?.toInt() ?? 0,
        reached: j['reached'] as bool? ?? false,
      );

  String label() => limit == null ? '$used' : '$used/$limit';
}

class CommunitySummary {
  const CommunitySummary({
    required this.id,
    required this.name,
    required this.city,
    required this.visibility,
    required this.memberCount,
    required this.logoUrl,
    required this.isPro,
    required this.myStatus,
    required this.myRole,
  });

  final String id;
  final String name;
  final String city;
  final CommunityVisibility visibility;
  final int memberCount;
  final String? logoUrl;
  final bool isPro;
  final MyStatus myStatus;
  final Role? myRole;

  bool get isStaff => myStatus == MyStatus.active && (myRole == Role.owner || myRole == Role.admin);

  factory CommunitySummary.fromJson(Map<String, dynamic> j) => CommunitySummary(
        id: j['id'] as String,
        name: j['name'] as String,
        city: j['city'] as String,
        visibility: _visibility(j['visibility']),
        memberCount: (j['memberCount'] as num).toInt(),
        logoUrl: j['logoUrl'] as String?,
        isPro: (j['badges'] as List<dynamic>? ?? const []).contains('pro'),
        myStatus: _myStatus(j['myStatus']),
        myRole: _role(j['myRole']),
      );
}

class CommunityDetail {
  const CommunityDetail({
    required this.summary,
    required this.description,
    required this.memberLimit,
    required this.multiAdmin,
    required this.newMembersSeeHistory,
    required this.pendingCount,
  });

  final CommunitySummary summary;
  final String description;
  final LimitInfo memberLimit;
  final bool multiAdmin;

  /// Hanya terisi untuk admin.
  final bool? newMembersSeeHistory;
  final int? pendingCount;

  factory CommunityDetail.fromJson(Map<String, dynamic> j) {
    final settings = j['settings'] as Map<String, dynamic>?;
    return CommunityDetail(
      summary: CommunitySummary.fromJson(j),
      description: j['description'] as String? ?? '',
      memberLimit: LimitInfo.fromJson(j['memberLimit'] as Map<String, dynamic>),
      multiAdmin: j['multiAdmin'] as bool? ?? false,
      newMembersSeeHistory: settings?['newMembersSeeHistory'] as bool?,
      pendingCount: (j['pendingCount'] as num?)?.toInt(),
    );
  }
}

class Member {
  const Member({required this.userId, required this.displayName, required this.avatarUrl, required this.city, required this.role});
  final String userId;
  final String displayName;
  final String? avatarUrl;
  final String? city;
  final Role role;

  factory Member.fromJson(Map<String, dynamic> j) => Member(
        userId: j['userId'] as String,
        displayName: j['displayName'] as String,
        avatarUrl: j['avatarUrl'] as String?,
        city: j['city'] as String?,
        role: _role(j['role']) ?? Role.member,
      );
}

class Invite {
  const Invite({required this.id, required this.code, required this.url, required this.expiresAt, required this.maxUses, required this.uses});
  final String id;
  final String code;
  final String url;
  final DateTime expiresAt;
  final int? maxUses;
  final int uses;

  factory Invite.fromJson(Map<String, dynamic> j) => Invite(
        id: j['id'] as String,
        code: j['code'] as String,
        url: j['url'] as String,
        expiresAt: DateTime.parse(j['expiresAt'] as String).toLocal(),
        maxUses: (j['maxUses'] as num?)?.toInt(),
        uses: (j['uses'] as num?)?.toInt() ?? 0,
      );
}

class MyCommunities {
  const MyCommunities({required this.items, required this.joined, required this.ownedFree});
  final List<CommunitySummary> items;
  final LimitInfo joined;
  final LimitInfo ownedFree;

  factory MyCommunities.fromJson(Map<String, dynamic> j) {
    final limits = j['limits'] as Map<String, dynamic>;
    return MyCommunities(
      items: (j['items'] as List<dynamic>).map((e) => CommunitySummary.fromJson(e as Map<String, dynamic>)).toList(),
      joined: LimitInfo.fromJson(limits['joined'] as Map<String, dynamic>),
      ownedFree: LimitInfo.fromJson(limits['ownedFreeCommunities'] as Map<String, dynamic>),
    );
  }
}

String visibilityLabel(CommunityVisibility v) => v == CommunityVisibility.open ? 'Terbuka' : 'Privat';

String roleLabel(Role r) => switch (r) {
      Role.owner => 'Pemilik',
      Role.admin => 'Admin',
      Role.member => 'Anggota',
    };
