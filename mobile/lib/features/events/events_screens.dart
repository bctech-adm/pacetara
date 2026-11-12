import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api/api_error.dart';
import '../../core/widgets/common.dart';
import '../chat/chat_repository.dart';
import '../chat/chat_room.dart';
import '../communities/widgets.dart';
import '../moderation/moderation.dart';
import 'events_repository.dart';

/// 12 bulan ke depan mulai bulan ini, format YYYY-MM.
List<String> upcomingMonths(DateTime now) =>
    [for (var i = 0; i < 12; i++) DateTime(now.year, now.month + i)].map((d) => '${d.year}-${d.month.toString().padLeft(2, '0')}').toList();

String monthLabel(String ym) {
  final parts = ym.split('-');
  return '${monthNames[int.parse(parts[1]) - 1]} ${parts[0]}';
}

// ---------- Daftar ----------

/// Kalender event lari dengan filter kota, bulan, dan "yang saya ikuti".
class EventsScreen extends ConsumerStatefulWidget {
  const EventsScreen({super.key});

  @override
  ConsumerState<EventsScreen> createState() => _EventsScreenState();
}

class _EventsScreenState extends ConsumerState<EventsScreen> {
  String? _city;
  String? _month;
  bool _going = false;
  final List<EventSummary> _items = [];
  String? _cursor;
  bool _loading = false;
  bool _done = false;
  Object? _error;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    _generation++;
    setState(() {
      _items.clear();
      _cursor = null;
      _done = false;
      _error = null;
    });
    await _loadMore();
  }

  Future<void> _loadMore() async {
    if (_loading || _done) return;
    final gen = _generation;
    setState(() => _loading = true);
    try {
      final page = await ref.read(eventsRepositoryProvider).list(city: _city, month: _month, going: _going, cursor: _cursor);
      if (!mounted || gen != _generation) return;
      setState(() {
        _items.addAll(page.items);
        _cursor = page.nextCursor;
        _done = page.nextCursor == null;
      });
    } catch (e) {
      if (mounted && gen == _generation) setState(() => _error = e);
    } finally {
      if (mounted && gen == _generation) setState(() => _loading = false);
    }
  }

  Future<void> _open(EventSummary e) async {
    await context.push('/events/${e.id}');
    // Status ikut bisa berubah di detail.
    if (mounted) _reload();
  }

  @override
  Widget build(BuildContext context) {
    final cities = ref.watch(eventCitiesProvider).value ?? const <String>[];
    final months = upcomingMonths(DateTime.now());
    return Scaffold(
      appBar: AppBar(title: const Text('Kalender event'), actions: [
        IconButton(
          key: const Key('my-submissions'),
          tooltip: 'Kiriman saya',
          icon: const Icon(Icons.outbox_outlined),
          onPressed: () => context.push('/events/submissions'),
        ),
        IconButton(
          key: const Key('submit-event'),
          tooltip: 'Kirim event',
          icon: const Icon(Icons.add_circle_outline),
          onPressed: () => context.push('/events/submit'),
        ),
      ]),
      body: Column(children: [
        SizedBox(
          height: 52,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: FilterChip(
                  key: const Key('filter-going'),
                  label: const Text('Yang saya ikuti'),
                  selected: _going,
                  onSelected: (v) {
                    _going = v;
                    _reload();
                  },
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: _MenuChip(
                  key: const Key('filter-month'),
                  label: _month == null ? 'Semua bulan' : monthLabel(_month!),
                  selected: _month != null,
                  options: {null: 'Semua bulan', for (final m in months) m: monthLabel(m)},
                  onSelected: (m) {
                    _month = m;
                    _reload();
                  },
                ),
              ),
              if (cities.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  child: _MenuChip(
                    key: const Key('filter-city'),
                    label: _city ?? 'Semua kota',
                    selected: _city != null,
                    options: {null: 'Semua kota', for (final c in cities) c: c},
                    onSelected: (c) {
                      _city = c;
                      _reload();
                    },
                  ),
                ),
            ],
          ),
        ),
        Expanded(
          child: NotificationListener<ScrollNotification>(
            onNotification: (n) {
              if (n.metrics.pixels > n.metrics.maxScrollExtent - 200) _loadMore();
              return false;
            },
            child: RefreshIndicator(
              onRefresh: () {
                ref.invalidate(eventCitiesProvider);
                return _reload();
              },
              child: _items.isEmpty && !_loading
                  ? ListView(children: [
                      const SizedBox(height: 96),
                      Center(
                        child: Text(_error != null
                            ? ApiError.from(_error!).message
                            : _going
                                ? 'Belum ada event yang kamu ikuti'
                                : 'Belum ada event yang cocok'),
                      ),
                      if (_error != null) Center(child: TextButton(onPressed: _reload, child: const Text('Coba lagi'))),
                    ])
                  : ListView.builder(
                      padding: const EdgeInsets.only(bottom: 24),
                      itemCount: _items.length + (_loading ? 1 : 0),
                      itemBuilder: (context, i) {
                        if (i >= _items.length) {
                          return const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()));
                        }
                        final e = _items[i];
                        final showMonth = i == 0 || _items[i - 1].date.substring(0, 7) != e.date.substring(0, 7);
                        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          if (showMonth)
                            Padding(
                              padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                              child: Text(monthLabel(e.date.substring(0, 7)), style: Theme.of(context).textTheme.titleSmall),
                            ),
                          EventTile(event: e, onTap: () => _open(e)),
                        ]);
                      },
                    ),
            ),
          ),
        ),
      ]),
    );
  }
}

