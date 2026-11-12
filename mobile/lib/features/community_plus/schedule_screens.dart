import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:go_router/go_router.dart';
import 'package:mobile_scanner/mobile_scanner.dart' show MobileScanner;
import 'package:qr_flutter/qr_flutter.dart';

import '../../core/api/api_error.dart';
import '../../core/widgets/common.dart';
import '../communities/widgets.dart';
import '../feed/feed_screens.dart' show UserAvatar;
import 'community_plus_repository.dart';
import 'models.dart';
import 'point_picker.dart';

/// Jadwal lari komunitas: sesi mendatang + RSVP. Admin membuat jadwal rutin atau sesi sekali jalan.
/// Jadwal + RSVP gratis untuk semua komunitas; absensi QR/GPS khusus Komunitas Pro.
class SessionsScreen extends ConsumerWidget {
  const SessionsScreen({super.key, required this.communityId, this.isStaff = false, this.isOwner = false});
  final String communityId;
  final bool isStaff;
  final bool isOwner;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sessions = ref.watch(sessionsProvider(communityId));
    return Scaffold(
      appBar: AppBar(title: const Text('Jadwal lari')),
      floatingActionButton: isStaff
          ? FloatingActionButton.extended(
              key: const Key('new-session'),
              onPressed: () => _create(context, ref),
              icon: const Icon(Icons.add),
              label: const Text('Jadwal'),
            )
          : null,
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(sessionsProvider(communityId));
          ref.invalidate(schedulesProvider(communityId));
        },
        child: sessions.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => ListView(children: [const SizedBox(height: 120), Center(child: Text(ApiError.from(e).message))]),
          data: (data) => ListView(
            padding: const EdgeInsets.only(bottom: 96),
            children: [
              if (isStaff) _SchedulesSection(communityId: communityId),
              if (!data.attendanceEnabled)
                const ListTile(
                  leading: Icon(Icons.qr_code_2_outlined),
                  title: Text('Absensi QR / GPS'),
                  subtitle: Text('Tersedia untuk Komunitas Pro'),
                ),
              if (data.items.isEmpty)
                const Padding(padding: EdgeInsets.all(32), child: Center(child: Text('Belum ada sesi lari terjadwal'))),
              for (final s in data.items) SessionCard(session: s),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _create(BuildContext context, WidgetRef ref) async {
    final recurring = await showModalBottomSheet<bool>(
      context: context,
      builder: (sheet) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(leading: const Icon(Icons.repeat), title: const Text('Jadwal rutin mingguan'), onTap: () => Navigator.pop(sheet, true)),
          ListTile(leading: const Icon(Icons.event), title: const Text('Sesi sekali jalan'), onTap: () => Navigator.pop(sheet, false)),
        ]),
      ),
    );
    if (recurring == null || !context.mounted) return;
    final created = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => SessionFormScreen(communityId: communityId, recurring: recurring)));
    if (created == true) {
      ref.invalidate(sessionsProvider(communityId));
      ref.invalidate(schedulesProvider(communityId));
    }
  }
}

class _SchedulesSection extends ConsumerWidget {
  const _SchedulesSection({required this.communityId});
  final String communityId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(schedulesProvider(communityId)).value ?? const <RunSchedule>[];
    if (list.isEmpty) return const SizedBox.shrink();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Padding(padding: const EdgeInsets.fromLTRB(16, 12, 16, 4), child: Text('Jadwal rutin', style: Theme.of(context).textTheme.titleSmall)),
      for (final s in list)
        ListTile(
          leading: const Icon(Icons.repeat),
          title: Text(s.title),
          subtitle: Text('${s.label} · ${s.locationName}'),
          trailing: IconButton(
            tooltip: 'Hentikan jadwal',
            icon: const Icon(Icons.delete_outline),
            onPressed: () async {
              if (!await confirm(context, title: 'Hentikan jadwal?', message: 'Sesi mendatang dari jadwal ini dihapus. Sesi yang sudah lewat tetap.', action: 'Hentikan')) return;
              if (!context.mounted) return;
              final ok = await runCommunityAction(context, () => ref.read(communityPlusRepositoryProvider).deleteSchedule(communityId, s.id));
              if (ok) {
                ref.invalidate(schedulesProvider(communityId));
                ref.invalidate(sessionsProvider(communityId));
              }
            },
          ),
        ),
      const Divider(),
    ]);
  }
}

class SessionCard extends StatelessWidget {
  const SessionCard({super.key, required this.session});
  final RunSession session;

