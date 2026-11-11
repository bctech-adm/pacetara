import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/api/api_error.dart';
import '../../core/http/api_client.dart';
import '../../core/widgets/common.dart';
import '../communities/widgets.dart';
import '../runs/track.dart';
import 'passport_repository.dart';

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

/// Label sumbu untuk awal periode.
String bucketLabel(String period, DateTime d) => switch (period) {
      'month' => _months[d.month - 1],
      'year' => '${d.year}',
      _ => '${d.day}/${d.month}',
    };

String _date(String ymd) {
  final d = DateTime.tryParse(ymd);
  return d == null ? ymd : '${d.day} ${_months[d.month - 1]} ${d.year}';
}

final medalPhotoProvider = FutureProvider.autoDispose.family<Uint8List?, String>((ref, path) async {
  try {
    final res = await ref.watch(dioProvider).get<List<int>>(path, options: Options(responseType: ResponseType.bytes));
    return res.data == null ? null : Uint8List.fromList(res.data!);
  } catch (_) {
    return null;
  }
});

// ---------- Statistik riwayat ----------

/// Kartu statistik di atas riwayat lari: minggu/bulan (semua paket), tahun + rekor (Premium).
class RunStatsCard extends ConsumerStatefulWidget {
  const RunStatsCard({super.key});

  @override
  ConsumerState<RunStatsCard> createState() => _RunStatsCardState();
}

class _RunStatsCardState extends ConsumerState<RunStatsCard> {
  String _period = 'week';

  @override
  Widget build(BuildContext context) {
    final stats = ref.watch(runStatsProvider(_period));
    return Card(
      margin: const EdgeInsets.fromLTRB(16, 16, 16, 8),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'week', label: Text('Mingguan')),
                ButtonSegment(value: 'month', label: Text('Bulanan')),
                ButtonSegment(value: 'year', label: Text('Tahunan'), icon: Icon(Icons.workspace_premium_outlined, size: 16)),
              ],
              selected: {_period},
              onSelectionChanged: (s) => setState(() => _period = s.first),
            ),
            const SizedBox(height: 12),
            stats.when(
              loading: () => const SizedBox(height: 160, child: Center(child: CircularProgressIndicator())),
              error: (e, _) {
                final err = ApiError.from(e);
                return SizedBox(
                  height: 160,
                  child: Center(
                    child: Column(mainAxisSize: MainAxisSize.min, children: [
                      Text(err.message, textAlign: TextAlign.center),
                      if (err.code == 'limit_reached')
                        TextButton(onPressed: () => showLimitDialog(context, err.message), child: const Text('Lihat Premium')),
                    ]),
                  ),
                );
              },
              data: (s) => RunStatsView(stats: s),
            ),
          ],
        ),
      ),
    );
  }
}

class RunStatsView extends StatelessWidget {
  const RunStatsView({super.key, required this.stats});
  final RunStats stats;

