import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api/api_error.dart';
import '../../core/widgets/common.dart';
import '../auth/auth_controller.dart';
import '../auth/screens/privacy_consent.dart';
import '../runs/runs_repository.dart';
import '../runs/screens/runs_list_screen.dart';
import 'health_connect_mapping.dart';
import 'health_connect_source.dart';
import 'imports_repository.dart';
import 'strava_brand.dart';

String _fmtDate(DateTime d) =>
    '${d.day.toString().padLeft(2, '0')}/${d.month.toString().padLeft(2, '0')}/${d.year} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';

/// Ringkasan hasil impor Health Connect untuk ditampilkan.
@visibleForTesting
String importSummary(Map<String, int> counts) {
  final parts = <String>[];
  final imported = (counts['imported'] ?? 0) + (counts['updated'] ?? 0);
  if (imported > 0) parts.add('$imported lari diimpor');
  if ((counts['duplicate'] ?? 0) > 0) parts.add('${counts['duplicate']} sudah ada (dilewati)');
  if ((counts['already_imported'] ?? 0) > 0) parts.add('${counts['already_imported']} sudah pernah diimpor');
  if ((counts['skipped'] ?? 0) > 0) parts.add('${counts['skipped']} data tidak wajar (dilewati)');
  if ((counts['failed'] ?? 0) > 0) parts.add('${counts['failed']} gagal, coba lagi nanti');
  return parts.isEmpty ? 'Tidak ada lari yang diimpor' : parts.join(', ');
}

/// Layar "Impor data lari": Health Connect (di HP), Garmin dan Strava (OAuth, hanya jika server mengaktifkannya).
class ImportsScreen extends ConsumerStatefulWidget {
  const ImportsScreen({super.key, this.completeProvider, this.completeCode});

  /// Dari deep link halaman callback OAuth (`pacetara://app/imports?provider=..&complete=..`): kode sekali pakai
  /// untuk menyelesaikan penautan dengan akun yang sedang login. Server menolak jika akun ini bukan yang memulai.
  final String? completeProvider;
  final String? completeCode;

  @override
  ConsumerState<ImportsScreen> createState() => _ImportsScreenState();
}

