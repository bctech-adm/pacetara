import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/api_error.dart';
import '../../core/widgets/common.dart';
import 'events_repository.dart';

// ---------- Kirim event ----------

/// Formulir kirim event untuk penyelenggara (modul 2.4). Kiriman ditinjau tim PaceTara dulu dan baru
/// tampil di kalender setelah disetujui. Maks. 5 kiriman per hari.
class SubmitEventScreen extends ConsumerStatefulWidget {
  const SubmitEventScreen({super.key});

  @override
  ConsumerState<SubmitEventScreen> createState() => _SubmitEventScreenState();
}

class _SubmitEventScreenState extends ConsumerState<SubmitEventScreen> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _city = TextEditingController();
  final _venue = TextEditingController();
  final _description = TextEditingController();
  final _registration = TextEditingController(text: 'https://');
  final _official = TextEditingController();
  final _organizer = TextEditingController();
  final _contact = TextEditingController();
  DateTime? _date;
  TimeOfDay? _time;
  final Set<String> _categories = {};
  bool _busy = false;

  @override
  void dispose() {
    for (final c in [_name, _city, _venue, _description, _registration, _official, _organizer, _contact]) {
      c.dispose();
    }
    super.dispose();
  }

  String _ymd(DateTime d) => '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      firstDate: DateTime(now.year, now.month, now.day),
      lastDate: DateTime(now.year + 2, now.month, now.day),
      initialDate: _date ?? DateTime(now.year, now.month, now.day).add(const Duration(days: 14)),
    );
    if (picked != null) setState(() => _date = picked);
  }

  Future<void> _pickTime() async {
    final picked = await showTimePicker(context: context, initialTime: _time ?? const TimeOfDay(hour: 5, minute: 0));
    if (picked != null) setState(() => _time = picked);
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    if (_date == null) return showInfo(context, 'Pilih tanggal event');
    if (_categories.isEmpty) return showInfo(context, 'Pilih minimal satu kategori jarak');
    setState(() => _busy = true);
    try {
      await ref.read(eventsRepositoryProvider).submit(EventSubmissionInput(
            name: _name.text,
            date: _ymd(_date!),
            startTime: _time == null ? null : '${_time!.hour.toString().padLeft(2, '0')}:${_time!.minute.toString().padLeft(2, '0')}',
            city: _city.text,
            venue: _venue.text,
            description: _description.text,
            categories: eventCategories.keys.where(_categories.contains).toList(),
            registrationUrl: _registration.text,
            officialUrl: _official.text,
            organizer: _organizer.text,
            contact: _contact.text,
          ));
      ref.invalidate(mySubmissionsProvider);
      if (!mounted) return;
      showInfo(context, 'Terkirim. Event tampil di kalender setelah ditinjau tim PaceTara.');
      context.pushReplacement('/events/submissions');
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String? _required(String? v, {int min = 2}) => (v?.trim().length ?? 0) < min ? 'Minimal $min karakter' : null;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Kirim event')),
      body: Form(
        key: _form,
        // SingleChildScrollView (bukan ListView) agar semua field tetap terpasang dan ikut divalidasi.
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(
            'Penyelenggara bisa mengirim event lari ke kalender PaceTara. Tim kami meninjau setiap kiriman sebelum tayang. '
            'Sumber dan tautan resmi akan ditampilkan di halaman event.',
            style: theme.textTheme.bodySmall,
          ),
          const SizedBox(height: 12),
          TextFormField(
            key: const Key('submit-name'),
            controller: _name,
            maxLength: 120,
            decoration: const InputDecoration(labelText: 'Nama event'),
            validator: (v) => _required(v, min: 3),
          ),
          Row(children: [
            Expanded(
              child: OutlinedButton.icon(
                key: const Key('submit-date'),
                onPressed: _pickDate,
                icon: const Icon(Icons.event),
                label: Text(_date == null ? 'Tanggal' : formatEventDate(_ymd(_date!), null)),
              ),
            ),
            const SizedBox(width: 8),
            OutlinedButton.icon(
              onPressed: _pickTime,
              icon: const Icon(Icons.schedule),
              label: Text(_time == null ? 'Jam (opsional)' : _time!.format(context)),
            ),
          ]),
          const SizedBox(height: 8),
          TextFormField(key: const Key('submit-city'), controller: _city, maxLength: 60, decoration: const InputDecoration(labelText: 'Kota'), validator: _required),
          TextFormField(controller: _venue, maxLength: 160, decoration: const InputDecoration(labelText: 'Lokasi (opsional)')),
          const SizedBox(height: 4),
          Text('Kategori jarak', style: theme.textTheme.titleSmall),
          Wrap(spacing: 6, runSpacing: 6, children: [
            for (final e in eventCategories.entries)
              FilterChip(
                key: Key('submit-cat-${e.key}'),
                label: Text(e.value),
                selected: _categories.contains(e.key),
                onSelected: (v) => setState(() => v ? _categories.add(e.key) : _categories.remove(e.key)),
              ),
          ]),
          const SizedBox(height: 8),
          TextFormField(
            key: const Key('submit-registration'),
            controller: _registration,
            keyboardType: TextInputType.url,
            maxLength: 500,
            decoration: const InputDecoration(labelText: 'Tautan pendaftaran resmi (https)'),
            validator: validateHttpsUrl,
          ),
          TextFormField(
            controller: _official,
            keyboardType: TextInputType.url,
            maxLength: 500,
            decoration: const InputDecoration(labelText: 'Halaman resmi event (opsional, https)'),
            validator: (v) => validateHttpsUrl(v, required: false),
          ),
          TextFormField(
            key: const Key('submit-organizer'),
            controller: _organizer,
            maxLength: 80,
            decoration: const InputDecoration(labelText: 'Nama penyelenggara', helperText: 'Ditampilkan sebagai sumber event'),
            validator: _required,
          ),
          TextFormField(
            controller: _contact,
            maxLength: 120,
            decoration: const InputDecoration(
              labelText: 'Email atau nomor HP penyelenggara (opsional)',
              helperText: 'Hanya untuk tim PaceTara jika perlu konfirmasi. Disimpan terenkripsi, tidak ditampilkan.',
              helperMaxLines: 2,
            ),
          ),
          TextFormField(controller: _description, maxLength: 2000, maxLines: 4, decoration: const InputDecoration(labelText: 'Deskripsi (opsional)')),
          const SizedBox(height: 12),
          FilledButton(key: const Key('submit-send'), onPressed: _busy ? null : _submit, child: Text(_busy ? 'Mengirim…' : 'Kirim untuk ditinjau')),
          ]),
        ),
      ),
    );
  }
}

