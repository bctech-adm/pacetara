import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_error.dart';
import '../../core/http/api_client.dart';

const marketCategories = <String, String>{
  'shoes': 'Sepatu',
  'apparel': 'Pakaian',
  'watch': 'Jam & gawai',
  'accessory': 'Aksesori',
  'nutrition': 'Nutrisi',
  'equipment': 'Perlengkapan',
  'other': 'Lainnya',
};
const marketConditions = <String, String>{'new': 'Baru', 'like_new': 'Seperti baru', 'used': 'Bekas'};

String rupiah(int n) {
  final s = n.toString();
  final b = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) b.write('.');
    b.write(s[i]);
  }
  return 'Rp$b';
}

class MarketConfig {
  const MarketConfig({required this.policyVersion, required this.policyUrl, required this.policyAccepted, required this.level, required this.splitEnabled, required this.feePercent});
  final String policyVersion;
  final String policyUrl;
  final bool policyAccepted;
  final int level;
  final bool splitEnabled;
  final num feePercent;

  factory MarketConfig.fromJson(Map<String, dynamic> j) => MarketConfig(
        policyVersion: j['policyVersion'] as String,
        policyUrl: j['policyUrl'] as String,
        policyAccepted: j['policyAccepted'] as bool? ?? false,
        level: (j['level'] as num?)?.toInt() ?? 0,
        splitEnabled: j['splitEnabled'] as bool? ?? false,
        feePercent: (j['fee'] as Map<String, dynamic>?)?['percent'] as num? ?? 0,
      );
}

class Listing {
  const Listing({
    required this.id,
    required this.model,
    required this.title,
    required this.category,
    required this.condition,
    required this.price,
    required this.city,
    required this.status,
    required this.photos,
    required this.sellerId,
    required this.sellerName,
    required this.sellerVerified,
    this.stock,
    this.boosted = false,
    this.description = '',
    this.mine = false,
    this.canBuy = false,
    this.hidden = false,
    this.clicks,
    this.activeUntil,
  });
  final String id;
  final String model;
  final String title;
  final String category;
  final String condition;
  final int price;
  final String city;
  final String status;
  final List<String> photos;
  final String sellerId;
  final String sellerName;
  final bool sellerVerified;
  final int? stock;
  final bool boosted;
  final String description;
  final bool mine;
  final bool canBuy;
  final bool hidden;
  final int? clicks;
  final DateTime? activeUntil;

  factory Listing.fromJson(Map<String, dynamic> j) {
    final seller = j['seller'] as Map<String, dynamic>;
    return Listing(
      id: j['id'] as String,
      model: j['model'] as String,
      title: j['title'] as String,
      category: j['category'] as String,
      condition: j['condition'] as String,
      price: (j['price'] as num).toInt(),
      city: j['city'] as String,
      status: j['status'] as String,
      photos: (j['photos'] as List<dynamic>? ?? const []).cast<String>(),
      sellerId: seller['id'] as String,
      sellerName: seller['displayName'] as String,
      sellerVerified: seller['verified'] as bool? ?? false,
      stock: (j['stock'] as num?)?.toInt(),
      boosted: j['boosted'] as bool? ?? false,
      description: j['description'] as String? ?? '',
      mine: j['mine'] as bool? ?? false,
      canBuy: j['canBuy'] as bool? ?? false,
      hidden: j['hidden'] as bool? ?? false,
      clicks: (j['clicks'] as num?)?.toInt(),
      activeUntil: j['activeUntil'] == null ? null : DateTime.parse(j['activeUntil'] as String),
    );
  }

  String get statusLabel => switch (status) {
        'pending_payment' => 'Menunggu pembayaran biaya pasang',
        'active' => hidden ? 'Disembunyikan sambil ditinjau' : 'Tayang',
        'sold' => 'Terjual',
        'expired' => 'Masa tayang habis',
        'closed' => 'Ditutup',
        _ => status,
      };

  String get modelLabel => switch (model) {
        'affiliate' => 'Toko online',
        'split' => 'Bayar di aplikasi',
        _ => 'Hubungi penjual',
      };
}