/// Chip filter yang membuka menu pilihan.
class _MenuChip extends StatelessWidget {
  const _MenuChip({super.key, required this.label, required this.selected, required this.options, required this.onSelected});
  final String label;
  final bool selected;
  final Map<String?, String> options;
  final ValueChanged<String?> onSelected;

  @override
  Widget build(BuildContext context) {
    return MenuAnchor(
      menuChildren: [
        for (final e in options.entries) MenuItemButton(onPressed: () => onSelected(e.key), child: Text(e.value)),
      ],
      builder: (context, controller, _) => FilterChip(
        label: Row(mainAxisSize: MainAxisSize.min, children: [Text(label), const Icon(Icons.arrow_drop_down, size: 18)]),
        selected: selected,
        showCheckmark: false,
        onSelected: (_) => controller.isOpen ? controller.close() : controller.open(),
      ),
    );
  }
}

class EventTile extends StatelessWidget {
  const EventTile({super.key, required this.event, required this.onTap});
  final EventSummary event;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final d = DateTime.parse(event.date);
    final social = [
      if (event.iAmGoing) 'Kamu ikut',
      if (event.friendsGoing > 0) '${event.friendsGoing} anggota komunitasmu ikut',
    ].join(' · ');
    return ListTile(
      onTap: onTap,
      leading: Container(
        width: 48,
        padding: const EdgeInsets.symmetric(vertical: 4),
        decoration: BoxDecoration(color: theme.colorScheme.primaryContainer, borderRadius: BorderRadius.circular(10)),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Text('${d.day}', style: theme.textTheme.titleMedium?.copyWith(color: theme.colorScheme.onPrimaryContainer, fontWeight: FontWeight.w700)),
          Text(formatEventDate(event.date, null).split(' ')[2], style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onPrimaryContainer)),
        ]),
      ),
      title: Text(event.name, maxLines: 2, overflow: TextOverflow.ellipsis),
      subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('${event.city} · ${categoryLabels(event.categories)}', maxLines: 1, overflow: TextOverflow.ellipsis),
        if (social.isNotEmpty) Text(social, style: TextStyle(color: theme.colorScheme.primary)),
      ]),
      isThreeLine: social.isNotEmpty,
    );
  }
}

// ---------- Detail ----------

class EventDetailScreen extends ConsumerWidget {
  const EventDetailScreen({super.key, required this.id});
  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detail = ref.watch(eventDetailProvider(id));
    final data = detail.value;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Detail event'),
        actions: [
          if (data != null)
            IconButton(tooltip: 'Bagikan ke chat', icon: const Icon(Icons.share_outlined), onPressed: () => shareEventToChat(context, ref, data.summary)),
          if (data != null)
            PopupMenuButton<String>(
              onSelected: (_) => showReportSheet(context, ref, target: ReportTarget.event, targetId: id, title: 'Laporkan event'),
              itemBuilder: (_) => const [PopupMenuItem(value: 'report', child: Text('Laporkan event'))],
            ),
        ],
      ),
      body: detail.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text(ApiError.from(e).message),
            TextButton(onPressed: () => ref.invalidate(eventDetailProvider(id)), child: const Text('Coba lagi')),
          ]),
        ),
        data: (d) => RefreshIndicator(
          onRefresh: () => ref.refresh(eventDetailProvider(id).future),
          child: EventDetailView(detail: d),
        ),
      ),
    );
  }
}

