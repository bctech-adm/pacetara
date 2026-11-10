import 'package:flutter_test/flutter_test.dart';
import 'package:pacetara/features/communities/models.dart';
import 'package:pacetara/features/communities/screens/join_by_code_screen.dart';

Map<String, dynamic> communityJson({String myStatus = 'none', String? myRole, List<String> badges = const []}) => {
      'id': 'c1',
      'name': 'Bandung Runners',
      'city': 'Bandung',
      'visibility': 'private',
      'memberCount': 3,
      'logoUrl': null,
      'badges': badges,
      'myStatus': myStatus,
      'myRole': myRole,
      'ownerId': 'u1',
      'description': 'Lari pagi',
      'memberLimit': {'limit': 3, 'used': 3, 'reached': true},
      'multiAdmin': false,
    };

void main() {
  test('CommunityDetail.fromJson membaca batas dan status', () {
    final d = CommunityDetail.fromJson(communityJson(myStatus: 'active', myRole: 'owner'));
    expect(d.summary.visibility, CommunityVisibility.private);
    expect(d.summary.isStaff, isTrue);
    expect(d.memberLimit.reached, isTrue);
    expect(d.memberLimit.label(), '3/3');
    expect(d.newMembersSeeHistory, isNull); // pengaturan hanya dikirim ke admin
  });

  test('anggota biasa bukan staf; lencana Pro terbaca', () {
    final s = CommunitySummary.fromJson(communityJson(myStatus: 'active', myRole: 'member', badges: ['pro']));
    expect(s.isStaff, isFalse);
    expect(s.isPro, isTrue);
  });

  test('batas tanpa angka (Pro Unlimited/Premium)', () {
    final l = LimitInfo.fromJson({'limit': null, 'used': 120, 'reached': false});
    expect(l.label(), '120');
  });

  group('extractCode', () {
    test('kode langsung, huruf kecil diterima', () {
      expect(extractInviteCode('abcd2345'), 'ABCD2345');
    });
    test('dari tautan undangan', () {
      expect(extractInviteCode('https://pace.bimacreative.tech/j/KMNP2345'), 'KMNP2345');
    });
    test('menolak masukan yang bukan kode', () {
      expect(extractInviteCode('abc'), isNull);
    });
  });
}
