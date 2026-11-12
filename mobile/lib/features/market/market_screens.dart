import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api/api_error.dart';
import '../../core/widgets/common.dart';
import '../communities/widgets.dart';
import '../moderation/moderation.dart';
import 'market_repository.dart';

/// Buka tautan https di browser luar (pembayaran Xendit, toko afiliasi). Skema lain ditolak.
Future<void> openExternal(BuildContext context, String url) async {
  final uri = Uri.tryParse(url);
  if (uri == null || uri.scheme != 'https') {
    showInfo(context, 'Tautan tidak aman');
    return;
  }
  if (!await launchUrl(uri, mode: LaunchMode.externalApplication) && context.mounted) showInfo(context, 'Tidak bisa membuka tautan');
}

/// Pastikan kebijakan transaksi sudah disetujui; jika belum, buka layar kebijakan. True jika boleh lanjut.
Future<bool> ensurePolicy(BuildContext context, WidgetRef ref) async {
  final cfg = await ref.read(marketConfigProvider.future);
  if (cfg.policyAccepted) return true;
  if (!context.mounted) return false;
  final ok = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => MarketPolicyScreen(config: cfg)));
  ref.invalidate(marketConfigProvider);
  return ok ?? false;
}

class _Photo extends ConsumerWidget {
  const _Photo(this.path, {this.fit = BoxFit.cover});
  final String path;
  final BoxFit fit;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final bytes = ref.watch(listingPhotoProvider(path));
    return bytes.when(
      data: (b) => b == null ? const ColoredBox(color: Colors.black12, child: Center(child: Icon(Icons.broken_image_outlined))) : Image.memory(b, fit: fit, gaplessPlayback: true),
      loading: () => const ColoredBox(color: Colors.black12),
      error: (_, _) => const ColoredBox(color: Colors.black12),
    );
  }
}

/// Daftar marketplace: cari, filter kategori, tombol jual, pesanan, dan listing saya.
class MarketScreen extends ConsumerStatefulWidget {
  const MarketScreen({super.key});

  @override
  ConsumerState<MarketScreen> createState() => _MarketScreenState();
}

class _MarketScreenState extends ConsumerState<MarketScreen> {
  final _q = TextEditingController();
  String? _category;
  List<Listing> _items = [];
  int? _next;
  bool _loading = true;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _load(reset: true);
  }

  @override
  void dispose() {
    _q.dispose();
    super.dispose();
  }

  Future<void> _load({bool reset = false}) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final (items, next) = await ref.read(marketRepositoryProvider).search(q: _q.text.trim(), category: _category, offset: reset ? 0 : (_next ?? 0));
      if (!mounted) return;
      setState(() {
        _items = reset ? items : [..._items, ...items];
        _next = next;
      });
    } catch (e) {
      if (mounted) setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Marketplace'),
        actions: [
          IconButton(tooltip: 'Pesanan', icon: const Icon(Icons.receipt_long_outlined), onPressed: () => context.push('/market/orders')),
          IconButton(tooltip: 'Listing saya', icon: const Icon(Icons.storefront_outlined), onPressed: () => context.push('/market/mine')),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        key: const Key('market-sell'),
        icon: const Icon(Icons.add),
        label: const Text('Jual'),
        onPressed: () async {
          if (await ensurePolicy(context, ref) && context.mounted) {
            await context.push('/market/new');
            _load(reset: true);
          }
        },
      ),
      body: RefreshIndicator(
        onRefresh: () => _load(reset: true),
        child: ListView(padding: const EdgeInsets.only(bottom: 96), children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
            child: TextField(
              key: const Key('market-search'),
              controller: _q,
              textInputAction: TextInputAction.search,
              onSubmitted: (_) => _load(reset: true),
              decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Cari sepatu, jam, jersey…', border: OutlineInputBorder(), isDense: true),
            ),
          ),
          SizedBox(
            height: 48,
            child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 12), children: [
              for (final e in [const MapEntry<String?, String>(null, 'Semua'), ...marketCategories.entries.map((e) => MapEntry<String?, String>(e.key, e.value))])
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  child: ChoiceChip(
                    label: Text(e.value),
                    selected: _category == e.key,
                    onSelected: (_) {
                      setState(() => _category = e.key);
                      _load(reset: true);
                    },
                  ),
                ),
            ]),
          ),
          if (_error != null) Padding(padding: const EdgeInsets.all(24), child: Text(ApiError.from(_error!).message, textAlign: TextAlign.center)),
          if (!_loading && _error == null && _items.isEmpty) const Padding(padding: EdgeInsets.all(32), child: Text('Belum ada barang yang cocok.', textAlign: TextAlign.center)),
          for (final l in _items) _ListingTile(l, onTap: () => context.push('/market/listings/${l.id}')),
          if (_loading) const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator())),
          if (!_loading && _next != null) TextButton(onPressed: _load, child: const Text('Muat lebih banyak')),
        ]),
      ),
    );
  }
}