class _ImportsScreenState extends ConsumerState<ImportsScreen> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final provider = widget.completeProvider;
    final code = widget.completeCode;
    if (code != null && (provider == 'garmin' || provider == 'strava')) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _complete(provider!, code));
    }
  }

  Future<void> _complete(String provider, String code) async {
    try {
      await ref.read(importsRepositoryProvider).complete(provider, code);
      if (!mounted) return;
      showInfo(
        context,
        provider == 'garmin'
            ? 'Akun Garmin terhubung. Lari baru dari Garmin akan masuk otomatis.'
            : 'Akun Strava terhubung. Lari 30 hari terakhir sedang diimpor sebagai riwayat pribadi.',
      );
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      ref.invalidate(importStatusProvider);
    }
    // Buang kode dari lokasi agar tidak dipakai ulang saat layar dibangun ulang.
    if (mounted) context.replace('/imports');
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  // Kembali dari browser setelah OAuth: muat ulang status koneksi.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) ref.invalidate(importStatusProvider);
  }

  Future<void> _connect(String provider) async {
    final url = await ref.read(importsRepositoryProvider).connect(provider);
    await launchUrl(url, mode: LaunchMode.externalApplication);
  }

  Future<void> _disconnect(String provider, String label) async {
    var deleteRuns = false;
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setState) => AlertDialog(
          title: Text('Putuskan $label?'),
          content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Token akses $label dihapus dari server PaceTara dan izinnya dicabut. Lari baru tidak akan masuk lagi.'),
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              value: deleteRuns,
              onChanged: (v) => setState(() => deleteRuns = v ?? false),
              title: Text('Hapus juga semua lari dari $label'),
            ),
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Batal')),
            FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Putuskan')),
          ],
        ),
      ),
    );
    if (ok != true) return;
    try {
      final n = await ref.read(importsRepositoryProvider).disconnect(provider, deleteRuns: deleteRuns);
      ref.invalidate(importStatusProvider);
      ref.invalidate(myRunsProvider);
      if (mounted) showInfo(context, n > 0 ? '$label diputus, $n lari dihapus' : '$label diputus');
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _deleteHcRuns() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Hapus lari dari Health Connect?'),
        content: const Text('Semua lari yang diimpor dari Health Connect dihapus dari PaceTara. Data di Health Connect tidak berubah.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Batal')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Hapus')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      final n = await ref.read(importsRepositoryProvider).disconnect('health-connect', deleteRuns: true);
      ref.invalidate(importStatusProvider);
      ref.invalidate(myRunsProvider);
      if (mounted) showInfo(context, '$n lari dihapus');
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final status = ref.watch(importStatusProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Impor data lari')),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(importStatusProvider.future),
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const Text(
              'Lari dari aplikasi lain ditandai sumbernya. Lari yang waktunya sama dengan lari yang sudah ada '
              'tidak dihitung dua kali: rekaman PaceTara diutamakan, lalu Garmin, Health Connect, kemudian Strava.',
            ),
            const SizedBox(height: 16),
            Card(
              child: ListTile(
                leading: const Icon(Icons.favorite_outline),
                title: const Text('Health Connect'),
                subtitle: Text('Pilih lari dari Google Fit, Samsung Health, jam pintar, dll.'
                    '${status.value != null && status.value!.healthConnectRuns > 0 ? '\n${status.value!.healthConnectRuns} lari sudah diimpor' : ''}'),
                isThreeLine: status.value != null && status.value!.healthConnectRuns > 0,
                trailing: const Icon(Icons.chevron_right),
                onTap: () => context.push('/imports/health-connect'),
              ),
            ),
            if ((status.value?.healthConnectRuns ?? 0) > 0)
              Align(
                alignment: Alignment.centerRight,
                child: TextButton(
                  onPressed: _deleteHcRuns,
                  child: const Text('Hapus lari dari Health Connect'),
                ),
              ),
            ...switch (status) {
              AsyncData(:final value) => [
                  if (value.garmin.enabled)
                    _ProviderCard(
                      icon: Icons.watch_outlined,
                      label: 'Garmin',
                      status: value.garmin,
                      description: 'Lari baru dari jam Garmin masuk otomatis (tanpa riwayat lama). Bawaannya hanya terlihat olehmu.',
                      onConnect: () => _connect('garmin'),
                      onDisconnect: () => _disconnect('garmin', 'Garmin'),
                    ),
                  if (value.strava.enabled)
                    _ProviderCard(
                      icon: Icons.directions_run,
                      label: 'Strava',
                      status: value.strava,
                      description: 'Lari dari Strava hanya menjadi riwayat pribadimu: tidak tampil di feed, komunitas, '
                          'papan peringkat, atau lencana yang dilihat orang lain.',
                      onConnect: () => _connect('strava'),
                      connectButton: StravaConnectButton(onPressed: () => _connect('strava')),
                      footer: const PoweredByStrava(),
                      onDisconnect: () => _disconnect('strava', 'Strava'),
                      onSync: () async {
                        await ref.read(importsRepositoryProvider).syncStrava();
                        if (context.mounted) showInfo(context, 'Sinkronisasi dimulai. Lari baru muncul dalam beberapa saat');
                      },
                    ),
                ],
              AsyncError(:final error) => [Padding(padding: const EdgeInsets.all(16), child: Text(ApiError.from(error).message))],
              _ => [const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()))],
            },
          ],
        ),
      ),
    );
  }
}