  @override
  Widget build(BuildContext context) {
    final s = stats;
    final scheme = Theme.of(context).colorScheme;
    Widget stat(String label, String value) => Expanded(
          child: Column(children: [
            Text(value, style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
            Text(label, style: Theme.of(context).textTheme.bodySmall),
          ]),
        );
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      SizedBox(
        height: 140,
        child: CustomPaint(
          key: const Key('stats-chart'),
          painter: StatsBarPainter(
            values: [for (final b in s.buckets) b.distanceM / 1000],
            labels: [for (final b in s.buckets) bucketLabel(s.period, b.start)],
            barColor: scheme.primary,
            labelColor: scheme.onSurfaceVariant,
          ),
        ),
      ),
      const SizedBox(height: 12),
      Text(
        s.full ? 'Total sepanjang masa' : 'Total ${s.historyDays ?? 90} hari terakhir',
        style: Theme.of(context).textTheme.labelMedium,
        textAlign: TextAlign.center,
      ),
      const SizedBox(height: 4),
      Row(children: [
        stat('km', formatDistanceKm(s.totalDistanceM.toDouble())),
        stat('lari', '${s.totalRuns}'),
        stat('waktu', formatDuration(s.totalMovingTimeS)),
        stat('/km', formatPaceS(s.totalAvgPace?.toDouble())),
      ]),
      if (s.records != null) ...[
        const Divider(height: 24),
        Text('Rekor pribadi (perkiraan dari pace rata-rata)', style: Theme.of(context).textTheme.labelMedium),
        const SizedBox(height: 4),
        Wrap(spacing: 8, runSpacing: 4, children: [
          for (final e in s.records!.entries)
            Chip(
              label: Text('${categoryText(e.key)}: ${e.value == null ? '-' : formatDuration(e.value!.timeS)}'),
              visualDensity: VisualDensity.compact,
            ),
          Chip(label: Text('Terjauh: ${formatDistanceKm(s.longestRunM.toDouble())} km'), visualDensity: VisualDensity.compact),
        ]),
      ] else
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Text(
            'Premium: statistik tahunan, total sepanjang masa, dan rekor pribadi.',
            style: Theme.of(context).textTheme.bodySmall,
            textAlign: TextAlign.center,
          ),
        ),
    ]);
  }
}

/// Grafik batang sederhana (tanpa dependensi grafik).
class StatsBarPainter extends CustomPainter {
  StatsBarPainter({required this.values, required this.labels, required this.barColor, required this.labelColor});
  final List<double> values;
  final List<String> labels;
  final Color barColor;
  final Color labelColor;

  @override
  void paint(Canvas canvas, Size size) {
    if (values.isEmpty) return;
    const labelH = 16.0;
    const topPad = 14.0;
    final chartH = size.height - labelH - topPad;
    final maxV = values.reduce((a, b) => a > b ? a : b);
    final slot = size.width / values.length;
    final barW = (slot * 0.6).clamp(2.0, 28.0);
    final paint = Paint()..color = barColor;
    final empty = Paint()..color = labelColor.withValues(alpha: 0.25);
    // Label tiap n batang agar tidak bertumpuk.
    final every = (values.length / 6).ceil().clamp(1, 100);
    for (var i = 0; i < values.length; i++) {
      final x = slot * i + (slot - barW) / 2;
      final h = maxV <= 0 ? 0.0 : (values[i] / maxV) * chartH;
      final rect = values[i] <= 0
          ? Rect.fromLTWH(x, topPad + chartH - 2, barW, 2)
          : Rect.fromLTWH(x, topPad + chartH - h, barW, h);
      canvas.drawRRect(RRect.fromRectAndRadius(rect, const Radius.circular(3)), values[i] <= 0 ? empty : paint);
      if (i == values.length - 1 && values[i] > 0) {
        _text(canvas, values[i].toStringAsFixed(1), Offset(x + barW / 2, topPad + chartH - h - 13), 10, barColor);
      }
      if ((values.length - 1 - i) % every == 0 && i < labels.length) {
        _text(canvas, labels[i], Offset(x + barW / 2, size.height - labelH + 2), 10, labelColor);
      }
    }
  }

  void _text(Canvas canvas, String s, Offset center, double fontSize, Color color) {
    final tp = TextPainter(text: TextSpan(text: s, style: TextStyle(fontSize: fontSize, color: color)), textDirection: TextDirection.ltr)..layout();
    tp.paint(canvas, Offset(center.dx - tp.width / 2, center.dy));
  }

  @override
  bool shouldRepaint(StatsBarPainter old) => old.values != values || old.barColor != barColor;
}

// ---------- Paspor ----------

IconData badgeIcon(String group) => switch (group) {
      'total' => Icons.route_outlined,
      'streak' => Icons.local_fire_department_outlined,
      _ => Icons.emoji_events_outlined,
    };