class _ListingTile extends StatelessWidget {
  const _ListingTile(this.l, {required this.onTap, this.showStatus = false});
  final Listing l;
  final VoidCallback onTap;
  final bool showStatus;

  @override
  Widget build(BuildContext context) => ListTile(
        onTap: onTap,
        leading: SizedBox(width: 64, height: 64, child: ClipRRect(borderRadius: BorderRadius.circular(8), child: l.photos.isEmpty ? const Icon(Icons.image_outlined) : _Photo(l.photos.first))),
        title: Text(l.title, maxLines: 2, overflow: TextOverflow.ellipsis),
        subtitle: Text([
          rupiah(l.price),
          l.city,
          if (showStatus) l.statusLabel else l.modelLabel,
          if (l.boosted) 'Unggulan',
        ].join(' · ')),
        trailing: l.sellerVerified ? const Icon(Icons.verified, size: 18) : null,
      );
}

/// Detail listing: foto, harga, penjual, dan aksi sesuai model (hubungi, kunjungi toko, beli).
class ListingDetailScreen extends ConsumerWidget {
  const ListingDetailScreen({super.key, required this.id});
  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final listing = ref.watch(listingProvider(id));
    return Scaffold(
      appBar: AppBar(
        title: const Text('Detail barang'),
        actions: [
          if (listing.value != null && !listing.value!.mine)
            IconButton(
              tooltip: 'Laporkan',
              icon: const Icon(Icons.flag_outlined),
              onPressed: () => showReportSheet(context, ref, target: ReportTarget.listing, targetId: id, title: 'Laporkan listing'),
            ),
        ],
      ),
      body: listing.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text(ApiError.from(e).message)),
        data: (l) => ListView(children: [
          if (l.photos.isNotEmpty)
            AspectRatio(aspectRatio: 4 / 3, child: PageView(children: [for (final p in l.photos) _Photo(p, fit: BoxFit.contain)])),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(rupiah(l.price), style: Theme.of(context).textTheme.headlineSmall),
              const SizedBox(height: 4),
              Text(l.title, style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              Wrap(spacing: 8, runSpacing: 4, children: [
                Chip(label: Text(marketCategories[l.category] ?? l.category)),
                Chip(label: Text(marketConditions[l.condition] ?? l.condition)),
                Chip(label: Text(l.city)),
                Chip(label: Text(l.modelLabel)),
                if (l.model == 'split' && l.stock != null) Chip(label: Text('Stok ${l.stock}')),
              ]),
              const SizedBox(height: 12),
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.person_outline),
                title: Text(l.sellerName),
                subtitle: Text(l.sellerVerified ? 'Penjual Terverifikasi (KTP)' : 'Penjual belum verifikasi KTP'),
                trailing: l.sellerVerified ? const Icon(Icons.verified) : null,
              ),
              if (l.description.isNotEmpty) Text(l.description),
              const SizedBox(height: 16),
              if (l.mine) Text('Ini listing milikmu · ${l.statusLabel}', style: Theme.of(context).textTheme.bodySmall) else ..._actions(context, ref, l),
              const SizedBox(height: 12),
              Text(
                'PaceTara mempertemukan penjual dan pembeli dan tidak menyimpan uang pembeli. '
                '${l.model == 'split' ? 'Pembayaran diproses Xendit langsung ke akun penjual; masalah pesanan bisa diajukan sebagai sengketa dalam 7 hari.' : 'Transaksi terjadi di luar PaceTara; waspadai permintaan transfer ke rekening yang mencurigakan.'}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ]),
          ),
        ]),
      ),
    );
  }

  List<Widget> _actions(BuildContext context, WidgetRef ref, Listing l) => [
        if (l.canBuy)
          AsyncButton(
            key: const Key('market-buy'),
            label: 'Beli lewat aplikasi',
            onPressed: () async {
              if (!await ensurePolicy(context, ref) || !context.mounted) return;
              final qty = await _askQty(context, l.stock ?? 1);
              if (qty == null) return;
              final order = await ref.read(marketRepositoryProvider).order(l.id, qty);
              ref.invalidate(listingProvider(l.id));
              if (!context.mounted) return;
              if (order.invoiceUrl != null) await openExternal(context, order.invoiceUrl!);
              if (context.mounted) context.push('/market/orders/${order.id}');
            },
          ),
        if (l.model == 'affiliate') ...[
          const SizedBox(height: 8),
          AsyncButton(
            label: 'Kunjungi toko',
            outlined: l.canBuy,
            onPressed: () async {
              final url = await ref.read(marketRepositoryProvider).outboundUrl(l.id);
              if (context.mounted) await openExternal(context, url);
            },
          ),
        ],
        const SizedBox(height: 8),
        AsyncButton(
          key: const Key('market-contact'),
          label: 'Hubungi penjual',
          outlined: true,
          onPressed: () async {
            final convId = await ref.read(marketRepositoryProvider).contact(l.id);
            if (context.mounted) context.push('/chat/$convId');
          },
        ),
      ];

  Future<int?> _askQty(BuildContext context, int max) async {
    var qty = 1;
    return showDialog<int>(
      context: context,
      builder: (d) => StatefulBuilder(
        builder: (d, set) => AlertDialog(
          title: const Text('Jumlah'),
          content: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            IconButton(onPressed: qty > 1 ? () => set(() => qty--) : null, icon: const Icon(Icons.remove)),
            Text('$qty', style: Theme.of(d).textTheme.titleLarge),
            IconButton(onPressed: qty < max.clamp(1, 10) ? () => set(() => qty++) : null, icon: const Icon(Icons.add)),
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.pop(d), child: const Text('Batal')),
            FilledButton(onPressed: () => Navigator.pop(d, qty), child: const Text('Lanjut ke pembayaran')),
          ],
        ),
      ),
    );
  }
}

