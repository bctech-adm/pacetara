import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pacetara/core/api/api_error.dart';
import 'package:pacetara/features/communities/widgets.dart';
import 'package:pacetara/features/subscriptions/subscription_screens.dart';
import 'package:pacetara/features/subscriptions/subscriptions_repository.dart';
import 'package:pacetara/features/subscriptions/upgrade.dart';

void main() {
  test('ajakan upgrade: batas Premium ke layar Premium, batas komunitas hanya untuk pemiliknya', () {
    for (final k in ['user_join', 'run_history', 'medals', 'full_stats']) {
      expect(upgradeRoute(k), '/subscription');
      expect(upgradeLabel(k), 'Lihat Premium');
    }
    expect(upgradeRoute('community_members', ownedCommunityId: 'c1'), '/subscription/community/c1');
    expect(upgradeRoute('multi_admin', ownedCommunityId: 'c1'), '/subscription/community/c1');
    // Bukan pemilik (mis. ingin bergabung ke komunitas penuh): tidak ditawari membayar komunitas orang lain.
    expect(upgradeRoute('community_members'), isNull);
    expect(upgradeRoute('owned_communities'), '/subscription');
    expect(upgradeLabel('owned_communities'), 'Lihat Komunitas Pro');
    expect(upgradeRoute(null), '/subscription');
  });

  test('ApiError membaca limit.kind dari 403 limit_reached', () {
    final req = RequestOptions(path: '/v1/communities/x/join');
    final err = ApiError.from(DioException(
      requestOptions: req,
      response: Response(requestOptions: req, statusCode: 403, data: {
        'error': 'limit_reached',
        'message': 'Akun gratis bisa bergabung ke maksimal 3 komunitas',
        'limit': {'kind': 'user_join', 'max': 3},
      }),
    ));
    expect(err.code, 'limit_reached');
    expect(err.limitKind, 'user_join');
  });

  test('status langganan dari server diurai; harga tidak pernah dari server', () {
    final s = SubscriptionStatus.fromJson({
      'enabled': true,
      'products': {'premium': 'p1', 'pro': 'p2', 'proUnlimited': 'p3'},
      'premium': {
        'plan': 'premium',
        'subscription': {
          'productId': 'p1',
          'kind': 'premium',
          'state': 'IN_GRACE_PERIOD',
          'active': true,
          'expiresAt': '2026-12-12T00:00:00.000Z',
          'autoRenewing': true,
          'purchasedByMe': true,
          'paymentIssue': true,
          'pending': false,
        },
        'grantExpiresAt': null,
      },
      'communities': [
        {
          'id': 'c1',
          'name': 'Lari Pagi',
          'plan': 'pro',
          'isOwner': true,
          'memberLimit': {'limit': 30, 'used': 12, 'reached': false},
          'subscription': null,
          'grantExpiresAt': '2026-11-20T00:00:00.000Z',
        },
      ],
    });
    expect(s.productIds, {'p1', 'p2', 'p3'});
    expect(s.plan, 'premium');
    expect(s.premium!.paymentIssue, isTrue);
    expect(subStatusText(s.premium!), startsWith('Pembayaran gagal'));
    expect(s.communities.single.memberLimit, 30);
    expect(s.communities.single.grantExpiresAt, isNotNull);
    expect(planLabel('pro_unlimited'), 'Komunitas Pro Unlimited');
  });

  testWidgets('dialog batas menampilkan tombol upgrade yang sesuai', (tester) async {
    late BuildContext ctx;
    await tester.pumpWidget(MaterialApp(home: Builder(builder: (c) {
      ctx = c;
      return const SizedBox();
    })));

    showLimitDialog(ctx, 'Rak medali penuh', kind: 'medals');
    await tester.pumpAndSettle();
    expect(find.text('Lihat Premium'), findsOneWidget);
    await tester.tap(find.text('Tutup'));
    await tester.pumpAndSettle();

    showLimitDialog(ctx, 'Komunitas ini penuh', kind: 'community_members');
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('limit-upgrade')), findsNothing);
    expect(find.text('Mengerti'), findsOneWidget);
  });

  testWidgets('nama dengan lencana Premium', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: NameWithBadges(name: 'Ani', badges: ['premium']))));
    expect(find.byKey(const Key('premium-badge')), findsOneWidget);
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: NameWithBadges(name: 'Budi', badges: []))));
    expect(find.byKey(const Key('premium-badge')), findsNothing);
  });
}