  @override
  Widget build(BuildContext context) {
    final s = session;
    final theme = Theme.of(context);
    return Card(
      margin: const EdgeInsets.fromLTRB(16, 8, 16, 0),
      child: ListTile(
        onTap: () => context.push('/sessions/${s.id}'),
        leading: Icon(s.scheduleId == null ? Icons.event : Icons.repeat, color: s.cancelled ? theme.disabledColor : theme.colorScheme.primary),
        title: Text(s.title, style: s.cancelled ? const TextStyle(decoration: TextDecoration.lineThrough) : null),
        subtitle: Text([
          s.timeLabel,
          s.locationName,
          if (s.cancelled) 'Dibatalkan' else '${s.going} ikut',
          if (s.myRsvp == 'going') 'Kamu ikut',
          if (s.attended) 'Hadir',
        ].join(' · ')),
        trailing: const Icon(Icons.chevron_right),
      ),
    );
  }
}

/// Detail sesi: RSVP, check-in (QR/GPS), dan alat admin (tampilkan QR, rekap, batalkan).
class SessionDetailScreen extends ConsumerWidget {
  const SessionDetailScreen({super.key, required this.id});
  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider(id));
    return Scaffold(
      appBar: AppBar(title: const Text('Sesi lari')),
      body: session.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text(ApiError.from(e).message)),
        data: (s) => _SessionBody(session: s),
      ),
    );
  }
}

class _SessionBody extends ConsumerWidget {
  const _SessionBody({required this.session});
  final RunSession session;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = session;
    final repo = ref.read(communityPlusRepositoryProvider);
    final theme = Theme.of(context);
    final started = s.startsAt.isBefore(DateTime.now());
    void refresh() {
      ref.invalidate(sessionProvider(s.id));
      ref.invalidate(sessionsProvider(s.communityId));
    }

