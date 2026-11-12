import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:in_app_purchase_android/in_app_purchase_android.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/widgets/common.dart';
import 'billing.dart';
import 'subscriptions_repository.dart';
import 'upgrade.dart';

/// Ketersediaan Play Billing + detail produk (harga) dari Google Play.
class StoreInfo {
  const StoreInfo({required this.available, required this.products});
  final bool available;
  final Map<String, GooglePlayProductDetails> products;

  String? price(String productId) => products[productId]?.price;
}

final storeInfoProvider = FutureProvider.autoDispose.family<StoreInfo, String>((ref, idsKey) async {
  final billing = ref.read(billingProvider);
  final available = await billing.available();
  if (!available) return const StoreInfo(available: false, products: {});
  final products = await billing.products(idsKey.split(',').toSet()).catchError((_) => <String, GooglePlayProductDetails>{});
  return StoreInfo(available: true, products: products);
});

String _date(DateTime d) => '${d.day}/${d.month}/${d.year}';

/// Teks status langganan untuk pengguna (selalu dari server).
String subStatusText(SubView s) {
  final until = s.expiresAt == null ? '' : _date(s.expiresAt!);
  if (s.pending) return 'Menunggu pembayaran selesai di Google Play';
  return switch (s.state) {
    'ACTIVE' => s.autoRenewing ? 'Aktif, diperpanjang otomatis $until' : 'Aktif sampai $until',
    'CANCELED' => 'Dibatalkan, tetap aktif sampai $until',
    'IN_GRACE_PERIOD' => 'Pembayaran gagal. Perbarui metode pembayaran di Google Play sebelum $until',
    'ON_HOLD' => 'Ditangguhkan karena pembayaran gagal. Perbarui metode pembayaran di Google Play',
    'PAUSED' => 'Dijeda',
    _ => 'Tidak aktif',
  };
}

Future<void> openManageSubscription(BuildContext context, String productId) async {
  final pkg = (await PackageInfo.fromPlatform()).packageName;
  final uri = Uri.https('play.google.com', '/store/account/subscriptions', {'sku': productId, 'package': pkg});
  final ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
  if (!ok && context.mounted) showInfo(context, 'Buka Google Play → Profil → Pembayaran & langganan');
}