/// Kebijakan transaksi: ringkasan + tautan naskah lengkap + centang persetujuan (berversi).
class MarketPolicyScreen extends ConsumerStatefulWidget {
  const MarketPolicyScreen({super.key, required this.config});
  final MarketConfig config;

  @override
  ConsumerState<MarketPolicyScreen> createState() => _MarketPolicyScreenState();
}

class _MarketPolicyScreenState extends ConsumerState<MarketPolicyScreen> {
  bool _agree = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Kebijakan transaksi')),
      body: ListView(padding: const EdgeInsets.all(24), children: [
        const Text(
          '• PaceTara adalah perantara: mempertemukan penjual dan pembeli, tidak menjual barang, dan tidak menyimpan uang pembeli.\n\n'
          '• Dilarang menjual barang ilegal, palsu/KW, obat/suplemen tanpa izin BPOM, doping, rokok/vape, senjata, atau BIB/tiket yang dilarang dipindahtangankan.\n\n'
          '• Bayar di aplikasi diproses Xendit langsung ke akun penjual; PaceTara memotong komisi yang ditampilkan sebelum memasang.\n\n'
          '• Masalah pesanan bayar di aplikasi bisa diajukan sebagai sengketa dalam 7 hari; tim PaceTara memutuskan selesai atau refund.\n\n'
          '• Penjual yang melanggar bisa diturunkan listingnya, ditangguhkan akun pembayarannya, atau diblokir.',
        ),
        TextButton(onPressed: () => openExternal(context, widget.config.policyUrl), child: const Text('Baca kebijakan lengkap')),
        CheckboxListTile(
          key: const Key('market-policy-agree'),
          value: _agree,
          onChanged: (v) => setState(() => _agree = v ?? false),
          contentPadding: EdgeInsets.zero,
          controlAffinity: ListTileControlAffinity.leading,
          title: Text('Saya menyetujui kebijakan transaksi versi ${widget.config.policyVersion}'),
        ),
        const SizedBox(height: 12),
        AsyncButton(
          key: const Key('market-policy-accept'),
          label: 'Setuju',
          onPressed: _agree
              ? () async {
                  final nav = Navigator.of(context);
                  await ref.read(marketRepositoryProvider).acceptPolicy(widget.config.policyVersion);
                  if (mounted) nav.pop(true);
                }
              : null,
        ),
      ]),
    );
  }
}