/// Paspor lari: lencana, rak medali, dan hasil resmi. [userId] null = milik sendiri.
class PassportScreen extends ConsumerWidget {
  const PassportScreen({super.key, this.userId});
  final String? userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final passport = ref.watch(passportProvider(userId));
    final p = passport.value;
    return Scaffold(
      appBar: AppBar(
        title: Text(p == null || p.isMe ? 'Paspor lari' : 'Paspor ${p.displayName ?? ''}'),
        actions: [
          if (p != null && p.isMe)
            PopupMenuButton<String>(
              icon: Icon(p.visibility == 'private' ? Icons.lock_outline : Icons.groups_outlined),
              tooltip: 'Siapa yang bisa melihat',
              onSelected: (v) async {
                try {
                  await ref.read(passportRepositoryProvider).setVisibility(v);
                  ref.invalidate(passportProvider(userId));
                } catch (e) {
                  if (context.mounted) showError(context, e);
                }
              },
              itemBuilder: (_) => [
                CheckedPopupMenuItem(value: 'community', checked: p.visibility == 'community', child: const Text('Anggota komunitasku')),
                CheckedPopupMenuItem(value: 'private', checked: p.visibility == 'private', child: const Text('Hanya saya')),
              ],
            ),
        ],
      ),
      floatingActionButton: p != null && p.isMe
          ? FloatingActionButton.extended(
              onPressed: () => _addMenu(context, ref, p),
              icon: const Icon(Icons.add),
              label: const Text('Tambah'),
            )
          : null,
      body: passport.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(ApiError.from(e).message, textAlign: TextAlign.center))),
        data: (p) => RefreshIndicator(
          onRefresh: () async {
            ref.invalidate(passportProvider(userId));
            await ref.read(passportProvider(userId).future);
          },
          child: PassportView(passport: p),
        ),
      ),
    );
  }

  Future<void> _addMenu(BuildContext context, WidgetRef ref, Passport p) async {
    final choice = await showModalBottomSheet<String>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(
            leading: const Icon(Icons.military_tech_outlined),
            title: const Text('Foto medali'),
            subtitle: Text(p.medalLimit == null ? 'Tanpa batas' : '${p.medalsUsed} dari ${p.medalLimit} (paket gratis)'),
            onTap: () => Navigator.pop(context, 'medal'),
          ),
          ListTile(
            leading: const Icon(Icons.timer_outlined),
            title: const Text('Hasil resmi event'),
            subtitle: const Text('Catatan waktu dari penyelenggara'),
            onTap: () => Navigator.pop(context, 'result'),
          ),
        ]),
      ),
    );
    if (!context.mounted || choice == null) return;
    if (choice == 'medal' && !p.canAddMedal) {
      await showLimitDialog(context, 'Rak medali paket gratis maksimal ${p.medalLimit} medali. Upgrade ke Premium untuk menambah tanpa batas');
      return;
    }
    final added = await context.push<bool>(choice == 'medal' ? '/passport/medals/new' : '/passport/results/new');
    if (added == true) ref.invalidate(passportProvider(userId));
  }
}

