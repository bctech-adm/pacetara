import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pacetara/core/http/api_client.dart';
import 'package:pacetara/features/market/market_repository.dart';
import 'package:pacetara/features/market/market_screens.dart';
import 'package:pacetara/features/moderation/moderation.dart';
import 'package:pacetara/features/notifications/notifications_repository.dart';

Map<String, dynamic> listingJson({String id = 'l1', String model = 'split', bool canBuy = true}) => {
      'id': id,
      'model': model,
      'title': 'Sepatu lari 42',
      'category': 'shoes',
      'condition': 'used',
      'price': 450000,
      'city': 'Bandung',
      'stock': 2,
      'status': 'active',
      'activeUntil': '2026-12-12T00:00:00.000Z',
      'boosted': true,
      'photos': <String>[],
      'seller': {'id': 's1', 'displayName': 'Toko Lari', 'verified': true},
      'createdAt': '2026-11-12T00:00:00.000Z',
      'description': 'Ukuran 42, sol masih tebal',
      'mine': false,
      'canBuy': canBuy,
    };

final configJson = {
  'policyVersion': '2026-11-12',
  'policyUrl': 'https://pace.bimacreative.tech/kebijakan-transaksi',
  'policyAccepted': false,
  'level': 1,
  'splitEnabled': true,
  'fee': {'percent': 5, 'flat': 0},
};

Dio fakeDio(List<RequestOptions> seen) => Dio()
  ..interceptors.add(InterceptorsWrapper(onRequest: (o, h) {
    seen.add(o);
    final Object? data = switch ((o.method, o.path)) {
      ('POST', '/v1/market/listings/search') => {'items': [listingJson()], 'nextOffset': null},
      ('GET', '/v1/market/listings/l1') => listingJson(),
      ('GET', '/v1/market/config') => configJson,
      ('POST', '/v1/market/policy') => {'accepted': true, 'version': '2026-11-12'},
      ('POST', '/v1/market/listings/l1/contact') => {'id': 'c1'},
      _ => null,
    };
    if (data == null) return h.reject(DioException(requestOptions: o, response: Response(requestOptions: o, statusCode: 404)));
    h.resolve(Response(requestOptions: o, statusCode: 200, data: data));
  }));

Widget host(List<RequestOptions> seen, Widget child) => ProviderScope(
      overrides: [dioProvider.overrideWithValue(fakeDio(seen))],
      child: MaterialApp(home: child),
    );

void main() {
  test('model listing, pesanan, dan format rupiah', () {
    final l = Listing.fromJson(listingJson());
    expect(l.canBuy, isTrue);
    expect(l.sellerVerified, isTrue);
    expect(l.modelLabel, 'Bayar di aplikasi');
    expect(rupiah(450000), 'Rp450.000');
    expect(rupiah(1000), 'Rp1.000');
    expect(rupiah(999), 'Rp999');
    final o = MarketOrder.fromJson({
      'id': 'o1',
      'title': 'Sepatu',
      'qty': 1,
      'amount': 200000,
      'fee': 10000,
      'sellerReceives': 190000,
      'status': 'paid',
      'role': 'seller',
      'counterpart': {'id': null, 'displayName': 'Pengguna dihapus'},
      'createdAt': '2026-11-12T00:00:00.000Z',
    });
    expect(o.statusLabel, 'Dibayar, menunggu dikirim');
    expect(o.sellerReceives, 190000);
    expect(ReportTarget.listing.name, 'listing');
  });

  test('notifikasi marketplace', () {
    expect(routeForPush({'type': 'market_order_paid', 'orderId': 'o1'}), '/market/orders/o1');
    expect(routeForPush({'type': 'market_seller_live'}), '/market/seller');
    expect(notificationCategories.keys, contains('market'));
  });

  testWidgets('daftar marketplace: pencarian lewat body, bukan URL', (tester) async {
    final seen = <RequestOptions>[];
    await tester.pumpWidget(host(seen, const MarketScreen()));
    await tester.pumpAndSettle();
    expect(find.text('Sepatu lari 42'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('market-search')), 'sepatu');
    await tester.testTextInput.receiveAction(TextInputAction.search);
    await tester.pumpAndSettle();
    final search = seen.lastWhere((o) => o.path == '/v1/market/listings/search');
    expect(search.uri.query, isEmpty);
    expect((search.data as Map)['q'], 'sepatu');
  });

  testWidgets('detail: tombol beli, hubungi penjual, dan lapor', (tester) async {
    final seen = <RequestOptions>[];
    await tester.pumpWidget(host(seen, const ListingDetailScreen(id: 'l1')));
    await tester.pumpAndSettle();
    expect(find.text('Rp450.000'), findsOneWidget);
    expect(find.text('Penjual Terverifikasi (KTP)'), findsOneWidget);
    expect(find.byKey(const Key('market-buy')), findsOneWidget);
    expect(find.byKey(const Key('market-contact')), findsOneWidget);
    expect(find.byTooltip('Laporkan'), findsOneWidget);
  });

  testWidgets('kebijakan transaksi: setuju hanya setelah dicentang, versi dikirim', (tester) async {
    final seen = <RequestOptions>[];
    await tester.pumpWidget(host(seen, MarketPolicyScreen(config: MarketConfig.fromJson(configJson))));
    await tester.pumpAndSettle();
    final accept = find.byKey(const Key('market-policy-accept'));
    await tester.scrollUntilVisible(accept, 200, scrollable: find.byType(Scrollable).first);
    // Tombol masih nonaktif: ketukan sengaja tidak berefek.
    await tester.tap(accept, warnIfMissed: false);
    await tester.pump();
    expect(seen.where((o) => o.path == '/v1/market/policy'), isEmpty);
    await tester.ensureVisible(find.byKey(const Key('market-policy-agree')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('market-policy-agree')));
    await tester.pump();
    await tester.ensureVisible(accept);
    await tester.pumpAndSettle();
    await tester.tap(accept);
    await tester.pumpAndSettle();
    expect((seen.lastWhere((o) => o.path == '/v1/market/policy').data as Map)['version'], '2026-11-12');
  });
}