class _ProviderCard extends StatelessWidget {
  const _ProviderCard({
    required this.icon,
    required this.label,
    required this.status,
    required this.description,
    required this.onConnect,
    required this.onDisconnect,
    this.onSync,
    this.connectButton,
    this.footer,
  });
  final IconData icon;
  final String label;
  final ProviderStatus status;
  final String description;
  final Future<void> Function() onConnect;
  final Future<void> Function() onDisconnect;
  final Future<void> Function()? onSync;

  /// Tombol hubungkan khusus penyedia (mis. tombol resmi "Connect with Strava"); bawaan tombol teks.
  final Widget? connectButton;

  /// Atribusi penyedia di bawah kartu (mis. "Powered by Strava").
  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    final s = status;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Icon(icon),
            const SizedBox(width: 12),
            Expanded(child: Text(label, style: Theme.of(context).textTheme.titleMedium)),
            if (s.connected) const Chip(label: Text('Terhubung')),
          ]),
          const SizedBox(height: 8),
          Text(description),
          if (s.connected) ...[
            const SizedBox(height: 8),
            Text(
              [
                if (s.connectedAt != null) 'Terhubung sejak ${_fmtDate(s.connectedAt!)}',
                s.lastSyncAt != null ? 'Terakhir sinkron ${_fmtDate(s.lastSyncAt!)}' : 'Belum ada lari yang masuk',
                '${s.runs} lari dari $label',
              ].join('\n'),
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 12),
            if (onSync != null) ...[AsyncButton(label: 'Sinkronkan sekarang', onPressed: onSync), const SizedBox(height: 8)],
            AsyncButton(label: 'Putuskan sambungan', outlined: true, onPressed: onDisconnect),
          ] else ...[
            const SizedBox(height: 12),
            connectButton ?? AsyncButton(label: 'Hubungkan $label', onPressed: onConnect),
            const SizedBox(height: 4),
            Text(
              'Halaman masuk $label terbuka di browser. Setelah memberi izin, tekan "Selesaikan di PaceTara" untuk kembali ke aplikasi ini.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
          if (footer != null) ...[const SizedBox(height: 12), footer!],
        ]),
      ),
    );
  }
}

final _hcSourceProvider = Provider<HealthConnectSource>((ref) => HealthConnectSource());

enum _HcStep { checking, unavailable, needsUpdate, permission, loading, ready, importing, done, error }

/// Pilih dan impor sesi lari dari Health Connect (30 hari terakhir).
class HealthConnectImportScreen extends ConsumerStatefulWidget {
  const HealthConnectImportScreen({super.key});

  @override
  ConsumerState<HealthConnectImportScreen> createState() => _HealthConnectImportScreenState();
}

class _HealthConnectImportScreenState extends ConsumerState<HealthConnectImportScreen> {
  _HcStep _step = _HcStep.checking;
  List<HcRunSession> _sessions = const [];
  Set<String> _known = {};
  final Set<String> _selected = {};
  RunVisibility _visibility = RunVisibility.community;
  int _progress = 0;
  String _summary = '';

  @override
  void initState() {
    super.initState();
    _start();
  }

  HealthConnectSource get _source => ref.read(_hcSourceProvider);

  Future<void> _start() async {
    setState(() => _step = _HcStep.checking);
    try {
      final a = await _source.availability();
      if (a == HcAvailability.notInstalled) return setState(() => _step = _HcStep.unavailable);
      if (a == HcAvailability.needsUpdate) return setState(() => _step = _HcStep.needsUpdate);
      if (!await _source.hasPermissions()) return setState(() => _step = _HcStep.permission);
      await _load();
    } catch (_) {
      if (mounted) setState(() => _step = _HcStep.error);
    }
  }

  Future<void> _requestPermission() async {
    final ok = await _source.requestPermissions();
    if (!mounted) return;
    if (ok) {
      await _load();
    } else {
      showInfo(context, 'Izin Health Connect belum diberikan');
    }
  }