/// Mendengarkan hasil pembelian selama layar terbuka dan memuat ulang status dari server.
mixin _PurchaseEvents<T extends ConsumerStatefulWidget> on ConsumerState<T> {
  StreamSubscription<PurchaseEvent>? _events;

  @override
  void initState() {
    super.initState();
    final billing = ref.read(billingProvider)..start();
    _events = billing.events.listen((e) {
      if (!mounted) return;
      ref.invalidate(subscriptionStatusProvider);
      switch (e) {
        case PurchaseEvent.verified:
          showInfo(context, 'Langganan aktif. Terima kasih!');
        case PurchaseEvent.pending:
          showInfo(context, 'Pembayaran sedang diproses Google Play');
        case PurchaseEvent.failed:
          showInfo(context, 'Pembelian belum bisa diverifikasi. Coba lagi nanti; kamu tidak akan ditagih dua kali');
        case PurchaseEvent.canceled:
          break;
      }
    });
    // Pembelian yang belum sempat diverifikasi server (mis. sinyal putus) dikirim ulang.
    WidgetsBinding.instance.addPostFrameCallback((_) => ref.read(billingProvider).restore());
  }

  @override
  void dispose() {
    _events?.cancel();
    super.dispose();
  }

  Future<void> buy(StoreInfo store, String plan, {String? communityId}) async {
    try {
      await ref.read(billingProvider).buy(plan: plan, products: store.products, communityId: communityId);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }
}

class _Unavailable extends StatelessWidget {
  const _Unavailable(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Card(
        child: ListTile(leading: const Icon(Icons.info_outline), title: Text(text)),
      );
}

/// Layar langganan: Premium (akun) dan daftar komunitas milik pengguna untuk Komunitas Pro.
class SubscriptionScreen extends ConsumerStatefulWidget {
  const SubscriptionScreen({super.key});

  @override
  ConsumerState<SubscriptionScreen> createState() => _SubscriptionScreenState();
}

class _SubscriptionScreenState extends ConsumerState<SubscriptionScreen> with _PurchaseEvents {
  @override
  Widget build(BuildContext context) {
    final status = ref.watch(subscriptionStatusProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Langganan')),
      body: status.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(
          child: TextButton(onPressed: () => ref.invalidate(subscriptionStatusProvider), child: const Text('Gagal memuat. Coba lagi')),
        ),
        data: (s) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(subscriptionStatusProvider),
          child: ListView(padding: const EdgeInsets.all(16), children: _content(context, s)),
        ),
      ),
    );
  }

  List<Widget> _content(BuildContext context, SubscriptionStatus s) {
    final text = Theme.of(context).textTheme;
    if (!s.enabled) return const [_Unavailable('Langganan belum tersedia')];
    final store = ref.watch(storeInfoProvider(s.productIds.join(','))).value;
    final sub = s.premium;
    final isPremium = s.plan == 'premium';
    return [
      Row(children: [
        Text('Premium', style: text.headlineSmall),
        const SizedBox(width: 8),
        if (isPremium) const PremiumBadge(),
      ]),
      const SizedBox(height: 4),
      Text(isPremium ? 'Paketmu: Premium' : 'Paketmu: Gratis', key: const Key('current-plan')),
      if (sub != null) Text(subStatusText(sub), style: TextStyle(color: sub.paymentIssue ? Theme.of(context).colorScheme.error : null)),
      if (s.premiumGrantExpiresAt != null) Text('Premium dari tim PaceTara sampai ${_date(s.premiumGrantExpiresAt!)}'),
      const SizedBox(height: 12),
      _ComparisonTable(headers: const ['Gratis', 'Premium'], rows: [for (final r in premiumFeatures) [r.$1, r.$2, r.$3]]),
      const SizedBox(height: 12),
      ..._premiumActions(s, store),
      const SizedBox(height: 24),
      Text('Komunitas Pro', style: text.headlineSmall),
      const SizedBox(height: 4),
      const Text('Langganan per komunitas, dibeli oleh pemilik komunitas. Lencana Pro melekat pada komunitas.'),
      if (s.communities.isEmpty) const Padding(padding: EdgeInsets.only(top: 8), child: Text('Kamu belum memiliki komunitas.')),
      for (final c in s.communities)
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.groups_outlined),
          title: Text(c.name),
          subtitle: Text('${planLabel(c.plan)} · ${c.memberCount}${c.memberLimit == null ? '' : '/${c.memberLimit}'} anggota'),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => context.push('/subscription/community/${c.id}'),
        ),
      const SizedBox(height: 16),
      Text(
        'Pembayaran diproses Google Play; PaceTara tidak menerima data kartu. Batalkan kapan saja di Google Play. '
        'Saat langganan berakhir, datamu tidak dihapus.',
        style: text.bodySmall,
      ),
    ];
  }

  List<Widget> _premiumActions(SubscriptionStatus s, StoreInfo? store) {
    final sub = s.premium;
    if (sub != null && sub.purchasedByMe && (sub.active || sub.paymentIssue)) {
      return [
        OutlinedButton.icon(
          onPressed: () => openManageSubscription(context, sub.productId),
          icon: const Icon(Icons.open_in_new),
          label: const Text('Kelola langganan di Google Play'),
        ),
      ];
    }
    if (store == null) return const [Center(child: CircularProgressIndicator())];
    if (!store.available) {
      return const [_Unavailable('Pembelian hanya bisa dari aplikasi yang dipasang lewat Google Play')];
    }
    final price = store.price(s.premiumProductId);
    if (price == null) return const [_Unavailable('Premium belum tersedia di Google Play')];
    return [
      FilledButton(
        key: const Key('buy-premium'),
        onPressed: () => buy(store, 'premium'),
        child: Text('Berlangganan Premium · $price'),
      ),
      const SizedBox(height: 4),
      const Text('Harga dari Google Play, diperpanjang otomatis setiap periode.', textAlign: TextAlign.center),
    ];
  }
}

/// Komunitas Pro / Pro Unlimited untuk satu komunitas milik pengguna.
class CommunitySubscriptionScreen extends ConsumerStatefulWidget {
  const CommunitySubscriptionScreen({super.key, required this.communityId});
  final String communityId;

  @override
  ConsumerState<CommunitySubscriptionScreen> createState() => _CommunitySubscriptionScreenState();
}