class PassportView extends ConsumerWidget {
  const PassportView({super.key, required this.passport});
  final Passport passport;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = passport;
    final text = Theme.of(context).textTheme;
    final earned = p.badges.where((b) => b.earned).length;
    return ListView(padding: const EdgeInsets.only(bottom: 96), children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
        child: Text('Lencana${p.isMe ? ' ($earned/${p.badges.length})' : ''}', style: text.titleMedium),
      ),
      if (p.streakWeeks > 0)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Text('Konsisten ${p.streakWeeks} minggu berturut-turut', style: text.bodySmall),
        ),
      if (p.badges.isEmpty)
        const Padding(padding: EdgeInsets.all(16), child: Text('Belum ada lencana.'))
      else
        GridView.count(
          crossAxisCount: 4,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          padding: const EdgeInsets.all(12),
          childAspectRatio: 0.8,
          children: [for (final b in p.badges) _BadgeTile(badge: b)],
        ),
      const Divider(),
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
        child: Text(
          'Rak medali${p.isMe && p.medalLimit != null ? ' (${p.medalsUsed}/${p.medalLimit})' : ''}',
          style: text.titleMedium,
        ),
      ),
      if (p.isMe && p.medalLimit != null && p.medalsUsed > p.medalLimit!)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Text('Medalimu melebihi batas paket gratis. Semua tetap tersimpan, tetapi belum bisa menambah.', style: text.bodySmall),
        ),
      if (p.medals.isEmpty)
        Padding(padding: const EdgeInsets.all(16), child: Text(p.isMe ? 'Foto medali fisikmu dan simpan di sini.' : 'Belum ada medali.'))
      else
        GridView.count(
          crossAxisCount: 3,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          padding: const EdgeInsets.all(12),
          mainAxisSpacing: 8,
          crossAxisSpacing: 8,
          childAspectRatio: 0.75,
          children: [for (final m in p.medals) _MedalTile(medal: m, canDelete: p.isMe)],
        ),
      const Divider(),
      Padding(padding: const EdgeInsets.fromLTRB(16, 8, 16, 4), child: Text('Hasil resmi', style: text.titleMedium)),
      if (p.results.isEmpty)
        Padding(padding: const EdgeInsets.all(16), child: Text(p.isMe ? 'Catat waktu resmi dari event yang kamu ikuti.' : 'Belum ada hasil.'))
      else
        for (final r in p.results)
          ListTile(
            leading: CircleAvatar(child: Text(categoryText(r.category).split(' ').first, style: const TextStyle(fontSize: 11))),
            title: Text(r.eventName),
            subtitle: Text('${_date(r.eventDate)} · ${categoryText(r.category)}${r.avgPaceSPerKm == null ? '' : ' · ${formatPaceS(r.avgPaceSPerKm!.toDouble())} /km'}'),
            trailing: Text(formatDuration(r.officialTimeS), style: const TextStyle(fontWeight: FontWeight.w700)),
            onLongPress: p.isMe
                ? () async {
                    if (!await confirm(context, title: 'Hapus hasil?', message: r.eventName, action: 'Hapus', destructive: true)) return;
                    try {
                      await ref.read(passportRepositoryProvider).deleteResult(r.id);
                      ref.invalidate(passportProvider(null));
                    } catch (e) {
                      if (context.mounted) showError(context, e);
                    }
                  }
                : null,
          ),
      if (p.isMe)
        Padding(
          padding: const EdgeInsets.all(16),
          child: Text(
            p.visibility == 'private'
                ? 'Paspormu hanya bisa dilihat olehmu.'
                : 'Anggota komunitasmu bisa melihat paspormu. Tekan lama untuk menghapus medali atau hasil.',
            style: text.bodySmall,
            textAlign: TextAlign.center,
          ),
        ),
    ]);
  }
}

class _BadgeTile extends StatelessWidget {
  const _BadgeTile({required this.badge});
  final AchievementBadge badge;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final b = badge;
    return Tooltip(
      message: b.earned
          ? '${b.description}\n${b.earnedAt!.day}/${b.earnedAt!.month}/${b.earnedAt!.year}${b.privateOnly ? ' · hanya kamu yang melihat (impor Strava)' : ''}'
          : b.description,
      triggerMode: TooltipTriggerMode.tap,
      child: Column(children: [
        CircleAvatar(
          radius: 26,
          backgroundColor: b.earned ? scheme.primaryContainer : scheme.surfaceContainerHighest,
          child: Icon(b.earned ? badgeIcon(b.group) : Icons.lock_outline, color: b.earned ? scheme.onPrimaryContainer : scheme.outline),
        ),
        const SizedBox(height: 4),
        Text(
          b.title,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 11, color: b.earned ? null : scheme.outline),
        ),
      ]),
    );
  }
}