  Future<void> _load() async {
    setState(() => _step = _HcStep.loading);
    final sessions = await _source.runSessions();
    final known = await ref.read(importsRepositoryProvider).known(sessions.map((s) => s.id).toList());
    if (!mounted) return;
    setState(() {
      _sessions = sessions;
      _known = known;
      _selected
        ..clear()
        ..addAll(sessions.where((s) => !known.contains(s.id)).map((s) => s.id));
      _step = _HcStep.ready;
    });
  }

  Future<void> _import() async {
    final repo = ref.read(importsRepositoryProvider);
    final chosen = _sessions.where((s) => _selected.contains(s.id)).toList();
    final counts = <String, int>{};
    setState(() {
      _step = _HcStep.importing;
      _progress = 0;
    });
    // Satu sesi per permintaan (rute bisa ribuan titik; batas body 1 MB).
    for (final s in chosen) {
      try {
        final r = await repo.importHealthConnect(sessionToBody(s, _visibility.name));
        counts[r.status] = (counts[r.status] ?? 0) + 1;
      } catch (_) {
        counts['failed'] = (counts['failed'] ?? 0) + 1;
      }
      if (mounted) setState(() => _progress++);
    }
    ref.invalidate(myRunsProvider);
    ref.invalidate(importStatusProvider);
    if (mounted) {
      setState(() {
        _summary = importSummary(counts);
        _step = _HcStep.done;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Health Connect')),
      body: switch (_step) {
        _HcStep.checking || _HcStep.loading => const Center(child: CircularProgressIndicator()),
        _HcStep.unavailable || _HcStep.needsUpdate => _Message(
            text: _step == _HcStep.unavailable
                ? 'Health Connect belum terpasang di HP ini. Pasang dari Play Store, lalu kembali ke sini.'
                : 'Health Connect perlu diperbarui dulu.',
            action: 'Buka Play Store',
            onAction: () async {
              await _source.install();
            },
            secondary: 'Periksa lagi',
            onSecondary: _start,
          ),
        _HcStep.permission => _Message(
            text: 'PaceTara perlu izin membaca sesi olahraga, jarak, kalori, langkah, dan rute dari Health Connect. '
                'Data hanya dibaca saat kamu memilih untuk mengimpor, tidak pernah di latar belakang, dan PaceTara '
                'tidak menulis apa pun ke Health Connect.',
            action: 'Izinkan akses',
            onAction: _requestPermission,
            secondary: 'Tentang data yang dibaca',
            onSecondary: () async {
              context.push('/imports/health-connect/about');
            },
          ),
        _HcStep.error => _Message(text: 'Gagal membaca Health Connect.', action: 'Coba lagi', onAction: _start),
        _HcStep.importing => Center(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              const CircularProgressIndicator(),
              const SizedBox(height: 16),
              Text('Mengimpor $_progress dari ${_selected.length}…'),
            ]),
          ),
        _HcStep.done => _Message(
            text: _summary,
            action: 'Lihat riwayat lari',
            onAction: () async {
              context.pushReplacement('/runs');
            },
          ),
        _HcStep.ready => _buildList(context),
      },
    );
  }