class _CommunitySubscriptionScreenState extends ConsumerState<CommunitySubscriptionScreen> with _PurchaseEvents {
  @override
  Widget build(BuildContext context) {
    final status = ref.watch(subscriptionStatusProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Komunitas Pro')),
      body: status.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(
          child: TextButton(onPressed: () => ref.invalidate(subscriptionStatusProvider), child: const Text('Gagal memuat. Coba lagi')),
        ),
        data: (s) => ListView(padding: const EdgeInsets.all(16), children: _content(context, s)),
      ),
    );
  }

  List<Widget> _content(BuildContext context, SubscriptionStatus s) {
    final text = Theme.of(context).textTheme;
    if (!s.enabled) return const [_Unavailable('Langganan belum tersedia')];
    final c = s.communities.where((x) => x.id == widget.communityId).firstOrNull;
    if (c == null) return const [_Unavailable('Hanya pemilik komunitas yang bisa berlangganan Komunitas Pro')];
    final store = ref.watch(storeInfoProvider(s.productIds.join(','))).value;
    final sub = c.subscription;
    return [
      Text(c.name, style: text.headlineSmall),
      const SizedBox(height: 4),
      Text('Paket: ${planLabel(c.plan)} · ${c.memberCount}${c.memberLimit == null ? '' : '/${c.memberLimit}'} anggota', key: const Key('community-plan')),
      if (sub != null) Text(subStatusText(sub), style: TextStyle(color: sub.paymentIssue ? Theme.of(context).colorScheme.error : null)),
      if (c.grantExpiresAt != null) Text('Pro dari tim PaceTara sampai ${_date(c.grantExpiresAt!)}'),
      const SizedBox(height: 12),
      _ComparisonTable(
        headers: const ['Gratis', 'Pro', 'Unlimited'],
        rows: [for (final r in communityFeatures) [r.$1, r.$2, r.$3, r.$4]],
      ),
      const SizedBox(height: 8),
      Text('Saat langganan berakhir, data dan anggota tidak dihapus, tetapi komunitas tidak bisa menerima anggota baru di atas batas paket gratis.',
          style: text.bodySmall),
      const SizedBox(height: 12),
      ..._actions(s, c, store),
    ];
  }

  List<Widget> _actions(SubscriptionStatus s, CommunitySubStatus c, StoreInfo? store) {
    final out = <Widget>[];
    final sub = c.subscription;
    if (sub != null && sub.purchasedByMe && (sub.active || sub.paymentIssue)) {
      out.add(OutlinedButton.icon(
        onPressed: () => openManageSubscription(context, sub.productId),
        icon: const Icon(Icons.open_in_new),
        label: const Text('Kelola langganan di Google Play'),
      ));
    }
    if (!c.isOwner) {
      out.add(const _Unavailable('Kepemilikan komunitas sudah diserahkan; pemilik baru yang bisa membeli langganan baru'));
      return out;
    }
    if (c.plan == 'pro_unlimited') return out;
    if (store == null) return [...out, const Center(child: CircularProgressIndicator())];
    if (!store.available) return [...out, const _Unavailable('Pembelian hanya bisa dari aplikasi yang dipasang lewat Google Play')];
    final proPrice = store.price(s.proProductId);
    final unlimitedPrice = store.price(s.proUnlimitedProductId);
    if (c.plan == 'free' && proPrice != null) {
      out.add(FilledButton(
        key: const Key('buy-pro'),
        onPressed: () => buy(store, 'pro', communityId: c.id),
        child: Text('Komunitas Pro (maks. 30 anggota) · $proPrice'),
      ));
      if (c.memberCount > 30) {
        out.add(const Padding(padding: EdgeInsets.only(top: 4), child: Text('Komunitasmu sudah lebih dari 30 anggota; pilih Pro Unlimited agar bisa menerima anggota baru.')));
      }
      out.add(const SizedBox(height: 8));
    }
    if (unlimitedPrice != null) {
      out.add(FilledButton.tonal(
        key: const Key('buy-pro-unlimited'),
        onPressed: () => buy(store, 'pro_unlimited', communityId: c.id),
        child: Text('${c.plan == 'pro' ? 'Upgrade ke ' : ''}Pro Unlimited (tanpa batas) · $unlimitedPrice'),
      ));
    }
    if (proPrice == null && unlimitedPrice == null) out.add(const _Unavailable('Komunitas Pro belum tersedia di Google Play'));
    return out;
  }
}

class _ComparisonTable extends StatelessWidget {
  const _ComparisonTable({required this.headers, required this.rows});
  final List<String> headers;
  final List<List<String>> rows;

  @override
  Widget build(BuildContext context) {
    final bold = Theme.of(context).textTheme.labelLarge;
    Widget cell(String t, {TextStyle? style}) => Padding(padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4), child: Text(t, style: style));
    return Table(
      columnWidths: const {0: FlexColumnWidth(1.4)},
      defaultVerticalAlignment: TableCellVerticalAlignment.middle,
      border: TableBorder(horizontalInside: BorderSide(color: Theme.of(context).dividerColor)),
      children: [
        TableRow(children: [cell('Fitur', style: bold), for (final h in headers) cell(h, style: bold)]),
        for (final r in rows) TableRow(children: [for (final v in r) cell(v)]),
      ],
    );
  }
}
