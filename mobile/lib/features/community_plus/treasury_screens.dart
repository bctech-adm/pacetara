import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/api_error.dart';
import '../../core/widgets/common.dart';
import '../communities/widgets.dart';
import 'community_plus_repository.dart';
import 'models.dart';

/// Pemberitahuan "pencatatan saja" yang selalu tampil di kas dan jersey.
class RecordOnlyBanner extends StatelessWidget {
  const RecordOnlyBanner({super.key, required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Card(
      key: const Key('record-only'),
      margin: const EdgeInsets.all(16),
      color: scheme.tertiaryContainer,
      child: ListTile(leading: Icon(Icons.info_outline, color: scheme.onTertiaryContainer), title: Text(text, style: TextStyle(color: scheme.onTertiaryContainer))),
    );
  }
}

class _ProUpsell extends StatelessWidget {
  const _ProUpsell({required this.communityId, required this.isOwner, required this.feature});
  final String communityId;
  final bool isOwner;
  final String feature;

  @override
  Widget build(BuildContext context) => ListTile(
        leading: const Icon(Icons.workspace_premium_outlined),
        title: Text('$feature khusus Komunitas Pro'),
        subtitle: const Text('Catatan lama tetap bisa dibaca. Menambah catatan butuh Komunitas Pro.'),
        trailing: isOwner ? const Icon(Icons.chevron_right) : null,
        onTap: isOwner ? () => context.push('/subscription/community/$communityId') : null,
      );
}

/// Kas komunitas: semua anggota melihat saldo dan catatan; admin (Pro) menulis.
class CashScreen extends ConsumerWidget {
  const CashScreen({super.key, required this.communityId, this.isOwner = false});
  final String communityId;
  final bool isOwner;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final book = ref.watch(cashProvider(communityId));
    final canWrite = book.value?.canWrite ?? false;
    return Scaffold(
      appBar: AppBar(title: const Text('Kas komunitas')),
      floatingActionButton: canWrite
          ? FloatingActionButton.extended(
              key: const Key('add-cash'),
              icon: const Icon(Icons.add),
              label: const Text('Catat'),
              onPressed: () async {
                final ok = await showModalBottomSheet<bool>(context: context, isScrollControlled: true, builder: (_) => _CashForm(communityId: communityId));
                if (ok == true) ref.invalidate(cashProvider(communityId));
              },
            )
          : null,
      body: book.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text(ApiError.from(e).message)),
        data: (b) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(cashProvider(communityId)),
          child: ListView(padding: const EdgeInsets.only(bottom: 96), children: [
            RecordOnlyBanner(text: b.notice),
            if (!b.proActive) _ProUpsell(communityId: communityId, isOwner: isOwner, feature: 'Kas komunitas'),
            ListTile(
              title: const Text('Saldo'),
              trailing: Text(rupiah(b.balance), key: const Key('cash-balance'), style: Theme.of(context).textTheme.titleLarge),
              subtitle: Text('Masuk ${rupiah(b.totalIn)} · Keluar ${rupiah(b.totalOut)}'),
            ),
            const Divider(),
            if (b.items.isEmpty) const Padding(padding: EdgeInsets.all(32), child: Center(child: Text('Belum ada catatan kas'))),
            for (final e in b.items)
              ListTile(
                leading: Icon(e.kind == 'in' ? Icons.south_west : Icons.north_east, color: e.kind == 'in' ? Colors.green : Colors.red),
                title: Text(e.description.isEmpty ? cashCategories[e.category] ?? e.category : e.description),
                subtitle: Text('${e.occurredOn} · ${cashCategories[e.category] ?? e.category}${e.recordedBy == null ? '' : ' · dicatat ${e.recordedBy}'}'),
                trailing: Text('${e.kind == 'in' ? '+' : '-'}${rupiah(e.amount)}'),
                onLongPress: !b.canWrite
                    ? null
                    : () async {
                        if (!await confirm(context, title: 'Hapus catatan?', message: 'Catatan kas ini dihapus.', action: 'Hapus', destructive: true)) return;
                        if (!context.mounted) return;
                        final ok = await runCommunityAction(context, () => ref.read(communityPlusRepositoryProvider).deleteCash(communityId, e.id));
                        if (ok) ref.invalidate(cashProvider(communityId));
                      },
              ),
          ]),
        ),
      ),
    );
  }
}