class MarketOrder {
  const MarketOrder({
    required this.id,
    required this.title,
    required this.qty,
    required this.amount,
    required this.status,
    required this.role,
    required this.counterpartName,
    this.counterpartId,
    this.listingId,
    this.fee,
    this.sellerReceives,
    this.invoiceUrl,
    this.trackingNote,
    this.resolutionNote,
    required this.createdAt,
  });
  final String id;
  final String title;
  final int qty;
  final int amount;
  final String status;
  final String role;
  final String counterpartName;
  final String? counterpartId;
  final String? listingId;
  final int? fee;
  final int? sellerReceives;
  final String? invoiceUrl;
  final String? trackingNote;
  final String? resolutionNote;
  final DateTime createdAt;

  factory MarketOrder.fromJson(Map<String, dynamic> j) {
    final c = j['counterpart'] as Map<String, dynamic>? ?? const {};
    return MarketOrder(
      id: j['id'] as String,
      title: j['title'] as String,
      qty: (j['qty'] as num).toInt(),
      amount: (j['amount'] as num).toInt(),
      status: j['status'] as String,
      role: j['role'] as String? ?? 'buyer',
      counterpartName: c['displayName'] as String? ?? 'Pengguna dihapus',
      counterpartId: c['id'] as String?,
      listingId: j['listingId'] as String?,
      fee: (j['fee'] as num?)?.toInt(),
      sellerReceives: (j['sellerReceives'] as num?)?.toInt(),
      invoiceUrl: j['invoiceUrl'] as String?,
      trackingNote: j['trackingNote'] as String?,
      resolutionNote: j['resolutionNote'] as String?,
      createdAt: DateTime.parse(j['createdAt'] as String),
    );
  }

  String get statusLabel => switch (status) {
        'pending' => 'Menunggu pembayaran',
        'paid' => 'Dibayar, menunggu dikirim',
        'shipped' => 'Dikirim',
        'completed' => 'Selesai',
        'cancelled' => 'Dibatalkan',
        'expired' => 'Kedaluwarsa',
        'disputed' => 'Sengketa ditinjau tim PaceTara',
        'refunded' => 'Dikembalikan',
        _ => status,
      };
}

class SellerStatus {
  const SellerStatus(this.enabled, this.status, this.suspendedReason);
  final bool enabled;
  final String? status;
  final String? suspendedReason;
  factory SellerStatus.fromJson(Map<String, dynamic> j) => SellerStatus(j['enabled'] as bool? ?? false, j['status'] as String?, j['suspendedReason'] as String?);
}