    return RefreshIndicator(
      onRefresh: () async => refresh(),
      child: ListView(padding: const EdgeInsets.all(16), children: [
        Text(s.title, style: theme.textTheme.headlineSmall),
        if (s.communityName != null) Text(s.communityName!, style: theme.textTheme.labelLarge),
        const SizedBox(height: 12),
        _Row(Icons.schedule, s.timeLabel),
        _Row(Icons.place_outlined, s.locationName),
        if (s.distanceM != null) _Row(Icons.straighten, kmLabel(s.distanceM!)),
        if (s.paceTargetSPerKm != null) _Row(Icons.speed, 'Target pace ${paceLabel(s.paceTargetSPerKm)}'),
        if (s.notes.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text(s.notes)),
        const SizedBox(height: 16),
        if (s.cancelled)
          Text('Sesi ini dibatalkan', style: TextStyle(color: theme.colorScheme.error))
        else if (!started) ...[
          SegmentedButton<String>(
            key: const Key('rsvp'),
            segments: const [
              ButtonSegment(value: 'going', label: Text('Ikut'), icon: Icon(Icons.check)),
              ButtonSegment(value: 'not_going', label: Text('Tidak ikut'), icon: Icon(Icons.close)),
            ],
            emptySelectionAllowed: true,
            selected: {?s.myRsvp},
            onSelectionChanged: (v) async {
              if (v.isEmpty) return;
              final ok = await runCommunityAction(context, () => repo.rsvp(s.id, v.first == 'going'));
              if (ok) refresh();
            },
          ),
          const SizedBox(height: 8),
          Text('${s.going} ikut · ${s.notGoing} tidak ikut', style: theme.textTheme.bodySmall),
        ],
        if (s.goingMembers.isNotEmpty) ...[
          const SizedBox(height: 12),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final m in s.goingMembers) Chip(avatar: UserAvatar(name: m.displayName, url: m.avatarUrl, radius: 12), label: Text(m.displayName)),
          ]),
        ],
        const Divider(height: 32),
        Text('Absensi', style: theme.textTheme.titleMedium),
        const SizedBox(height: 8),
        if (!s.attendanceEnabled)
          const Text('Absensi QR / GPS tersedia untuk Komunitas Pro.')
        else if (s.attended)
          const ListTile(leading: Icon(Icons.verified, color: Colors.green), title: Text('Kamu tercatat hadir'))
        else if (!s.checkInOpen)
          const Text('Absensi dibuka 30 menit sebelum sesi sampai 3 jam setelah mulai.')
        else ...[
          OutlinedButton.icon(
            key: const Key('scan-qr'),
            icon: const Icon(Icons.qr_code_scanner),
            label: const Text('Pindai QR dari admin'),
            onPressed: () async {
              final token = await Navigator.of(context).push<String>(MaterialPageRoute(builder: (_) => const QrScanScreen()));
              if (token == null || !context.mounted) return;
              final ok = await runCommunityAction(context, () => repo.checkInQr(s.id, token), success: 'Kehadiran tercatat');
              if (ok) refresh();
            },
          ),
          if (s.gpsCheckIn)
            OutlinedButton.icon(
              key: const Key('gps-checkin'),
              icon: const Icon(Icons.my_location),
              label: const Text('Check-in dengan GPS'),
              onPressed: () async {
                final ok = await runCommunityAction(context, () => _gpsCheckIn(repo, s.id), success: 'Kehadiran tercatat');
                if (ok) refresh();
              },
            ),
          const Padding(
            padding: EdgeInsets.only(top: 4),
            child: Text('Check-in GPS hanya membandingkan posisimu dengan titik kumpul. Posisimu tidak disimpan.', style: TextStyle(fontSize: 12)),
          ),
        ],
        if (s.isStaff) ...[
          const Divider(height: 32),
          Text('Admin', style: theme.textTheme.titleMedium),
          if (s.attendanceEnabled && s.checkInOpen)
            ListTile(
              key: const Key('show-qr'),
              leading: const Icon(Icons.qr_code_2),
              title: const Text('Tampilkan QR absensi'),
              subtitle: const Text('Berganti tiap 30 detik'),
              onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => QrDisplayScreen(sessionId: s.id))),
            ),
          ListTile(
            leading: const Icon(Icons.fact_check_outlined),
            title: const Text('Rekap kehadiran'),
            onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => AttendanceScreen(sessionId: s.id, canEdit: s.attendanceEnabled))),
          ),
          if (!s.cancelled && !started)
            ListTile(
              leading: Icon(Icons.cancel_outlined, color: theme.colorScheme.error),
              title: const Text('Batalkan sesi'),
              onTap: () async {
                if (!await confirm(context, title: 'Batalkan sesi?', message: 'Anggota yang ikut akan diberi tahu.', action: 'Batalkan', destructive: true)) return;
                if (!context.mounted) return;
                final ok = await runCommunityAction(context, () => repo.cancelSession(s.id));
                if (ok) refresh();
              },
            ),
        ],
      ]),
    );
  }

  /// Ambil posisi sekali (izin diminta di sini), kirim ke server untuk dibandingkan, lalu dibuang.
  Future<void> _gpsCheckIn(CommunityPlusRepository repo, String sessionId) async {
    if (!await Geolocator.isLocationServiceEnabled()) throw const ApiError(0, 'location_off', 'Nyalakan lokasi (GPS) di HP');
    var perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
    if (perm != LocationPermission.whileInUse && perm != LocationPermission.always) {
      throw const ApiError(0, 'location_denied', 'Izin lokasi dibutuhkan untuk check-in GPS. Atau gunakan QR');
    }
    final p = await Geolocator.getCurrentPosition(locationSettings: const LocationSettings(accuracy: LocationAccuracy.best, timeLimit: Duration(seconds: 15)));
    if (p.isMocked) throw const ApiError(0, 'mock_location', 'Lokasi palsu terdeteksi. Matikan aplikasi lokasi palsu atau gunakan QR');
    await repo.checkInGps(sessionId, lat: p.latitude, lng: p.longitude, accuracyM: p.accuracy, mocked: p.isMocked);
  }
}

class _Row extends StatelessWidget {
  const _Row(this.icon, this.text);
  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(children: [Icon(icon, size: 18), const SizedBox(width: 8), Expanded(child: Text(text))]),
      );
}

/// QR absensi di HP admin; token baru diambil dari server tiap ~30 detik (token lama kedaluwarsa sendiri).
class QrDisplayScreen extends ConsumerStatefulWidget {
  const QrDisplayScreen({super.key, required this.sessionId});
  final String sessionId;

  @override
  ConsumerState<QrDisplayScreen> createState() => _QrDisplayScreenState();
}