class _CashForm extends ConsumerStatefulWidget {
  const _CashForm({required this.communityId});
  final String communityId;

  @override
  ConsumerState<_CashForm> createState() => _CashFormState();
}

class _CashFormState extends ConsumerState<_CashForm> {
  String _kind = 'in';
  String _category = 'iuran';
  final _amount = TextEditingController();
  final _desc = TextEditingController();
  DateTime _date = DateTime.now();

  @override
  void dispose() {
    _amount.dispose();
    _desc.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final d = '${_date.year}-${_date.month.toString().padLeft(2, '0')}-${_date.day.toString().padLeft(2, '0')}';
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 16, 16, MediaQuery.of(context).viewInsets.bottom + 16),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        SegmentedButton<String>(
          segments: const [ButtonSegment(value: 'in', label: Text('Pemasukan')), ButtonSegment(value: 'out', label: Text('Pengeluaran'))],
          selected: {_kind},
          onSelectionChanged: (v) => setState(() => _kind = v.first),
        ),
        TextField(
          controller: _amount,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          decoration: const InputDecoration(labelText: 'Nominal (Rp, tanpa titik)'),
        ),
        DropdownButtonFormField<String>(
          initialValue: _category,
          decoration: const InputDecoration(labelText: 'Kategori'),
          items: [for (final e in cashCategories.entries) DropdownMenuItem(value: e.key, child: Text(e.value))],
          onChanged: (v) => setState(() => _category = v ?? _category),
        ),
        ListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Tanggal'),
          subtitle: Text(d),
          onTap: () async {
            final p = await showDatePicker(context: context, firstDate: DateTime(2020), lastDate: DateTime.now().add(const Duration(days: 365)), initialDate: _date);
            if (p != null) setState(() => _date = p);
          },
        ),
        TextField(controller: _desc, maxLength: 200, decoration: const InputDecoration(labelText: 'Keterangan')),
        AsyncButton(
          label: 'Simpan',
          onPressed: () async {
            final amount = int.tryParse(_amount.text);
            if (amount == null || amount <= 0) throw const ApiError(0, 'invalid_input', 'Isi nominal');
            await ref.read(communityPlusRepositoryProvider).addCash(widget.communityId, {
              'kind': _kind,
              'amount': amount,
              'category': _category,
              'occurredOn': d,
              if (_desc.text.trim().isNotEmpty) 'description': _desc.text.trim(),
            });
            if (context.mounted) Navigator.pop(context, true);
          },
        ),
      ]),
    );
  }
}

/// Pre-order jersey: admin (Pro) membuat item dan menandai lunas; anggota mencatat pesanannya.
class JerseyScreen extends ConsumerWidget {
  const JerseyScreen({super.key, required this.communityId, this.isOwner = false});
  final String communityId;
  final bool isOwner;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final board = ref.watch(jerseyProvider(communityId));
    final canManage = board.value?.canManage ?? false;
    return Scaffold(
      appBar: AppBar(title: const Text('Pre-order jersey')),
      floatingActionButton: canManage
          ? FloatingActionButton.extended(
              icon: const Icon(Icons.add),
              label: const Text('Item'),
              onPressed: () async {
                final ok = await showModalBottomSheet<bool>(context: context, isScrollControlled: true, builder: (_) => _JerseyForm(communityId: communityId));
                if (ok == true) ref.invalidate(jerseyProvider(communityId));
              },
            )
          : null,
      body: board.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text(ApiError.from(e).message)),
        data: (b) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(jerseyProvider(communityId)),
          child: ListView(padding: const EdgeInsets.only(bottom: 96), children: [
            RecordOnlyBanner(text: b.notice),
            if (!b.proActive) _ProUpsell(communityId: communityId, isOwner: isOwner, feature: 'Pre-order jersey'),
            if (b.items.isEmpty) const Padding(padding: EdgeInsets.all(32), child: Center(child: Text('Belum ada pre-order'))),
            for (final item in b.items) _JerseyCard(communityId: communityId, item: item, canManage: b.canManage),
          ]),
        ),
      ),
    );
  }
}