class MarketRepository {
  MarketRepository(this._dio);
  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() fn) async {
    try {
      return await fn();
    } catch (e) {
      throw ApiError.from(e);
    }
  }

  Future<Map<String, dynamic>> _post(String path, [Object? body]) async => (await _dio.post<Map<String, dynamic>>(path, data: body ?? const {})).data!;

  Future<MarketConfig> config() => _call(() async => MarketConfig.fromJson((await _dio.get<Map<String, dynamic>>('/v1/market/config')).data!));

  Future<void> acceptPolicy(String version) => _call(() => _post('/v1/market/policy', {'version': version}));

  /// Kata kunci dan filter di body (POST), tidak di URL.
  Future<(List<Listing>, int?)> search({String? q, String? category, int offset = 0}) => _call(() async {
        final j = await _post('/v1/market/listings/search', {
          if (q != null && q.isNotEmpty) 'q': q,
          'category': ?category,
          'offset': offset,
        });
        return ((j['items'] as List<dynamic>).map((e) => Listing.fromJson(e as Map<String, dynamic>)).toList(), (j['nextOffset'] as num?)?.toInt());
      });

  Future<Listing> detail(String id) => _call(() async => Listing.fromJson((await _dio.get<Map<String, dynamic>>('/v1/market/listings/$id')).data!));

  Future<List<Listing>> mine() => _call(() async {
        final j = (await _dio.get<Map<String, dynamic>>('/v1/market/listings/mine')).data!;
        return (j['items'] as List<dynamic>).map((e) => Listing.fromJson(e as Map<String, dynamic>)).toList();
      });

  Future<Listing> create(Map<String, dynamic> data, List<Uint8List> photos) => _call(() async {
        final form = FormData.fromMap({
          'data': jsonEncode(data),
          'photos': [for (var i = 0; i < photos.length; i++) MultipartFile.fromBytes(photos[i], filename: 'foto$i.jpg')],
        });
        return Listing.fromJson((await _dio.post<Map<String, dynamic>>('/v1/market/listings', data: form)).data!);
      });

  Future<void> update(String id, Map<String, dynamic> patch) => _call(() => _dio.patch<void>('/v1/market/listings/$id', data: patch));
  Future<void> renew(String id) => _call(() => _post('/v1/market/listings/$id/renew'));
  Future<void> delete(String id) => _call(() => _dio.delete<void>('/v1/market/listings/$id'));

  /// Membuka chat pribadi dengan penjual; mengembalikan id percakapan.
  Future<String> contact(String id) => _call(() async => (await _post('/v1/market/listings/$id/contact'))['id'] as String);

  Future<String> outboundUrl(String id) => _call(() async => (await _post('/v1/market/listings/$id/go'))['url'] as String);

  Future<MarketOrder> order(String listingId, int qty) => _call(() async => MarketOrder.fromJson(await _post('/v1/market/listings/$listingId/orders', {'qty': qty})));

  Future<List<MarketOrder>> orders(String role) => _call(() async {
        final j = (await _dio.get<Map<String, dynamic>>('/v1/market/orders', queryParameters: {'role': role})).data!;
        return (j['items'] as List<dynamic>).map((e) => MarketOrder.fromJson(e as Map<String, dynamic>)).toList();
      });

  Future<MarketOrder> orderDetail(String id) => _call(() async => MarketOrder.fromJson((await _dio.get<Map<String, dynamic>>('/v1/market/orders/$id')).data!));
  Future<MarketOrder> ship(String id, String? note) => _call(() async => MarketOrder.fromJson(await _post('/v1/market/orders/$id/ship', {'trackingNote': ?note})));
  Future<MarketOrder> complete(String id) => _call(() async => MarketOrder.fromJson(await _post('/v1/market/orders/$id/complete')));
  Future<MarketOrder> cancel(String id) => _call(() async => MarketOrder.fromJson(await _post('/v1/market/orders/$id/cancel')));
  Future<MarketOrder> dispute(String id, String reason) => _call(() async => MarketOrder.fromJson(await _post('/v1/market/orders/$id/dispute', {'reason': reason})));

  Future<SellerStatus> seller() => _call(() async => SellerStatus.fromJson((await _dio.get<Map<String, dynamic>>('/v1/market/seller')).data!));
  Future<SellerStatus> activateSeller() => _call(() async => SellerStatus.fromJson(await _post('/v1/market/seller')));
  Future<SellerStatus> refreshSeller() => _call(() async => SellerStatus.fromJson(await _post('/v1/market/seller/refresh')));
}

final marketRepositoryProvider = Provider<MarketRepository>((ref) => MarketRepository(ref.watch(dioProvider)));
final marketConfigProvider = FutureProvider.autoDispose<MarketConfig>((ref) => ref.watch(marketRepositoryProvider).config());
final listingProvider = FutureProvider.autoDispose.family<Listing, String>((ref, id) => ref.watch(marketRepositoryProvider).detail(id));
final myListingsProvider = FutureProvider.autoDispose<List<Listing>>((ref) => ref.watch(marketRepositoryProvider).mine());
final ordersProvider = FutureProvider.autoDispose.family<List<MarketOrder>, String>((ref, role) => ref.watch(marketRepositoryProvider).orders(role));
final orderProvider = FutureProvider.autoDispose.family<MarketOrder, String>((ref, id) => ref.watch(marketRepositoryProvider).orderDetail(id));
final sellerProvider = FutureProvider.autoDispose<SellerStatus>((ref) => ref.watch(marketRepositoryProvider).seller());

/// Byte foto listing lewat Dio ber-pinning dan bertoken (bukan Image.network).
final listingPhotoProvider = FutureProvider.family<Uint8List?, String>((ref, path) async {
  try {
    final res = await ref.watch(dioProvider).get<List<int>>(path, options: Options(responseType: ResponseType.bytes));
    return res.data == null ? null : Uint8List.fromList(res.data!);
  } catch (_) {
    return null;
  }
});