class _QrDisplayScreenState extends ConsumerState<QrDisplayScreen> {
  String? _token;
  String? _error;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final qr = await ref.read(communityPlusRepositoryProvider).qr(widget.sessionId);
      if (!mounted) return;
      setState(() {
        _token = qr.token;
        _error = null;
      });
      _timer?.cancel();
      _timer = Timer(Duration(seconds: (qr.refreshAfterS - 5).clamp(5, 60)), _load);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = ApiError.from(e).message);
      _timer?.cancel();
      _timer = Timer(const Duration(seconds: 10), _load);
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('QR absensi')),
      body: Center(
        child: _error != null
            ? Padding(padding: const EdgeInsets.all(24), child: Text(_error!, textAlign: TextAlign.center))
            : _token == null
                ? const CircularProgressIndicator()
                : Column(mainAxisSize: MainAxisSize.min, children: [
                    Container(
                      color: Colors.white,
                      padding: const EdgeInsets.all(16),
                      child: QrImageView(key: const Key('attendance-qr'), data: _token!, size: 280),
                    ),
                    const SizedBox(height: 16),
                    const Text('Minta anggota memindai kode ini. Kode berganti otomatis.'),
                  ]),
      ),
    );
  }
}

/// Pemindai QR (kamera). Mengembalikan isi QR pertama yang berawalan PTQR1.
class QrScanScreen extends StatefulWidget {
  const QrScanScreen({super.key});

  @override
  State<QrScanScreen> createState() => _QrScanScreenState();
}

class _QrScanScreenState extends State<QrScanScreen> {
  bool _done = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Pindai QR absensi')),
      body: MobileScanner(
        onDetect: (capture) {
          if (_done) return;
          for (final b in capture.barcodes) {
            final v = b.rawValue;
            if (v != null && v.startsWith('PTQR1.')) {
              _done = true;
              Navigator.pop(context, v);
              return;
            }
          }
        },
      ),
    );
  }
}

/// Rekap kehadiran satu sesi (admin). Tandai manual hanya saat Komunitas Pro aktif.
class AttendanceScreen extends ConsumerStatefulWidget {
  const AttendanceScreen({super.key, required this.sessionId, required this.canEdit});
  final String sessionId;
  final bool canEdit;

  @override
  ConsumerState<AttendanceScreen> createState() => _AttendanceScreenState();
}

class _AttendanceScreenState extends ConsumerState<AttendanceScreen> {
  late Future<({int present, List<AttendanceRow> members})> _future = ref.read(communityPlusRepositoryProvider).attendance(widget.sessionId);

  void _reload() => setState(() => _future = ref.read(communityPlusRepositoryProvider).attendance(widget.sessionId));

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Rekap kehadiran')),
      body: FutureBuilder(
        future: _future,
        builder: (context, snap) {
          if (snap.hasError) return Center(child: Text(ApiError.from(snap.error!).message));
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final data = snap.data!;
          return ListView(children: [
            ListTile(title: Text('${data.present} hadir dari ${data.members.length} anggota')),
            for (final m in data.members)
              CheckboxListTile(
                value: m.present,
                title: Text(m.displayName),
                subtitle: Text([
                  if (m.rsvp == 'going') 'RSVP ikut' else if (m.rsvp == 'not_going') 'RSVP tidak ikut',
                  if (m.method != null) 'via ${m.method == 'qr' ? 'QR' : m.method == 'gps' ? 'GPS' : 'admin'}',
                ].join(' · ')),
                onChanged: !widget.canEdit
                    ? null
                    : (v) async {
                        final ok = await runCommunityAction(context, () => ref.read(communityPlusRepositoryProvider).markAttendance(widget.sessionId, m.userId, v ?? false));
                        if (ok) _reload();
                      },
              ),
          ]);
        },
      ),
    );
  }
}

/// Formulir jadwal rutin atau sesi sekali jalan (admin).
class SessionFormScreen extends ConsumerStatefulWidget {
  const SessionFormScreen({super.key, required this.communityId, required this.recurring});
  final String communityId;
  final bool recurring;

  @override
  ConsumerState<SessionFormScreen> createState() => _SessionFormScreenState();
}

class _SessionFormScreenState extends ConsumerState<SessionFormScreen> {
  final _title = TextEditingController();
  final _location = TextEditingController();
  final _distance = TextEditingController();
  final _pace = TextEditingController();
  final _notes = TextEditingController();
  int _weekday = 6;
  TimeOfDay _time = const TimeOfDay(hour: 5, minute: 30);
  DateTime _date = DateTime.now().add(const Duration(days: 1));
  String _tz = 'Asia/Jakarta';
  bool _remind = true;
  GeoPoint? _point;

  @override
  void dispose() {
    for (final c in [_title, _location, _distance, _pace, _notes]) {
      c.dispose();
    }
    super.dispose();
  }