class _JerseyCard extends ConsumerWidget {
  const _JerseyCard({required this.communityId, required this.item, required this.canManage});
  final String communityId;
  final JerseyItem item;
  final bool canManage;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final repo = ref.read(communityPlusRepositoryProvider);
    void refresh() => ref.invalidate(jerseyProvider(communityId));
    final d = item.orderDeadline.toLocal();
    return Card(
      margin: const EdgeInsets.fromLTRB(16, 8, 16, 0),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(item.name, style: Theme.of(context).textTheme.titleMedium),
          Text('${rupiah(item.price)} · ${item.open ? 'Dibuka sampai ${d.day}/${d.month}/${d.year}' : 'Ditutup'}'),
          if (item.description.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text(item.description)),
          const SizedBox(height: 8),
          Text('Dipesan: ${item.totals.entries.map((e) => '${e.key} ${e.value}').join(' · ')} (total ${item.totalQuantity}${item.paidQuantity == null ? '' : ', lunas ${item.paidQuantity}'})'),
          for (final o in item.myOrders)
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              leading: Icon(o.paid ? Icons.check_circle : Icons.pending_outlined, color: o.paid ? Colors.green : null),
              title: Text('Pesananku: ${o.size} × ${o.quantity}'),
              subtitle: Text(o.paid ? 'Lunas (ditandai admin)' : 'Belum ditandai lunas'),
              trailing: !o.paid && item.open
                  ? IconButton(
                      tooltip: 'Batalkan',
                      icon: const Icon(Icons.close),
                      onPressed: () async {
                        if (await runCommunityAction(context, () => repo.cancelOrder(o.id))) refresh();
                      },
                    )
                  : null,
            ),
          Wrap(spacing: 8, children: [
            if (item.open)
              FilledButton.tonal(
                onPressed: () async {
                  final ok = await showModalBottomSheet<bool>(context: context, builder: (_) => _OrderSheet(item: item));
                  if (ok == true) refresh();
                },
                child: const Text('Pesan'),
              ),
            if (canManage)
              OutlinedButton(
                onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => _OrdersScreen(item: item))).then((_) => refresh()),
                child: const Text('Semua pesanan'),
              ),
            if (canManage && item.open)
              TextButton(
                onPressed: () async {
                  if (await runCommunityAction(context, () => repo.closeJersey(item.id))) refresh();
                },
                child: const Text('Tutup pre-order'),
              ),
          ]),
        ]),
      ),
    );
  }
}

class _OrderSheet extends ConsumerStatefulWidget {
  const _OrderSheet({required this.item});
  final JerseyItem item;

  @override
  ConsumerState<_OrderSheet> createState() => _OrderSheetState();
}

class _OrderSheetState extends ConsumerState<_OrderSheet> {
  late String _size = widget.item.sizes.first;
  int _qty = 1;
  final _note = TextEditingController();

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 16, 16, MediaQuery.of(context).viewInsets.bottom + 16),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Wrap(spacing: 8, children: [
          for (final s in widget.item.sizes) ChoiceChip(label: Text(s), selected: _size == s, onSelected: (_) => setState(() => _size = s)),
        ]),
        Row(children: [
          const Text('Jumlah'),
          IconButton(onPressed: _qty > 1 ? () => setState(() => _qty--) : null, icon: const Icon(Icons.remove)),
          Text('$_qty'),
          IconButton(onPressed: _qty < 20 ? () => setState(() => _qty++) : null, icon: const Icon(Icons.add)),
        ]),
        TextField(controller: _note, maxLength: 200, decoration: const InputDecoration(labelText: 'Catatan (mis. nama punggung)')),
        const Text('Pembayaran dilakukan di luar aplikasi, langsung ke admin komunitas.', style: TextStyle(fontSize: 12)),
        const SizedBox(height: 8),
        AsyncButton(
          label: 'Catat pesanan',
          onPressed: () async {
            await ref.read(communityPlusRepositoryProvider).orderJersey(widget.item.id, _size, _qty, _note.text.trim());
            if (context.mounted) Navigator.pop(context, true);
          },
        ),
      ]),
    );
  }
}