class _MedalTile extends ConsumerWidget {
  const _MedalTile({required this.medal, required this.canDelete});
  final Medal medal;
  final bool canDelete;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final bytes = ref.watch(medalPhotoProvider(medal.photoUrl));
    return GestureDetector(
      onLongPress: canDelete
          ? () async {
              if (!await confirm(context, title: 'Hapus medali?', message: medal.title, action: 'Hapus', destructive: true)) return;
              try {
                await ref.read(passportRepositoryProvider).deleteMedal(medal.id);
                ref.invalidate(passportProvider(null));
              } catch (e) {
                if (context.mounted) showError(context, e);
              }
            }
          : null,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Expanded(
          child: ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: ColoredBox(
              color: Theme.of(context).colorScheme.surfaceContainerHighest,
              child: bytes.when(
                loading: () => const Center(child: CircularProgressIndicator()),
                error: (_, _) => const Icon(Icons.military_tech_outlined),
                data: (b) => b == null ? const Icon(Icons.military_tech_outlined) : Image.memory(b, fit: BoxFit.cover),
              ),
            ),
          ),
        ),
        const SizedBox(height: 4),
        Text(medal.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
        Text(
          [if (medal.eventDate != null) _date(medal.eventDate!), if (medal.category != null) categoryText(medal.category)].join(' · '),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 11),
        ),
      ]),
    );
  }
}

// ---------- Tambah medali / hasil ----------

class _EventPicker extends ConsumerWidget {
  const _EventPicker({required this.value, required this.onChanged});
  final JoinedEvent? value;
  final ValueChanged<JoinedEvent?> onChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final events = ref.watch(joinedEventsProvider).value ?? const <JoinedEvent>[];
    if (events.isEmpty) return const SizedBox.shrink();
    return DropdownButtonFormField<String?>(
      initialValue: value?.id,
      isExpanded: true,
      decoration: const InputDecoration(labelText: 'Event yang kamu ikuti (opsional)'),
      items: [
        const DropdownMenuItem(value: null, child: Text('Event lain (isi manual)')),
        for (final e in events) DropdownMenuItem(value: e.id, child: Text('${e.name} · ${_date(e.eventDate)}', overflow: TextOverflow.ellipsis)),
      ],
      onChanged: (id) => onChanged(id == null ? null : events.firstWhere((e) => e.id == id)),
    );
  }
}

Future<String?> _pickDate(BuildContext context) async {
  final now = DateTime.now();
  final d = await showDatePicker(context: context, firstDate: DateTime(1990), lastDate: now, initialDate: now);
  return d == null ? null : '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
}

class AddMedalScreen extends ConsumerStatefulWidget {
  const AddMedalScreen({super.key});

  @override
  ConsumerState<AddMedalScreen> createState() => _AddMedalScreenState();
}

class _AddMedalScreenState extends ConsumerState<AddMedalScreen> {
  final _title = TextEditingController();
  String? _photo;
  String? _date;
  String? _category;
  JoinedEvent? _event;

  @override
  void dispose() {
    _title.dispose();
    super.dispose();
  }

  Future<void> _pick(ImageSource source) async {
    final f = await ImagePicker().pickImage(source: source, maxWidth: 2048, maxHeight: 2048, imageQuality: 85);
    if (f != null) setState(() => _photo = f.path);
  }