/// Pasang listing dari aplikasi: tautan toko online (afiliasi) atau bayar di aplikasi (split, Level 2 + akun Xendit).
class ListingFormScreen extends ConsumerStatefulWidget {
  const ListingFormScreen({super.key});

  @override
  ConsumerState<ListingFormScreen> createState() => _ListingFormScreenState();
}

class _ListingFormScreenState extends ConsumerState<ListingFormScreen> {
  final _form = GlobalKey<FormState>();
  final _title = TextEditingController();
  final _desc = TextEditingController();
  final _price = TextEditingController();
  final _city = TextEditingController();
  final _url = TextEditingController();
  final _stock = TextEditingController(text: '1');
  String _model = 'affiliate';
  String _category = 'shoes';
  String _condition = 'used';
  final List<Uint8List> _photos = [];

  @override
  void dispose() {
    for (final c in [_title, _desc, _price, _city, _url, _stock]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _pick() async {
    final files = await ImagePicker().pickMultiImage(maxWidth: 2048, imageQuality: 85);
    for (final f in files) {
      final bytes = await f.readAsBytes();
      try {
        await File(f.path).delete();
      } catch (_) {}
      if (_photos.length < 6) _photos.add(bytes);
    }
    if (mounted) setState(() {});
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    if (_photos.isEmpty) {
      showInfo(context, 'Tambahkan minimal 1 foto');
      return;
    }
    final router = GoRouter.of(context);
    try {
      final l = await ref.read(marketRepositoryProvider).create({
        'model': _model,
        'title': _title.text.trim(),
        'description': _desc.text.trim(),
        'category': _category,
        'condition': _condition,
        'price': int.parse(_price.text.replaceAll(RegExp(r'\D'), '')),
        'city': _city.text.trim(),
        if (_model == 'affiliate') 'affiliateUrl': _url.text.trim(),
        if (_model == 'split') 'stock': int.parse(_stock.text),
      }, _photos);
      ref.invalidate(myListingsProvider);
      router.pushReplacement('/market/listings/${l.id}');
    } on ApiError catch (e) {
      if (!mounted) return;
      if (e.code == 'verification_required') {
        await showVerificationDialog(context, e.message);
      } else if (e.code == 'seller_not_live') {
        router.push('/market/seller');
      } else {
        rethrow;
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final cfg = ref.watch(marketConfigProvider).value;
    return Scaffold(
      appBar: AppBar(title: const Text('Jual barang')),
      body: Form(
        key: _form,
        child: ListView(padding: const EdgeInsets.all(16), children: [
          SegmentedButton<String>(
            segments: [
              const ButtonSegment(value: 'affiliate', label: Text('Toko online'), icon: Icon(Icons.link)),
              if (cfg?.splitEnabled ?? false) const ButtonSegment(value: 'split', label: Text('Bayar di aplikasi'), icon: Icon(Icons.payments_outlined)),
            ],
            selected: {_model},
            onSelectionChanged: (s) => setState(() => _model = s.first),
          ),
          const SizedBox(height: 8),
          Text(
            _model == 'affiliate'
                ? 'Pembeli diarahkan ke produkmu di Tokopedia, Shopee, Lazada, Blibli, Bukalapak, TikTok Shop, atau Zalora. Gratis.'
                : 'Pembeli membayar lewat Xendit langsung ke akun Xendit-mu. Komisi PaceTara ${cfg?.feePercent ?? '-'}% per transaksi. Wajib verifikasi KTP dan akun pembayaran aktif.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          if (_model == 'split')
            TextButton.icon(onPressed: () => context.push('/market/seller'), icon: const Icon(Icons.account_balance_wallet_outlined), label: const Text('Status akun pembayaran')),
          const SizedBox(height: 12),
          TextFormField(controller: _title, decoration: const InputDecoration(labelText: 'Judul', border: OutlineInputBorder()), maxLength: 80, validator: (v) => (v ?? '').trim().length >= 3 ? null : 'Minimal 3 karakter'),
          TextFormField(
            controller: _price,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            decoration: const InputDecoration(labelText: 'Harga (rupiah)', border: OutlineInputBorder()),
            validator: (v) => (int.tryParse(v ?? '') ?? 0) >= 1000 ? null : 'Minimal Rp1.000',
          ),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(
              child: DropdownButtonFormField<String>(
                initialValue: _category,
                decoration: const InputDecoration(labelText: 'Kategori', border: OutlineInputBorder()),
                items: [for (final e in marketCategories.entries) DropdownMenuItem(value: e.key, child: Text(e.value))],
                onChanged: (v) => setState(() => _category = v!),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: DropdownButtonFormField<String>(
                initialValue: _condition,
                decoration: const InputDecoration(labelText: 'Kondisi', border: OutlineInputBorder()),
                items: [for (final e in marketConditions.entries) DropdownMenuItem(value: e.key, child: Text(e.value))],
                onChanged: (v) => setState(() => _condition = v!),
              ),
            ),
          ]),
          const SizedBox(height: 12),
          TextFormField(controller: _city, decoration: const InputDecoration(labelText: 'Kota', border: OutlineInputBorder()), validator: (v) => (v ?? '').trim().length >= 2 ? null : 'Kota wajib diisi'),
          const SizedBox(height: 12),
          if (_model == 'affiliate')
            TextFormField(
              key: const Key('market-url'),
              controller: _url,
              keyboardType: TextInputType.url,
              decoration: const InputDecoration(labelText: 'Tautan produk (https://…)', border: OutlineInputBorder()),
              validator: (v) => (v ?? '').trim().startsWith('https://') ? null : 'Tautan harus diawali https://',
            ),
          if (_model == 'split')
            TextFormField(
              controller: _stock,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              decoration: const InputDecoration(labelText: 'Stok', border: OutlineInputBorder()),
              validator: (v) => ((int.tryParse(v ?? '') ?? 0) >= 1 && (int.tryParse(v ?? '') ?? 0) <= 999) ? null : '1–999',
            ),
          const SizedBox(height: 12),
          TextFormField(controller: _desc, maxLines: 4, maxLength: 2000, decoration: const InputDecoration(labelText: 'Deskripsi (ukuran, minus, ongkir)', border: OutlineInputBorder())),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (var i = 0; i < _photos.length; i++)
              Stack(children: [
                SizedBox(width: 72, height: 72, child: ClipRRect(borderRadius: BorderRadius.circular(8), child: Image.memory(_photos[i], fit: BoxFit.cover))),
                Positioned(right: 0, top: 0, child: InkWell(onTap: () => setState(() => _photos.removeAt(i)), child: const Icon(Icons.cancel, size: 20))),
              ]),
            if (_photos.length < 6) OutlinedButton.icon(onPressed: _pick, icon: const Icon(Icons.add_a_photo_outlined), label: Text('Foto (${_photos.length}/6)')),
          ]),
          const SizedBox(height: 20),
          AsyncButton(key: const Key('market-submit'), label: 'Pasang listing', onPressed: _submit),
        ]),
      ),
    );
  }
}

/// Listing milik sendiri dan pengelolaannya.
class MyListingsScreen extends ConsumerWidget {
  const MyListingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(myListingsProvider);
    final repo = ref.read(marketRepositoryProvider);
    Future<void> run(Future<void> Function() fn) async {
      try {
        await fn();
        ref.invalidate(myListingsProvider);
      } catch (e) {
        if (context.mounted) showError(context, e);
      }
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('Listing saya'),
        actions: [IconButton(tooltip: 'Akun pembayaran', icon: const Icon(Icons.account_balance_wallet_outlined), onPressed: () => context.push('/market/seller'))],
      ),
      body: list.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text(ApiError.from(e).message)),
        data: (items) => items.isEmpty
            ? const Center(child: Text('Belum ada listing.'))
            : ListView(children: [
                for (final l in items)
                  Row(children: [
                    Expanded(child: _ListingTile(l, showStatus: true, onTap: () => context.push('/market/listings/${l.id}'))),
                    PopupMenuButton<String>(
                      onSelected: (a) => switch (a) {
                        'sold' => run(() => repo.update(l.id, {'status': 'sold'})),
                        'close' => run(() => repo.update(l.id, {'status': 'closed'})),
                        'renew' => run(() => repo.renew(l.id)),
                        _ => run(() async {
                            if (await confirm(context, title: 'Hapus listing?', message: 'Listing dan fotonya dihapus permanen.', action: 'Hapus', destructive: true)) {
                              await repo.delete(l.id);
                            }
                          }),
                      },
                      itemBuilder: (_) => [
                        if (['active', 'pending_payment'].contains(l.status)) const PopupMenuItem(value: 'sold', child: Text('Tandai terjual')),
                        if (['active', 'pending_payment'].contains(l.status)) const PopupMenuItem(value: 'close', child: Text('Tutup')),
                        if (l.model != 'listing_fee' && ['active', 'expired'].contains(l.status)) const PopupMenuItem(value: 'renew', child: Text('Perpanjang masa tayang')),
                        const PopupMenuItem(value: 'delete', child: Text('Hapus')),
                      ],
                    ),
                  ]),
              ]),
      ),
    );
  }
}