class _OrdersScreen extends ConsumerStatefulWidget {
  const _OrdersScreen({required this.item});
  final JerseyItem item;

  @override
  ConsumerState<_OrdersScreen> createState() => _OrdersScreenState();
}

class _OrdersScreenState extends ConsumerState<_OrdersScreen> {
  late Future<List<JerseyOrder>> _future = ref.read(communityPlusRepositoryProvider).jerseyOrders(widget.item.id);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.item.name)),
      body: FutureBuilder<List<JerseyOrder>>(
        future: _future,
        builder: (context, snap) {
          if (snap.hasError) return Center(child: Text(ApiError.from(snap.error!).message));
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          return ListView(children: [
            for (final o in snap.data!)
              CheckboxListTile(
                value: o.paid,
                title: Text('${o.userName ?? 'Pengguna dihapus'} · ${o.size} × ${o.quantity}'),
                subtitle: Text([if (o.note.isNotEmpty) o.note, o.paid ? 'Lunas' : 'Belum lunas'].join(' · ')),
                onChanged: (v) async {
                  final ok = await runCommunityAction(context, () => ref.read(communityPlusRepositoryProvider).markPaid(o.id, v ?? false));
                  if (ok) setState(() => _future = ref.read(communityPlusRepositoryProvider).jerseyOrders(widget.item.id));
                },
              ),
          ]);
        },
      ),
    );
  }
}

class _JerseyForm extends ConsumerStatefulWidget {
  const _JerseyForm({required this.communityId});
  final String communityId;

  @override
  ConsumerState<_JerseyForm> createState() => _JerseyFormState();
}

class _JerseyFormState extends ConsumerState<_JerseyForm> {
  final _name = TextEditingController();
  final _price = TextEditingController();
  final _sizes = TextEditingController(text: 'S, M, L, XL');
  final _desc = TextEditingController();
  DateTime _deadline = DateTime.now().add(const Duration(days: 14));

  @override
  void dispose() {
    for (final c in [_name, _price, _sizes, _desc]) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 16, 16, MediaQuery.of(context).viewInsets.bottom + 16),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        TextField(controller: _name, maxLength: 80, decoration: const InputDecoration(labelText: 'Nama item')),
        TextField(
          controller: _price,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          decoration: const InputDecoration(labelText: 'Harga (Rp)'),
        ),
        TextField(controller: _sizes, decoration: const InputDecoration(labelText: 'Ukuran (pisahkan dengan koma)')),
        TextField(controller: _desc, maxLength: 500, decoration: const InputDecoration(labelText: 'Keterangan')),
        ListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Batas waktu pesan'),
          subtitle: Text('${_deadline.day}/${_deadline.month}/${_deadline.year}'),
          onTap: () async {
            final d = await showDatePicker(context: context, firstDate: DateTime.now(), lastDate: DateTime.now().add(const Duration(days: 365)), initialDate: _deadline);
            if (d != null) setState(() => _deadline = DateTime(d.year, d.month, d.day, 23, 59));
          },
        ),
        AsyncButton(
          label: 'Buat pre-order',
          onPressed: () async {
            final sizes = _sizes.text.split(',').map((s) => s.trim()).where((s) => s.isNotEmpty).toSet().toList();
            await ref.read(communityPlusRepositoryProvider).createJersey(widget.communityId, {
              'name': _name.text.trim(),
              'price': int.tryParse(_price.text) ?? 0,
              'sizes': sizes,
              'orderDeadline': _deadline.toUtc().toIso8601String(),
              if (_desc.text.trim().isNotEmpty) 'description': _desc.text.trim(),
            });
            if (context.mounted) Navigator.pop(context, true);
          },
        ),
      ]),
    );
  }
}
