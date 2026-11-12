import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_error.dart';
import '../../core/http/api_client.dart';

DateTime? _date(Object? v) => v is String ? DateTime.parse(v).toLocal() : null;

/// Status satu langganan Google Play menurut server (bukan menurut aplikasi).
class SubView {
  const SubView({
    required this.productId,
    required this.kind,
    required this.state,
    required this.active,
    required this.expiresAt,
    required this.autoRenewing,
    required this.purchasedByMe,
    required this.paymentIssue,
    required this.pending,
  });
  final String productId;
  final String kind;
  final String state;
  final bool active;
  final DateTime? expiresAt;
  final bool autoRenewing;
  final bool purchasedByMe;
  final bool paymentIssue;
  final bool pending;

  static SubView? fromJson(Object? raw) {
    if (raw is! Map<String, dynamic>) return null;
    return SubView(
      productId: raw['productId'] as String? ?? '',
      kind: raw['kind'] as String? ?? '',
      state: raw['state'] as String? ?? '',
      active: raw['active'] as bool? ?? false,
      expiresAt: _date(raw['expiresAt']),
      autoRenewing: raw['autoRenewing'] as bool? ?? false,
      purchasedByMe: raw['purchasedByMe'] as bool? ?? false,
      paymentIssue: raw['paymentIssue'] as bool? ?? false,
      pending: raw['pending'] as bool? ?? false,
    );
  }
}

class CommunitySubStatus {
  const CommunitySubStatus({
    required this.id,
    required this.name,
    required this.plan,
    required this.isOwner,
    required this.memberCount,
    required this.memberLimit,
    required this.subscription,
    required this.grantExpiresAt,
  });
  final String id;
  final String name;

  /// free | pro | pro_unlimited
  final String plan;
  final bool isOwner;
  final int memberCount;
  final int? memberLimit;
  final SubView? subscription;
  final DateTime? grantExpiresAt;

  factory CommunitySubStatus.fromJson(Map<String, dynamic> j) {
    final limit = j['memberLimit'] as Map<String, dynamic>? ?? const {};
    return CommunitySubStatus(
      id: j['id'] as String,
      name: j['name'] as String? ?? '',
      plan: j['plan'] as String? ?? 'free',
      isOwner: j['isOwner'] as bool? ?? false,
      memberCount: (limit['used'] as num?)?.toInt() ?? 0,
      memberLimit: (limit['limit'] as num?)?.toInt(),
      subscription: SubView.fromJson(j['subscription']),
      grantExpiresAt: _date(j['grantExpiresAt']),
    );
  }
}

class SubscriptionStatus {
  const SubscriptionStatus({
    required this.enabled,
    required this.premiumProductId,
    required this.proProductId,
    required this.proUnlimitedProductId,
    required this.plan,
    required this.premium,
    required this.premiumGrantExpiresAt,
    required this.communities,
  });
  final bool enabled;
  final String premiumProductId;
  final String proProductId;
  final String proUnlimitedProductId;

  /// Paket akun saat ini: free | premium.
  final String plan;
  final SubView? premium;
  final DateTime? premiumGrantExpiresAt;
  final List<CommunitySubStatus> communities;

  Set<String> get productIds => {premiumProductId, proProductId, proUnlimitedProductId};

  factory SubscriptionStatus.fromJson(Map<String, dynamic> j) {
    final products = j['products'] as Map<String, dynamic>? ?? const {};
    final premium = j['premium'] as Map<String, dynamic>? ?? const {};
    return SubscriptionStatus(
      enabled: j['enabled'] as bool? ?? false,
      premiumProductId: products['premium'] as String? ?? '',
      proProductId: products['pro'] as String? ?? '',
      proUnlimitedProductId: products['proUnlimited'] as String? ?? '',
      plan: premium['plan'] as String? ?? 'free',
      premium: SubView.fromJson(premium['subscription']),
      premiumGrantExpiresAt: _date(premium['grantExpiresAt']),
      communities: (j['communities'] as List<dynamic>? ?? const []).map((e) => CommunitySubStatus.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }
}

/// Jawaban server sebelum membeli: productId dan obfuscatedAccountId (HMAC opaque, bukan data pribadi) yang
/// wajib diset di alur pembelian Play agar server bisa memastikan pembelian milik akun (+ komunitas) ini.
class PurchaseIntent {
  const PurchaseIntent({required this.productId, required this.obfuscatedAccountId, required this.upgradeFrom});
  final String productId;
  final String obfuscatedAccountId;
  final String? upgradeFrom;
}

class SubscriptionsRepository {
  SubscriptionsRepository(this._dio);
  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() fn) async {
    try {
      return await fn();
    } catch (e) {
      throw ApiError.from(e);
    }
  }

  Future<SubscriptionStatus> status() =>
      _call(() async => SubscriptionStatus.fromJson((await _dio.get<Map<String, dynamic>>('/v1/subscriptions')).data!));

  /// [plan] = premium | pro | pro_unlimited.
  Future<PurchaseIntent> intent(String plan, {String? communityId}) => _call(() async {
        final j = (await _dio.post<Map<String, dynamic>>('/v1/subscriptions/play/intent', data: {
          'plan': plan,
          'communityId': ?communityId,
        }))
            .data!;
        return PurchaseIntent(
          productId: j['productId'] as String,
          obfuscatedAccountId: j['obfuscatedAccountId'] as String,
          upgradeFrom: j['upgradeFrom'] as String?,
        );
      });

  /// Kirim bukti pembelian ke server. Server yang memverifikasi ke Google dan mengubah paket.
  Future<void> verify({required String productId, required String purchaseToken, String? communityId}) => _call(() async {
        await _dio.post<Map<String, dynamic>>('/v1/subscriptions/play/verify', data: {
          'productId': productId,
          'purchaseToken': purchaseToken,
          'communityId': ?communityId,
        });
      });
}

final subscriptionsRepositoryProvider = Provider((ref) => SubscriptionsRepository(ref.watch(dioProvider)));

final subscriptionStatusProvider = FutureProvider.autoDispose<SubscriptionStatus>((ref) => ref.watch(subscriptionsRepositoryProvider).status());
