import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api/api_error.dart';
import '../../core/widgets/common.dart';
import 'safety_repository.dart';

typedef SosLocation = ({double lat, double lng, double? accuracyM});

// ---------- Kontak darurat ----------

class EmergencyContactsScreen extends ConsumerStatefulWidget {
  const EmergencyContactsScreen({super.key});

  @override
  ConsumerState<EmergencyContactsScreen> createState() => _EmergencyContactsScreenState();
}

class _EmergencyContactsScreenState extends ConsumerState<EmergencyContactsScreen> {
  final _name = TextEditingController();
  final _phone = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    super.dispose();
  }

  Future<void> _add() async {
    if (_name.text.trim().isEmpty || _phone.text.trim().isEmpty) {
      setState(() => _error = 'Isi nama dan nomor HP');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(safetyRepositoryProvider).add(_name.text.trim(), _phone.text.trim());
      _name.clear();
      _phone.clear();
      ref.invalidate(emergencyContactsProvider);
    } on ApiError catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final list = ref.watch(emergencyContactsProvider);
    final theme = Theme.of(context);
    final items = list.value ?? const <EmergencyContact>[];
    return Scaffold(
      appBar: AppBar(title: const Text('Kontak darurat')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        const Text(
          'Saat kamu menekan SOS ketika merekam lari, lokasimu dikirim ke kontak ini lewat WhatsApp dari nomor PaceTara. '
          'Kamu juga bisa mengirimnya lewat SMS dari HP-mu, yang tetap berfungsi tanpa internet.',
        ),
        const SizedBox(height: 8),
        Text('Beri tahu mereka bahwa kamu memilihnya sebagai kontak darurat. Maksimal 3 kontak. Gratis.', style: theme.textTheme.bodySmall),
        const SizedBox(height: 16),
        if (list.isLoading) const Center(child: CircularProgressIndicator()),
        if (list.hasError) Text(ApiError.from(list.error!).message, style: TextStyle(color: theme.colorScheme.error)),
        for (final c in items)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const CircleAvatar(child: Icon(Icons.contact_phone_outlined)),
            title: Text(c.name),
            subtitle: Text(c.phone),
            trailing: IconButton(
              key: Key('remove-${c.id}'),
              tooltip: 'Hapus',
              icon: const Icon(Icons.delete_outline),
              onPressed: () async {
                try {
                  await ref.read(safetyRepositoryProvider).remove(c.id);
                  ref.invalidate(emergencyContactsProvider);
                } catch (e) {
                  if (context.mounted) showError(context, e);
                }
              },
            ),
          ),
        if (list.hasValue && items.length < 3) ...[
          const Divider(height: 32),
          Text('Tambah kontak', style: theme.textTheme.titleSmall),
          const SizedBox(height: 8),
          TextField(
            key: const Key('contact-name'),
            controller: _name,
            maxLength: 60,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'Nama', border: OutlineInputBorder()),
          ),
          TextField(
            key: const Key('contact-phone'),
            controller: _phone,
            keyboardType: TextInputType.phone,
            decoration: const InputDecoration(labelText: 'Nomor HP (WhatsApp)', hintText: '08…', border: OutlineInputBorder()),
          ),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_error!, style: TextStyle(color: theme.colorScheme.error))),
          const SizedBox(height: 12),
          FilledButton(key: const Key('contact-add'), onPressed: _busy ? null : _add, child: Text(_busy ? 'Menyimpan…' : 'Tambah')),
        ],
      ]),
    );
  }
}

// ---------- Tombol SOS ----------

/// Tombol SOS merah. [locate] memberi lokasi terkini (titik rekaman terakhir atau GPS).
class SosButton extends ConsumerWidget {
  const SosButton({super.key, required this.locate, required this.userName});
  final Future<SosLocation?> Function() locate;
  final String userName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: FilledButton.icon(
        key: const Key('sos-button'),
        style: FilledButton.styleFrom(backgroundColor: scheme.error, foregroundColor: scheme.onError, visualDensity: VisualDensity.compact),
        onPressed: () => showModalBottomSheet<void>(
          context: context,
          isDismissible: false,
          enableDrag: false,
          isScrollControlled: true,
          builder: (_) => SosSheet(locate: locate, userName: userName),
        ),
        icon: const Icon(Icons.sos),
        label: const Text('SOS'),
      ),
    );
  }
}

enum _SosStage { countdown, sending, done, noContacts }

/// Hitung mundur 5 detik (bisa dibatalkan, mencegah tertekan tidak sengaja), lalu kirim lewat server.
/// SMS cadangan dan telepon 112 selalu tersedia.
class SosSheet extends ConsumerStatefulWidget {
  const SosSheet({super.key, required this.locate, required this.userName, this.countdownSeconds = 5});
  final Future<SosLocation?> Function() locate;
  final String userName;
  final int countdownSeconds;

  @override
  ConsumerState<SosSheet> createState() => _SosSheetState();
}

class _SosSheetState extends ConsumerState<SosSheet> {
  _SosStage _stage = _SosStage.countdown;
  late int _left = widget.countdownSeconds;
  Timer? _timer;
  List<EmergencyContact> _contacts = const [];
  SosLocation? _loc;
  String? _status;
  bool _cancelled = false;

  @override
  void initState() {
    super.initState();
    unawaited(_prepare());
  }