  Widget _buildList(BuildContext context) {
    if (_sessions.isEmpty) {
      return _Message(text: 'Tidak ada sesi lari di Health Connect dalam 30 hari terakhir.', action: 'Muat ulang', onAction: _load);
    }
    final needsConsent = _sessions.any((s) => s.routeNeedsConsent);
    return Column(children: [
      Expanded(
        child: ListView(children: [
          if (needsConsent)
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 12, 16, 0),
              child: Text(
                'Rute dari aplikasi lain butuh izin tambahan: buka Health Connect → Izin aplikasi → PaceTara → '
                'Rute olahraga → Selalu izinkan. Tanpa rute, hanya statistik yang diimpor (tidak diverifikasi GPS).',
              ),
            ),
          for (final s in _sessions)
            CheckboxListTile(
              value: _known.contains(s.id) ? false : _selected.contains(s.id),
              onChanged: _known.contains(s.id) ? null : (v) => setState(() => v == true ? _selected.add(s.id) : _selected.remove(s.id)),
              title: Text('${_fmtDate(s.start)} · ${s.distanceM != null ? '${(s.distanceM! / 1000).toStringAsFixed(2)} km' : '${s.duration.inMinutes} menit'}'),
              subtitle: Text([
                originLabel(s.origin),
                if (s.treadmill) 'treadmill',
                if (s.route.isNotEmpty) 'dengan rute' else if (s.routeNeedsConsent) 'rute butuh izin' else 'tanpa rute',
                if (s.fromStrava) 'hanya untukmu',
                if (_known.contains(s.id)) 'sudah diimpor',
              ].join(' · ')),
            ),
        ]),
      ),
      SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            DropdownButtonFormField<RunVisibility>(
              initialValue: _visibility,
              decoration: const InputDecoration(labelText: 'Siapa yang bisa melihat', border: OutlineInputBorder()),
              items: [for (final v in RunVisibility.values) DropdownMenuItem(value: v, child: Text(visibilityText(v)))],
              onChanged: (v) => setState(() => _visibility = v ?? _visibility),
            ),
            const SizedBox(height: 12),
            AsyncButton(label: 'Impor ${_selected.length} lari', onPressed: _selected.isEmpty ? null : _import),
          ]),
        ),
      ),
    ]);
  }
}

class _Message extends StatelessWidget {
  const _Message({required this.text, required this.action, required this.onAction, this.secondary, this.onSecondary});
  final String text;
  final String action;
  final Future<void> Function() onAction;
  final String? secondary;
  final Future<void> Function()? onSecondary;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Text(text, textAlign: TextAlign.center),
          const SizedBox(height: 16),
          AsyncButton(label: action, onPressed: onAction),
          if (secondary != null) ...[const SizedBox(height: 8), AsyncButton(label: secondary!, outlined: true, onPressed: onSecondary)],
        ]),
      ),
    );
  }
}

/// Penjelasan pemakaian data Health Connect (dibuka juga oleh Health Connect lewat intent
/// ACTION_SHOW_PERMISSIONS_RATIONALE / VIEW_PERMISSION_USAGE), dengan tautan kebijakan privasi.
class HealthConnectAboutScreen extends ConsumerWidget {
  const HealthConnectAboutScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final config = ref.watch(authConfigProvider).value;
    return Scaffold(
      appBar: AppBar(title: const Text('Data Health Connect')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        const Text(
          'PaceTara membaca dari Health Connect hanya saat kamu membuka layar impor dan memilih lari:\n\n'
          '• sesi olahraga lari (waktu mulai dan selesai, aplikasi asal);\n'
          '• jarak, kalori, dan langkah selama sesi itu (dibutuhkan untuk ringkasan sesi);\n'
          '• rute GPS sesi, jika ada dan kamu mengizinkannya.\n\n'
          'Lari yang kamu pilih dikirim ke server PaceTara lewat koneksi terenkripsi. Rute disimpan terenkripsi, '
          'titik awal dan akhirnya disembunyikan dari orang lain (zona privasi), dan visibilitasnya kamu tentukan. '
          'Lari dari Strava selalu hanya untukmu. PaceTara tidak menulis ke Health Connect, tidak membaca di latar '
          'belakang, dan tidak memakai data ini untuk iklan.\n\n'
          'Izin bisa dicabut kapan saja di Health Connect. Lari yang sudah diimpor bisa dihapus dari riwayat, atau '
          'sekaligus lewat Profil → Impor data lari.',
        ),
        const SizedBox(height: 16),
        if (config != null) OutlinedButton(onPressed: () => openPrivacyPolicy(config), child: const Text('Baca kebijakan privasi')),
      ]),
    );
  }
}