  Future<void> _save() async {
    if (_photo == null) return showInfo(context, 'Pilih foto medali dulu');
    final title = _title.text.trim().isEmpty ? (_event?.name ?? '') : _title.text.trim();
    if (title.isEmpty) return showInfo(context, 'Isi nama medali');
    try {
      await ref.read(passportRepositoryProvider).addMedal(
            title: title,
            photoPath: _photo!,
            eventId: _event?.id,
            eventDate: _event == null ? _date : null,
            category: _category,
          );
      if (mounted) context.pop(true);
    } catch (e) {
      if (!mounted) return;
      final err = ApiError.from(e);
      err.code == 'limit_reached' ? await showLimitDialog(context, err.message) : showError(context, err);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Tambah medali')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Row(children: [
          Expanded(child: OutlinedButton.icon(onPressed: () => _pick(ImageSource.camera), icon: const Icon(Icons.photo_camera_outlined), label: const Text('Kamera'))),
          const SizedBox(width: 8),
          Expanded(child: OutlinedButton.icon(onPressed: () => _pick(ImageSource.gallery), icon: const Icon(Icons.photo_library_outlined), label: const Text('Galeri'))),
        ]),
        if (_photo != null) const Padding(padding: EdgeInsets.only(top: 8), child: Text('Foto dipilih. Lokasi dan data kamera dihapus server.')),
        const SizedBox(height: 16),
        _EventPicker(value: _event, onChanged: (e) => setState(() => _event = e)),
        TextField(controller: _title, maxLength: 120, decoration: const InputDecoration(labelText: 'Nama medali')),
        DropdownButtonFormField<String?>(
          initialValue: _category,
          decoration: const InputDecoration(labelText: 'Kategori (opsional)'),
          items: [
            const DropdownMenuItem(value: null, child: Text('-')),
            for (final e in eventCategories.entries) DropdownMenuItem(value: e.key, child: Text(e.value)),
          ],
          onChanged: (v) => setState(() => _category = v),
        ),
        if (_event == null)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.event_outlined),
            title: Text(_date == null ? 'Tanggal event (opsional)' : _date!),
            onTap: () async {
              final d = await _pickDate(context);
              if (d != null) setState(() => _date = d);
            },
          ),
        const SizedBox(height: 16),
        AsyncButton(label: 'Simpan', onPressed: _save),
      ]),
    );
  }
}

class AddResultScreen extends ConsumerStatefulWidget {
  const AddResultScreen({super.key});

  @override
  ConsumerState<AddResultScreen> createState() => _AddResultScreenState();
}

class _AddResultScreenState extends ConsumerState<AddResultScreen> {
  final _name = TextEditingController();
  final _time = TextEditingController();
  String? _date;
  String _category = '10k';
  JoinedEvent? _event;

  @override
  void dispose() {
    _name.dispose();
    _time.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final secs = parseDuration(_time.text);
    if (secs == null) return showInfo(context, 'Isi catatan waktu dengan format j:mm:dd atau mm:dd');
    if (_event == null && (_name.text.trim().length < 3 || _date == null)) return showInfo(context, 'Isi nama dan tanggal event');
    try {
      await ref.read(passportRepositoryProvider).addResult({
        'category': _category,
        'officialTimeS': secs,
        if (_event != null) 'eventId': _event!.id else ...{'eventName': _name.text.trim(), 'eventDate': _date},
      });
      if (mounted) context.pop(true);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Tambah hasil resmi')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        _EventPicker(
          value: _event,
          onChanged: (e) => setState(() {
            _event = e;
            final c = e?.categories.firstOrNull;
            if (c != null && eventCategories.containsKey(c)) _category = c;
          }),
        ),
        if (_event == null) ...[
          TextField(controller: _name, maxLength: 120, decoration: const InputDecoration(labelText: 'Nama event')),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.event_outlined),
            title: Text(_date == null ? 'Tanggal event' : _date!),
            onTap: () async {
              final d = await _pickDate(context);
              if (d != null) setState(() => _date = d);
            },
          ),
        ],
        DropdownButtonFormField<String>(
          key: ValueKey(_category),
          initialValue: _category,
          decoration: const InputDecoration(labelText: 'Kategori'),
          items: [for (final e in eventCategories.entries) DropdownMenuItem(value: e.key, child: Text(e.value))],
          onChanged: (v) => setState(() => _category = v ?? _category),
        ),
        TextField(
          key: const Key('official-time'),
          controller: _time,
          keyboardType: TextInputType.datetime,
          decoration: const InputDecoration(labelText: 'Catatan waktu resmi', hintText: '1:58:30'),
        ),
        const SizedBox(height: 24),
        AsyncButton(label: 'Simpan', onPressed: _save),
      ]),
    );
  }
}