/// Akun pembayaran penjual (sub-akun Xendit). Email terverifikasi dikirim ke Xendit hanya saat tombol ditekan.
class SellerAccountScreen extends ConsumerWidget {
  const SellerAccountScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final seller = ref.watch(sellerProvider);
    final repo = ref.read(marketRepositoryProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Akun pembayaran')),
      body: seller.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text(ApiError.from(e).message)),
        data: (s) => ListView(padding: const EdgeInsets.all(24), children: [
          if (!s.enabled)
            const Text('Pembayaran di aplikasi belum tersedia.')
          else if (s.status == null) ...[
            Text('Terima pembayaran di aplikasi', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 8),
            const Text(
              'Pembeli membayar lewat Xendit dan dana masuk ke akun Xendit milikmu (bukan ke PaceTara). '
              'Saat kamu menekan tombol di bawah, email terverifikasi akunmu dikirim ke Xendit, lalu Xendit mengirim undangan untuk membuat akun dan menyelesaikan verifikasi di sana. '
              'Wajib sudah verifikasi KTP (Level 2).',
            ),
            const SizedBox(height: 16),
            AsyncButton(
              key: const Key('seller-activate'),
              label: 'Aktifkan pembayaran di aplikasi',
              onPressed: () async {
                if (!await ensurePolicy(context, ref)) return;
                try {
                  await repo.activateSeller();
                  ref.invalidate(sellerProvider);
                } on ApiError catch (e) {
                  if (e.code == 'verification_required' && context.mounted) {
                    await showVerificationDialog(context, e.message);
                  } else {
                    rethrow;
                  }
                }
              },
            ),
          ] else ...[
            Text(switch (s.status) {
              'live' => 'Aktif: kamu bisa memasang listing bayar di aplikasi.',
              'suspended' => 'Ditangguhkan tim PaceTara${s.suspendedReason == null ? '' : ': ${s.suspendedReason}'}',
              _ => 'Menunggu verifikasi di Xendit. Buka email undangan dari Xendit dan selesaikan pendaftarannya, lalu perbarui status di sini.',
            }),
            const SizedBox(height: 16),
            if (s.status != 'live' && s.status != 'suspended')
              AsyncButton(
                label: 'Perbarui status',
                onPressed: () async {
                  await repo.refreshSeller();
                  ref.invalidate(sellerProvider);
                },
              ),
          ],
        ]),
      ),
    );
  }
}