class EventDetailView extends ConsumerStatefulWidget {
  const EventDetailView({super.key, required this.detail});
  final EventDetail detail;

  @override
  ConsumerState<EventDetailView> createState() => _EventDetailViewState();
}

class _EventDetailViewState extends ConsumerState<EventDetailView> {
  bool _busy = false;

  Future<void> _toggle(bool going) async {
    setState(() => _busy = true);
    try {
      final id = widget.detail.summary.id;
      await ref.read(eventsRepositoryProvider).setGoing(id, going: going);
      ref.invalidate(eventDetailProvider(id));
      ref.invalidate(eventParticipantsProvider(id));
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _openRegistration() => _openExternal(widget.detail.registrationUrl);

  Future<void> _openExternal(String url) async {
    final uri = Uri.tryParse(url);
    // Server hanya menerima https; periksa lagi sebelum membuka browser.
    if (uri == null || uri.scheme != 'https') return;
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication) && mounted) showInfo(context, 'Tidak bisa membuka tautan');
  }

  @override
  Widget build(BuildContext context) {
    final d = widget.detail;
    final e = d.summary;
    final theme = Theme.of(context);
    final host = Uri.tryParse(d.registrationUrl)?.host ?? '';
    return ListView(padding: const EdgeInsets.all(16), children: [
      if (e.archived)
        Card(
          color: theme.colorScheme.surfaceContainerHighest,
          child: const ListTile(leading: Icon(Icons.history), title: Text('Event ini sudah lewat dan diarsipkan')),
        ),
      Text(e.name, style: theme.textTheme.headlineSmall),
      const SizedBox(height: 12),
      _InfoRow(icon: Icons.event, text: formatEventDate(e.date, e.startTime)),
      _InfoRow(icon: Icons.place_outlined, text: e.venue.isEmpty ? e.city : '${e.venue}, ${e.city}'),
      const SizedBox(height: 8),
      Wrap(spacing: 6, runSpacing: 6, children: [for (final c in e.categories) Chip(label: Text(eventCategories[c] ?? c), visualDensity: VisualDensity.compact)]),
      if (d.description.isNotEmpty) ...[const SizedBox(height: 12), SelectableText(d.description)],
      const SizedBox(height: 16),
      OutlinedButton.icon(
        key: const Key('event-register'),
        onPressed: _openRegistration,
        icon: const Icon(Icons.open_in_new),
        label: Text(host.isEmpty ? 'Daftar di situs resmi' : 'Daftar di $host'),
      ),
      const Padding(
        padding: EdgeInsets.only(top: 4),
        child: Text('Pendaftaran dan pembayaran dilakukan di situs penyelenggara, bukan di PaceTara.', style: TextStyle(fontSize: 12)),
      ),
      // PRD 2.4: sumber dan tautan resmi selalu ditampilkan.
      Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Wrap(crossAxisAlignment: WrapCrossAlignment.center, children: [
          Text('${d.source.label} · ', key: const Key('event-source'), style: theme.textTheme.bodySmall),
          InkWell(
            key: const Key('event-official'),
            onTap: () => _openExternal(d.source.url),
            child: Text('Lihat halaman resmi', style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.primary, decoration: TextDecoration.underline)),
          ),
        ]),
      ),
      const Divider(height: 32),
      Text('Siapa ikut?', style: theme.textTheme.titleMedium),
      const SizedBox(height: 4),
      Text(e.goingCount == 0 ? 'Belum ada pelari yang menandai ikut' : '${e.goingCount} pelari menandai ikut'),
      const SizedBox(height: 8),
      if (!e.archived)
        SizedBox(
          width: double.infinity,
          child: e.iAmGoing
              ? OutlinedButton.icon(
                  key: const Key('event-not-going'),
                  onPressed: _busy ? null : () => _toggle(false),
                  icon: const Icon(Icons.check),
                  label: const Text('Kamu ikut · batal ikut'),
                )
              : FilledButton.icon(
                  key: const Key('event-going'),
                  onPressed: _busy ? null : () => _toggle(true),
                  icon: const Icon(Icons.directions_run),
                  label: const Text('Saya ikut'),
                ),
        ),
      if (!e.archived)
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Text('Anggota komunitasmu bisa melihat bahwa kamu ikut.', style: theme.textTheme.bodySmall),
        ),
      const SizedBox(height: 12),
      if (e.friendsGoing == 0)
        Text('Belum ada anggota komunitasmu yang ikut.', style: theme.textTheme.bodyMedium)
      else ...[
        Text('${e.friendsGoing} anggota komunitasmu ikut', style: theme.textTheme.titleSmall),
        for (final p in d.friendsPreview) ParticipantTile(participant: p),
        if (e.friendsGoing > d.friendsPreview.length)
          TextButton(
            onPressed: () => showModalBottomSheet<void>(
              context: context,
              isScrollControlled: true,
              showDragHandle: true,
              builder: (_) => ParticipantsSheet(eventId: e.id),
            ),
            child: Text('Lihat semua (${e.friendsGoing})'),
          ),
      ],
    ]);
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow({required this.icon, required this.text});
  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(children: [Icon(icon, size: 18), const SizedBox(width: 8), Expanded(child: Text(text))]),
      );
}