  /// "6:30" → 390 detik/km.
  int? _parsePace(String v) {
    final m = RegExp(r'^(\d{1,2}):([0-5]\d)$').firstMatch(v.trim());
    return m == null ? null : int.parse(m[1]!) * 60 + int.parse(m[2]!);
  }

  Future<void> _save() async {
    final hh = _time.hour.toString().padLeft(2, '0');
    final mm = _time.minute.toString().padLeft(2, '0');
    final km = double.tryParse(_distance.text.replaceAll(',', '.'));
    final body = <String, dynamic>{
      'title': _title.text.trim(),
      'locationName': _location.text.trim(),
      'timezone': _tz,
      'remind': _remind,
      if (_point != null) 'point': _point!.toJson(),
      if (km != null) 'distanceM': (km * 1000).round(),
      'paceTargetSPerKm': ?_parsePace(_pace.text),
      if (_notes.text.trim().isNotEmpty) 'notes': _notes.text.trim(),
    };
    final repo = ref.read(communityPlusRepositoryProvider);
    if (widget.recurring) {
      await repo.createSchedule(widget.communityId, {...body, 'weekday': _weekday, 'startTime': '$hh:$mm'});
    } else {
      // Waktu setempat di zona sesi → UTC.
      final local = DateTime.utc(_date.year, _date.month, _date.day, _time.hour, _time.minute).subtract(Duration(hours: tzOffsetHours(_tz)));
      await repo.createSession(widget.communityId, {...body, 'startsAt': local.toIso8601String()});
    }
    if (mounted) Navigator.pop(context, true);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.recurring ? 'Jadwal rutin' : 'Sesi sekali jalan')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        TextField(controller: _title, decoration: const InputDecoration(labelText: 'Judul (mis. Long run Sabtu)'), maxLength: 80),
        TextField(controller: _location, decoration: const InputDecoration(labelText: 'Tempat kumpul'), maxLength: 120),
        if (widget.recurring)
          DropdownButtonFormField<int>(
            initialValue: _weekday,
            decoration: const InputDecoration(labelText: 'Hari'),
            items: [for (var i = 1; i <= 7; i++) DropdownMenuItem(value: i, child: Text(weekdayNames[i - 1]))],
            onChanged: (v) => setState(() => _weekday = v ?? _weekday),
          )
        else
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Tanggal'),
            subtitle: Text('${_date.day}/${_date.month}/${_date.year}'),
            onTap: () async {
              final d = await showDatePicker(context: context, firstDate: DateTime.now(), lastDate: DateTime.now().add(const Duration(days: 365)), initialDate: _date);
              if (d != null) setState(() => _date = d);
            },
          ),
        ListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Jam mulai'),
          subtitle: Text('${_time.format(context)} ${tzLabel(_tz)}'),
          onTap: () async {
            final t = await showTimePicker(context: context, initialTime: _time);
            if (t != null) setState(() => _time = t);
          },
        ),
        DropdownButtonFormField<String>(
          initialValue: _tz,
          decoration: const InputDecoration(labelText: 'Zona waktu'),
          items: const [
            DropdownMenuItem(value: 'Asia/Jakarta', child: Text('WIB')),
            DropdownMenuItem(value: 'Asia/Makassar', child: Text('WITA')),
            DropdownMenuItem(value: 'Asia/Jayapura', child: Text('WIT')),
          ],
          onChanged: (v) => setState(() => _tz = v ?? _tz),
        ),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.place_outlined),
          title: Text(_point == null ? 'Titik kumpul di peta (untuk check-in GPS)' : 'Titik kumpul dipilih'),
          subtitle: const Text('Opsional. Pilih tempat umum, bukan rumah'),
          onTap: () async {
            final p = await PointPickerScreen.pick(context, title: 'Titik kumpul', initial: _point);
            if (p != null) setState(() => _point = p);
          },
        ),
        TextField(controller: _distance, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Jarak (km, opsional)')),
        TextField(controller: _pace, decoration: const InputDecoration(labelText: 'Target pace (mis. 6:30, opsional)')),
        TextField(controller: _notes, decoration: const InputDecoration(labelText: 'Catatan (opsional)'), maxLength: 500, maxLines: 3),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          value: _remind,
          onChanged: (v) => setState(() => _remind = v),
          title: const Text('Pengingat 2 jam sebelum'),
          subtitle: const Text('Untuk anggota yang RSVP ikut'),
        ),
        const SizedBox(height: 16),
        AsyncButton(label: 'Simpan', onPressed: _save),
      ]),
    );
  }
}