  Future<void> _prepare() async {
    // Kontak dan lokasi disiapkan selama hitung mundur.
    final repo = ref.read(safetyRepositoryProvider);
    final contacts = await repo.contactsForSos();
    if (!mounted) return;
    if (contacts.isEmpty) {
      setState(() => _stage = _SosStage.noContacts);
      return;
    }
    _contacts = contacts;
    unawaited(widget.locate().then((l) => _loc = l, onError: (_) => null));
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted || _cancelled) return t.cancel();
      setState(() => _left--);
      if (_left <= 0) {
        t.cancel();
        unawaited(_send());
      }
    });
    setState(() {});
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  /// Batal: hentikan hitung mundur lebih dulu, baru tutup lembar (SOS tidak boleh terkirim setelahnya).
  void _cancel() {
    _cancelled = true;
    _timer?.cancel();
    Navigator.pop(context);
  }

  Future<void> _send() async {
    if (_cancelled) return;
    _timer?.cancel();
    setState(() => _stage = _SosStage.sending);
    _loc ??= await widget.locate().catchError((_) => null);
    final loc = _loc;
    if (loc == null) {
      setState(() {
        _stage = _SosStage.done;
        _status = 'Lokasi tidak didapat. Kirim SMS atau telepon langsung.';
      });
      return;
    }
    try {
      final r = await ref.read(safetyRepositoryProvider).sos(lat: loc.lat, lng: loc.lng, accuracyM: loc.accuracyM);
      _status = r.rateLimited
          ? 'SOS baru saja dikirim. Kirim SMS atau telepon langsung.'
          : r.delivered == r.total
              ? 'Lokasimu terkirim lewat WhatsApp ke ${r.total} kontak darurat.'
              : 'Terkirim lewat WhatsApp ke ${r.delivered} dari ${r.total} kontak. Kirim juga lewat SMS.';
    } catch (e) {
      _status = 'Gagal mengirim lewat server (${ApiError.from(e).message}). Kirim lewat SMS.';
    }
    if (mounted) setState(() => _stage = _SosStage.done);
  }

  Future<void> _sms() async {
    final loc = _loc;
    final body = loc == null
        ? 'SOS dari ${widget.userName} (PaceTara): saya butuh bantuan saat berlari. Jika tidak bisa dihubungi, minta bantuan ke 112.'
        : sosSmsText(widget.userName, loc.lat, loc.lng);
    if (!await launchUrl(sosSmsUri(_contacts, body)) && mounted) showInfo(context, 'Tidak bisa membuka aplikasi SMS');
  }

  Future<void> _call112() => launchUrl(Uri.parse('tel:112'));

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 24, 24, 16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Icon(Icons.sos, size: 56, color: scheme.error),
          const SizedBox(height: 12),
          ...switch (_stage) {
            _SosStage.countdown => [
                Text('Mengirim SOS dalam $_left…', key: const Key('sos-countdown'), textAlign: TextAlign.center, style: theme.textTheme.headlineSmall),
                const SizedBox(height: 8),
                Text('Lokasimu akan dikirim ke ${_contacts.length} kontak darurat.', textAlign: TextAlign.center),
                const SizedBox(height: 16),
                FilledButton(
                  key: const Key('sos-now'),
                  style: FilledButton.styleFrom(backgroundColor: scheme.error, foregroundColor: scheme.onError, minimumSize: const Size.fromHeight(52)),
                  onPressed: _contacts.isEmpty ? null : _send,
                  child: const Text('Kirim sekarang'),
                ),
                const SizedBox(height: 8),
                OutlinedButton(key: const Key('sos-cancel'), onPressed: _cancel, child: const Text('Batal')),
              ],
            _SosStage.sending => [
                const Center(child: CircularProgressIndicator()),
                const SizedBox(height: 12),
                const Text('Mengirim lokasi…', textAlign: TextAlign.center),
              ],
            _SosStage.noContacts => [
                Text('Belum ada kontak darurat', textAlign: TextAlign.center, style: theme.textTheme.titleLarge),
                const SizedBox(height: 8),
                const Text('Tambahkan kontak darurat agar SOS bisa mengirim lokasimu. Dalam keadaan darurat, telepon 112.', textAlign: TextAlign.center),
                const SizedBox(height: 16),
                FilledButton.icon(onPressed: _call112, icon: const Icon(Icons.call), label: const Text('Telepon 112')),
                TextButton(
                  onPressed: () {
                    Navigator.pop(context);
                    unawaited(context.push('/settings/emergency-contacts'));
                  },
                  child: const Text('Atur kontak darurat'),
                ),
                TextButton(onPressed: () => Navigator.pop(context), child: const Text('Tutup')),
              ],
            _SosStage.done => [
                Text(_status ?? '', key: const Key('sos-status'), textAlign: TextAlign.center, style: theme.textTheme.titleMedium),
                const SizedBox(height: 16),
                FilledButton.icon(key: const Key('sos-sms'), onPressed: _sms, icon: const Icon(Icons.sms_outlined), label: const Text('Kirim juga lewat SMS')),
                const SizedBox(height: 8),
                OutlinedButton.icon(onPressed: _call112, icon: const Icon(Icons.call), label: const Text('Telepon 112')),
                TextButton(onPressed: () => Navigator.pop(context), child: const Text('Tutup')),
              ],
          },
        ]),
      ),
    );
  }
}
