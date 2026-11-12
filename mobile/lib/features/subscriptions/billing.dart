import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:in_app_purchase_android/billing_client_wrappers.dart' show ReplacementMode;
import 'package:in_app_purchase_android/in_app_purchase_android.dart';

import '../../core/api/api_error.dart';
import '../auth/auth_controller.dart';
import '../communities/communities_repository.dart';
import 'subscriptions_repository.dart';

/// Hasil pembelian yang diteruskan ke layar (snackbar).
enum PurchaseEvent { verified, pending, failed, canceled }

/// Google Play Billing lewat paket resmi `in_app_purchase`. Aplikasi TIDAK pernah mengubah paket sendiri: setiap
/// pembelian (baru atau dipulihkan) dikirim ke server, yang memverifikasinya ke Google dan meng-acknowledge.
/// Billing hanya berfungsi untuk aplikasi yang dipasang dari Google Play (termasuk track uji), bukan APK GitHub.
class BillingService {
  BillingService(this._ref);
  final Ref _ref;
  StreamSubscription<List<PurchaseDetails>>? _sub;
  final _events = StreamController<PurchaseEvent>.broadcast();

  /// productId → komunitas untuk pembelian Pro yang sedang berjalan (pembelian yang dipulihkan dikirim tanpa
  /// komunitas; server mencocokkannya lewat obfuscatedAccountId).
  final _pendingCommunity = <String, String>{};
  bool _restored = false;

  InAppPurchase get _iap => InAppPurchase.instance;
  Stream<PurchaseEvent> get events => _events.stream;

  /// Mulai mendengarkan pembelian. Aman dipanggil berkali-kali.
  void start() {
    if (_sub != null || defaultTargetPlatform != TargetPlatform.android) return;
    _sub = _iap.purchaseStream.listen(_onPurchases, onError: (_) => _events.add(PurchaseEvent.failed));
  }

  Future<bool> available() async {
    if (defaultTargetPlatform != TargetPlatform.android) return false;
    try {
      return await _iap.isAvailable();
    } catch (_) {
      return false;
    }
  }

  /// Pulihkan pembelian yang belum sempat diverifikasi server (mis. server tidak terjangkau saat membeli).
  /// Sekali per sesi aplikasi kecuali [force].
  Future<void> restore({bool force = false}) async {
    if (_restored && !force) return;
    if (!await available()) return;
    _restored = true;
    start();
    await _iap.restorePurchases().catchError((_) {});
  }

  /// Harga dan detail base plan dari Google Play (bukan harga di kode).
  Future<Map<String, GooglePlayProductDetails>> products(Set<String> ids) async {
    if (!await available()) return const {};
    final res = await _iap.queryProductDetails(ids.where((e) => e.isNotEmpty).toSet());
    final out = <String, GooglePlayProductDetails>{};
    for (final d in res.productDetails.whereType<GooglePlayProductDetails>()) {
      final offers = d.productDetails.subscriptionOfferDetails;
      final index = d.subscriptionIndex;
      // Base plan (tanpa offerId) diutamakan agar harga yang tampil adalah harga reguler.
      final isBase = offers == null || index == null || offers[index].offerId == null;
      if (isBase || !out.containsKey(d.id)) out[d.id] = d;
    }
    return out;
  }

  /// Minta server memeriksa hak, lalu buka alur pembelian Play dengan obfuscatedAccountId dari server.
  Future<void> buy({required String plan, required Map<String, GooglePlayProductDetails> products, String? communityId}) async {
    start();
    final intent = await _ref.read(subscriptionsRepositoryProvider).intent(plan, communityId: communityId);
    final details = products[intent.productId];
    if (details == null) throw const ApiError(0, 'product_unavailable', 'Produk belum tersedia di Google Play');
    ChangeSubscriptionParam? change;
    final from = intent.upgradeFrom;
    if (from != null) {
      // Upgrade Pro → Pro Unlimited: ganti langganan lama (Google mengirim linkedPurchaseToken ke server).
      final old = await _pastPurchase(from);
      if (old != null) change = ChangeSubscriptionParam(oldPurchaseDetails: old, replacementMode: ReplacementMode.chargeProratedPrice);
    }
    if (communityId != null) _pendingCommunity[intent.productId] = communityId;
    final ok = await _iap.buyNonConsumable(
      purchaseParam: GooglePlayPurchaseParam(productDetails: details, applicationUserName: intent.obfuscatedAccountId, changeSubscriptionParam: change),
    );
    if (!ok) throw const ApiError(0, 'billing_failed', 'Tidak bisa membuka Google Play');
  }

  Future<GooglePlayPurchaseDetails?> _pastPurchase(String productId) async {
    try {
      final addition = _iap.getPlatformAddition<InAppPurchaseAndroidPlatformAddition>();
      final res = await addition.queryPastPurchases();
      return res.pastPurchases.where((p) => p.productID == productId).firstOrNull;
    } catch (_) {
      return null;
    }
  }

  Future<void> _onPurchases(List<PurchaseDetails> list) async {
    for (final p in list) {
      switch (p.status) {
        case PurchaseStatus.pending:
          _events.add(PurchaseEvent.pending);
        case PurchaseStatus.canceled:
          _pendingCommunity.remove(p.productID);
          _events.add(PurchaseEvent.canceled);
        case PurchaseStatus.error:
          _pendingCommunity.remove(p.productID);
          _events.add(PurchaseEvent.failed);
        case PurchaseStatus.purchased:
        case PurchaseStatus.restored:
          await _verify(p);
      }
    }
  }

  Future<void> _verify(PurchaseDetails p) async {
    final restored = p.status == PurchaseStatus.restored;
    try {
      await _ref.read(subscriptionsRepositoryProvider).verify(
            productId: p.productID,
            purchaseToken: p.verificationData.serverVerificationData,
            communityId: _pendingCommunity.remove(p.productID),
          );
      // Acknowledge dilakukan server. Status terbaru selalu dibaca ulang dari server.
      _ref.invalidate(subscriptionStatusProvider);
      _ref.invalidate(myCommunitiesProvider);
      await _ref.read(authControllerProvider.notifier).reload().catchError((_) {});
      if (!restored) _events.add(PurchaseEvent.verified);
    } catch (_) {
      // Pembelian yang dipulihkan bisa milik akun PaceTara lain di akun Google yang sama: diam saja.
      if (!restored) _events.add(PurchaseEvent.failed);
    }
  }

  void dispose() {
    _sub?.cancel();
    _events.close();
  }
}

final billingProvider = Provider<BillingService>((ref) {
  final s = BillingService(ref);
  ref.onDispose(s.dispose);
  return s;
});