class ParticipantTile extends StatelessWidget {
  const ParticipantTile({super.key, required this.participant});
  final Participant participant;

  @override
  Widget build(BuildContext context) => ListTile(
        contentPadding: EdgeInsets.zero,
        leading: CommunityLogo(name: participant.displayName, logoUrl: participant.avatarUrl, size: 40),
        title: Text(participant.displayName),
        subtitle: participant.communities.isEmpty ? null : Text(participant.communities.join(', '), maxLines: 1, overflow: TextOverflow.ellipsis),
      );
}

class ParticipantsSheet extends ConsumerWidget {
  const ParticipantsSheet({super.key, required this.eventId});
  final String eventId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(eventParticipantsProvider(eventId));
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.75),
        child: list.when(
          loading: () => const Padding(padding: EdgeInsets.all(32), child: Center(child: CircularProgressIndicator())),
          error: (e, _) => Padding(padding: const EdgeInsets.all(32), child: Text(ApiError.from(e).message)),
          data: (items) => ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            children: [
              Text('Anggota komunitasmu yang ikut', style: Theme.of(context).textTheme.titleMedium),
              for (final p in items) ParticipantTile(participant: p),
            ],
          ),
        ),
      ),
    );
  }
}

// ---------- Bagikan ke chat ----------

/// Pilih percakapan, kirim kartu event, lalu buka chat itu.
Future<void> shareEventToChat(BuildContext context, WidgetRef ref, EventSummary event) async {
  final conv = await showModalBottomSheet<ConversationSummary>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => const _ConversationPicker(),
  );
  if (conv == null || !context.mounted) return;
  try {
    await ref.read(chatRepositoryProvider).sendEvent(conv.id, newClientId(), event.id);
    if (context.mounted) await context.push('/chat/${conv.id}');
  } catch (e) {
    if (context.mounted) showError(context, e);
  }
}

final _shareTargetsProvider = FutureProvider.autoDispose<List<ConversationSummary>>((ref) => ref.watch(chatRepositoryProvider).conversations());

class _ConversationPicker extends ConsumerWidget {
  const _ConversationPicker();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(_shareTargetsProvider);
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.75),
        child: list.when(
          loading: () => const Padding(padding: EdgeInsets.all(32), child: Center(child: CircularProgressIndicator())),
          error: (e, _) => Padding(padding: const EdgeInsets.all(32), child: Text(ApiError.from(e).message)),
          data: (items) => ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.only(bottom: 16),
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: Text('Bagikan ke chat', style: Theme.of(context).textTheme.titleMedium),
              ),
              if (items.isEmpty) const Padding(padding: EdgeInsets.all(16), child: Text('Belum ada percakapan. Gabung komunitas dulu untuk mulai chat.')),
              for (final c in items.where((c) => c.otherUserActive))
                ListTile(
                  leading: CommunityLogo(name: c.title, logoUrl: c.avatarUrl, size: 40),
                  title: Text(c.title),
                  subtitle: Text(c.kind == ConversationKind.community ? 'Chat komunitas' : 'Chat pribadi'),
                  onTap: () => Navigator.pop(context, c),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