/// Pesanan bayar di aplikasi: tab pembelian dan penjualan.
class OrdersScreen extends ConsumerWidget {
  const OrdersScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    Widget list(String role) => ref.watch(ordersProvider(role)).when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => Center(child: Text(ApiError.from(e).message)),
          data: (items) => items.isEmpty
              ? const Center(child: Text('Belum ada pesanan.'))
              : RefreshIndicator(
                  onRefresh: () async => ref.invalidate(ordersProvider(role)),
                  child: ListView(children: [
                    for (final o in items)
                      ListTile(
                        title: Text('${o.title} x${o.qty}'),
                        subtitle: Text('${rupiah(o.amount)} · ${o.statusLabel} · ${o.counterpartName}'),
                        onTap: () => context.push('/market/orders/${o.id}'),
                      ),
                  ]),
                ),
        );
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(title: const Text('Pesanan'), bottom: const TabBar(tabs: [Tab(text: 'Pembelian'), Tab(text: 'Penjualan')])),
        body: TabBarView(children: [list('buyer'), list('seller')]),
      ),
    );
  }
}

class OrderDetailScreen extends ConsumerWidget {
  const OrderDetailScreen({super.key, required this.id});
  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final order = ref.watch(orderProvider(id));
    final repo = ref.read(marketRepositoryProvider);
    void refresh() {
      ref.invalidate(orderProvider(id));
      ref.invalidate(ordersProvider('buyer'));
      ref.invalidate(ordersProvider('seller'));
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Detail pesanan')),
      body: order.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text(ApiError.from(e).message)),
        data: (o) => RefreshIndicator(
          onRefresh: () async => refresh(),
          child: ListView(padding: const EdgeInsets.all(16), children: [
            Text('${o.title} x${o.qty}', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 4),
            Text(rupiah(o.amount), style: Theme.of(context).textTheme.headlineSmall),
            if (o.role == 'seller' && o.fee != null) Text('Komisi PaceTara ${rupiah(o.fee!)} · kamu menerima ${rupiah(o.sellerReceives!)} di akun Xendit'),
            const SizedBox(height: 8),
            Text(o.statusLabel, key: const Key('order-status')),
            Text('${o.role == 'buyer' ? 'Penjual' : 'Pembeli'}: ${o.counterpartName}'),
            if (o.trackingNote != null) Text('Resi/catatan kirim: ${o.trackingNote}'),
            if (o.resolutionNote != null) Text('Keputusan tim: ${o.resolutionNote}'),
            const SizedBox(height: 16),
            if (o.role == 'buyer' && o.status == 'pending') ...[
              if (o.invoiceUrl != null) AsyncButton(label: 'Bayar sekarang', onPressed: () => openExternal(context, o.invoiceUrl!)),
              const SizedBox(height: 8),
              AsyncButton(label: 'Batalkan pesanan', outlined: true, onPressed: () async {
                await repo.cancel(o.id);
                refresh();
              }),
            ],
            if (o.role == 'buyer' && (o.status == 'paid' || o.status == 'shipped')) ...[
              AsyncButton(key: const Key('order-complete'), label: 'Barang sudah diterima', onPressed: () async {
                if (await confirm(context, title: 'Barang sudah diterima?', message: 'Pesanan selesai dan tidak bisa diajukan sengketa lagi.', action: 'Ya, selesai')) {
                  await repo.complete(o.id);
                  refresh();
                }
              }),
              const SizedBox(height: 8),
              AsyncButton(label: 'Ajukan sengketa', outlined: true, onPressed: () async {
                final reason = await _askText(context, 'Ajukan sengketa', 'Jelaskan masalahnya (min. 10 karakter)');
                if (reason == null) return;
                await repo.dispute(o.id, reason);
                refresh();
              }),
            ],
            if (o.role == 'seller' && o.status == 'paid')
              AsyncButton(key: const Key('order-ship'), label: 'Tandai sudah dikirim', onPressed: () async {
                final note = await _askText(context, 'Tandai dikirim', 'Nomor resi atau catatan (opsional)', optional: true);
                if (note == null) return;
                await repo.ship(o.id, note.isEmpty ? null : note);
                refresh();
              }),
            if (o.counterpartId != null && o.listingId != null && o.role == 'buyer') ...[
              const SizedBox(height: 8),
              TextButton(onPressed: () => context.push('/market/listings/${o.listingId}'), child: const Text('Lihat listing')),
            ],
          ]),
        ),
      ),
    );
  }

  Future<String?> _askText(BuildContext context, String title, String hint, {bool optional = false}) async {
    final c = TextEditingController();
    final res = await showDialog<String>(
      context: context,
      builder: (d) => AlertDialog(
        title: Text(title),
        content: TextField(controller: c, maxLength: optional ? 200 : 1000, maxLines: optional ? 1 : 4, decoration: InputDecoration(hintText: hint)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d), child: const Text('Batal')),
          FilledButton(
            onPressed: () {
              final v = c.text.trim();
              if (!optional && v.length < 10) return;
              Navigator.pop(d, v);
            },
            child: const Text('Kirim'),
          ),
        ],
      ),
    );
    c.dispose();
    return res;
  }
}