// ---------- Kiriman saya ----------

class MySubmissionsScreen extends ConsumerWidget {
  const MySubmissionsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(mySubmissionsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Kiriman saya')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => context.push('/events/submit'),
        icon: const Icon(Icons.add),
        label: const Text('Kirim event'),
      ),
      body: list.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text(ApiError.from(e).message),
            TextButton(onPressed: () => ref.invalidate(mySubmissionsProvider), child: const Text('Coba lagi')),
          ]),
        ),
        data: (items) => RefreshIndicator(
          onRefresh: () => ref.refresh(mySubmissionsProvider.future),
          child: items.isEmpty
              ? ListView(children: const [
                  SizedBox(height: 96),
                  Center(child: Padding(padding: EdgeInsets.all(24), child: Text('Belum ada kiriman. Penyelenggara bisa mengirim event lari untuk ditinjau.', textAlign: TextAlign.center))),
                ])
              : ListView.separated(
                  padding: const EdgeInsets.only(bottom: 96),
                  itemCount: items.length,
                  separatorBuilder: (_, _) => const Divider(height: 1),
                  itemBuilder: (context, i) => SubmissionTile(submission: items[i]),
                ),
        ),
      ),
    );
  }
}

class SubmissionTile extends StatelessWidget {
  const SubmissionTile({super.key, required this.submission});
  final EventSubmission submission;

  @override
  Widget build(BuildContext context) {
    final s = submission;
    final theme = Theme.of(context);
    final color = switch (s.status) {
      'approved' || 'merged' => theme.colorScheme.primary,
      'rejected' => theme.colorScheme.error,
      _ => theme.colorScheme.onSurfaceVariant,
    };
    return ListTile(
      onTap: s.eventId == null ? null : () => context.push('/events/${s.eventId}'),
      title: Text(s.name),
      subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text([formatEventDate(s.date, null), if (s.city.isNotEmpty) s.city].join(' · ')),
        Text(s.statusLabel, style: TextStyle(color: color, fontWeight: FontWeight.w600)),
        if (s.rejectReason != null) Text('Alasan: ${s.rejectReason}'),
      ]),
      isThreeLine: true,
      trailing: s.eventId == null ? null : const Icon(Icons.chevron_right),
    );
  }
}
