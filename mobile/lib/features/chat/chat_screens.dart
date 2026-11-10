import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart' show Options, ResponseType;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/api/api_error.dart';
import '../../core/http/api_client.dart';
import '../../core/widgets/common.dart';
import '../auth/auth_controller.dart';
import '../communities/widgets.dart';
import 'chat_repository.dart';
import 'chat_room.dart';
import 'inbox.dart';

const _days = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
String _two(int n) => n.toString().padLeft(2, '0');
String formatTime(DateTime d) => '${_two(d.toLocal().hour)}:${_two(d.toLocal().minute)}';
String formatDayTime(DateTime d) {
  final l = d.toLocal();
  return '${_days[l.weekday - 1]}, ${l.day}/${l.month} ${formatTime(l)}';
}

/// Waktu singkat di daftar percakapan: jam jika hari ini, selain itu tanggal.
String formatListTime(DateTime d, DateTime now) {
  final l = d.toLocal();
  final n = now.toLocal();
  return l.year == n.year && l.month == n.month && l.day == n.day ? formatTime(l) : '${l.day}/${l.month}';
}

/// Buka (atau buat) chat pribadi dengan pengguna lain lalu pindah ke layarnya.
Future<void> openDirectChat(BuildContext context, WidgetRef ref, String userId) async {
  try {
    final conv = await ref.read(chatRepositoryProvider).direct(userId);
    if (context.mounted) await context.push('/chat/${conv.id}');
  } catch (e) {
    if (context.mounted) showInfo(context, ApiError.from(e).message);
  }
}

Future<void> openCommunityChat(BuildContext context, WidgetRef ref, String communityId) async {
  try {
    final conv = await ref.read(chatRepositoryProvider).community(communityId);
    if (context.mounted) await context.push('/chat/${conv.id}');
  } catch (e) {
    if (context.mounted) showInfo(context, ApiError.from(e).message);
  }
}

// ---------- Daftar percakapan (tab Chat) ----------

class ChatListScreen extends ConsumerWidget {
  const ChatListScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final inbox = ref.watch(inboxProvider);
    final now = DateTime.now();
    return Scaffold(
      appBar: AppBar(title: const Text('Chat')),
      body: RefreshIndicator(
        onRefresh: () async => ref.invalidate(inboxProvider),
        child: inbox.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => ListView(children: [
            const SizedBox(height: 80),
            Center(child: Text(ApiError.from(e).message)),
            TextButton(onPressed: () => ref.invalidate(inboxProvider), child: const Text('Coba lagi')),
          ]),
          data: (items) => items.isEmpty
              ? ListView(children: const [
                  SizedBox(height: 80),
                  Padding(
                    padding: EdgeInsets.symmetric(horizontal: 32),
                    child: Text(
                      'Belum ada percakapan. Gabung ke komunitas untuk mengobrol dengan sesama pelari.',
                      textAlign: TextAlign.center,
                    ),
                  ),
                ])
              : ListView.separated(
                  itemCount: items.length,
                  separatorBuilder: (_, _) => const Divider(height: 1, indent: 72),
                  itemBuilder: (context, i) => _ConversationTile(conv: items[i], now: now),
                ),
        ),
      ),
    );
  }
}

class _ConversationTile extends StatelessWidget {
  const _ConversationTile({required this.conv, required this.now});
  final ConversationSummary conv;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final last = conv.lastMessage;
    final unread = conv.unread > 0;
    return ListTile(
      onTap: () => context.push('/chat/${conv.id}'),
      leading: CommunityLogo(name: conv.title, logoUrl: conv.avatarUrl, size: 48),
      title: Row(children: [
        if (conv.kind == ConversationKind.community) ...[const Icon(Icons.groups, size: 16), const SizedBox(width: 4)],
        Expanded(child: Text(conv.title, overflow: TextOverflow.ellipsis, style: unread ? const TextStyle(fontWeight: FontWeight.w700) : null)),
      ]),
      subtitle: Text(
        last?.describe(showSender: conv.kind == ConversationKind.community) ?? 'Belum ada pesan',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.end, children: [
        if (last != null) Text(formatListTime(last.createdAt, now), style: theme.textTheme.labelSmall),
        if (unread) ...[
          const SizedBox(height: 4),
          Badge(label: Text(conv.unread > 99 ? '99+' : '${conv.unread}')),
        ],
      ]),
    );
  }
}

// ---------- Satu percakapan ----------

class ChatScreen extends ConsumerStatefulWidget {
  const ChatScreen({super.key, required this.convId});
  final String convId;

  @override
  ConsumerState<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends ConsumerState<ChatScreen> {
  final _text = TextEditingController();
  final _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      // Daftar terbalik: ujung atas (pesan lama) = maxScrollExtent.
      if (_scroll.position.pixels > _scroll.position.maxScrollExtent - 400) {
        unawaited(ref.read(chatRoomProvider(widget.convId).notifier).loadOlder());
      }
    });
  }

  @override
  void dispose() {
    _text.dispose();
    _scroll.dispose();
    super.dispose();
  }

  ChatRoomController get _room => ref.read(chatRoomProvider(widget.convId).notifier);

  ({String id, String name})? get _me {
    final me = ref.read(authControllerProvider).value;
    return me == null ? null : (id: me.id, name: me.displayName);
  }

  Future<void> _guard(Future<void> Function() action) async {
    try {
      await action();
    } catch (e) {
      if (mounted) showInfo(context, ApiError.from(e).message);
    }
  }

  Future<void> _sendText() async {
    final text = _text.text.trim();
    final me = _me;
    if (text.isEmpty || me == null) return;
    _text.clear();
    await _guard(() => _room.sendText(text, senderId: me.id, senderName: me.name));
  }

  Future<void> _pickImage(ImageSource source) async {
    final me = _me;
    if (me == null) return;
    final file = await ImagePicker().pickImage(source: source, maxWidth: 2048, imageQuality: 85);
    if (file == null) return;
    await _guard(() => _room.sendImage(file.path, senderId: me.id, senderName: me.name));
  }

  Future<void> _newInvite() async {
    final me = _me;
    if (me == null) return;
    final invite = await showModalBottomSheet<RunInvite>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => const RunInviteSheet(),
    );
    if (invite != null) await _guard(() => _room.sendInvite(invite, senderId: me.id, senderName: me.name));
  }

  void _attachMenu() {
    showModalBottomSheet<void>(
      context: context,
      builder: (sheet) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(
            leading: const Icon(Icons.photo_library_outlined),
            title: const Text('Gambar dari galeri'),
            onTap: () {
              Navigator.pop(sheet);
              _pickImage(ImageSource.gallery);
            },
          ),
          ListTile(
            leading: const Icon(Icons.photo_camera_outlined),
            title: const Text('Ambil foto'),
            onTap: () {
              Navigator.pop(sheet);
              _pickImage(ImageSource.camera);
            },
          ),
          ListTile(
            leading: const Icon(Icons.directions_run),
            title: const Text('Ajakan lari bareng'),
            onTap: () {
              Navigator.pop(sheet);
              _newInvite();
            },
          ),
        ]),
      ),
    );
  }

  Future<void> _messageActions(ChatMessage m) async {
    if (m.isPending) return;
    if (!m.isMine || m.deleted) return;
    final ok = await confirm(context, title: 'Hapus pesan?', message: 'Pesan dihapus untuk semua orang di percakapan ini.', action: 'Hapus', destructive: true);
    if (ok && mounted) await _guard(() => _room.delete(m));
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(chatRoomProvider(widget.convId));
    final conv = ref.watch(conversationProvider(widget.convId)).value;
    final isCommunity = conv?.kind == ConversationKind.community;
    final messages = state.messages.reversed.toList();

    return Scaffold(
      appBar: AppBar(
        title: Row(children: [
          if (conv != null) ...[CommunityLogo(name: conv.title, logoUrl: conv.avatarUrl, size: 32), const SizedBox(width: 12)],
          Expanded(child: Text(conv?.title ?? 'Chat', overflow: TextOverflow.ellipsis)),
        ]),
      ),
      body: Column(children: [
        Expanded(
          child: state.loading
              ? const Center(child: CircularProgressIndicator())
              : state.error != null && state.messages.isEmpty
                  ? Center(child: Text(state.error!))
                  : messages.isEmpty
                      ? const Center(child: Text('Belum ada pesan. Mulai obrolan!'))
                      : ListView.builder(
                          controller: _scroll,
                          reverse: true,
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                          itemCount: messages.length + (state.loadingOlder ? 1 : 0),
                          itemBuilder: (context, i) {
                            if (i >= messages.length) {
                              return const Padding(padding: EdgeInsets.all(12), child: Center(child: CircularProgressIndicator()));
                            }
                            final m = messages[i];
                            final older = i + 1 < messages.length ? messages[i + 1] : null;
                            final showName = isCommunity && !m.isMine && (older == null || older.senderId != m.senderId);
                            return MessageBubble(
                              key: ValueKey(m.isPending ? m.clientMsgId : m.id),
                              message: m,
                              showSender: showName,
                              onLongPress: () => _messageActions(m),
                              onRetry: () => _guard(() => _room.retry(m)),
                              onDiscard: () => _room.discard(m),
                              onRsvp: (going) => _guard(() => _room.rsvp(m, going: going)),
                            );
                          },
                        ),
        ),
        if (conv != null && conv.kind == ConversationKind.direct && !conv.otherUserActive)
          const Padding(padding: EdgeInsets.all(12), child: Text('Akun ini sudah dihapus. Kamu tidak bisa membalas.'))
        else
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(4, 4, 8, 8),
              child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
                IconButton(tooltip: 'Lampirkan', onPressed: _attachMenu, icon: const Icon(Icons.add_circle_outline)),
                Expanded(
                  child: TextField(
                    key: const Key('chat-input'),
                    controller: _text,
                    minLines: 1,
                    maxLines: 5,
                    maxLength: 2000,
                    textCapitalization: TextCapitalization.sentences,
                    decoration: const InputDecoration(hintText: 'Tulis pesan', counterText: '', border: OutlineInputBorder(), isDense: true),
                  ),
                ),
                const SizedBox(width: 4),
                IconButton.filled(key: const Key('chat-send'), tooltip: 'Kirim', onPressed: _sendText, icon: const Icon(Icons.send)),
              ]),
            ),
          ),
      ]),
    );
  }
}

class MessageBubble extends StatelessWidget {
  const MessageBubble({
    super.key,
    required this.message,
    required this.showSender,
    required this.onLongPress,
    required this.onRetry,
    required this.onDiscard,
    required this.onRsvp,
  });

  final ChatMessage message;
  final bool showSender;
  final VoidCallback onLongPress;
  final VoidCallback onRetry;
  final VoidCallback onDiscard;
  final ValueChanged<bool> onRsvp;

  @override
  Widget build(BuildContext context) {
    final m = message;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final bg = m.isMine ? scheme.primaryContainer : scheme.surfaceContainerHighest;
    final fg = m.isMine ? scheme.onPrimaryContainer : scheme.onSurface;

    final Widget content;
    if (m.deleted) {
      content = Text('Pesan dihapus', style: TextStyle(fontStyle: FontStyle.italic, color: fg.withValues(alpha: 0.7)));
    } else {
      content = switch (m.kind) {
        'image' => m.localImagePath != null
            ? ClipRRect(borderRadius: BorderRadius.circular(8), child: Image.file(File(m.localImagePath!), width: 220, fit: BoxFit.cover))
            : m.imageUrl != null
                ? ChatImage(url: m.imageUrl!)
                : Text('Gambar sudah kedaluwarsa', style: TextStyle(fontStyle: FontStyle.italic, color: fg.withValues(alpha: 0.7))),
        'run_invite' => RunInviteCard(invite: m.invite!, onRsvp: m.isPending ? null : onRsvp),
        _ => SelectableText(m.text ?? '', style: TextStyle(color: fg)),
      };
    }

    return Align(
      alignment: m.isMine ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.8),
        child: GestureDetector(
          onLongPress: onLongPress,
          onTap: m.sendState == SendState.failed ? onRetry : null,
          child: Container(
            margin: const EdgeInsets.symmetric(vertical: 3),
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 6),
            decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(14)),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              if (showSender) Text(m.senderName, style: theme.textTheme.labelMedium?.copyWith(color: scheme.primary, fontWeight: FontWeight.w700)),
              content,
              const SizedBox(height: 2),
              Row(mainAxisSize: MainAxisSize.min, children: [
                Text(formatTime(m.createdAt), style: theme.textTheme.labelSmall?.copyWith(color: fg.withValues(alpha: 0.6))),
                if (m.sendState == SendState.sending) ...[const SizedBox(width: 4), Icon(Icons.schedule, size: 12, color: fg.withValues(alpha: 0.6))],
                if (m.sendState == SendState.failed) ...[
                  const SizedBox(width: 6),
                  Flexible(child: Text('Gagal terkirim · ketuk untuk kirim ulang', style: theme.textTheme.labelSmall?.copyWith(color: scheme.error))),
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    tooltip: 'Buang',
                    iconSize: 16,
                    onPressed: onDiscard,
                    icon: Icon(Icons.close, color: scheme.error),
                  ),
                ],
              ]),
            ]),
          ),
        ),
      ),
    );
  }
}

class RunInviteCard extends StatelessWidget {
  const RunInviteCard({super.key, required this.invite, required this.onRsvp});
  final RunInvite invite;
  final ValueChanged<bool>? onRsvp;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final past = invite.startsAt.isBefore(DateTime.now());
    return SizedBox(
      width: 240,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(Icons.directions_run, size: 18, color: theme.colorScheme.primary),
          const SizedBox(width: 6),
          Expanded(child: Text('Ajakan lari bareng', style: theme.textTheme.labelMedium, overflow: TextOverflow.ellipsis)),
        ]),
        const SizedBox(height: 4),
        Text(invite.title, style: theme.textTheme.titleMedium),
        const SizedBox(height: 4),
        Row(children: [const Icon(Icons.event, size: 16), const SizedBox(width: 6), Expanded(child: Text(formatDayTime(invite.startsAt)))]),
        Row(children: [const Icon(Icons.place_outlined, size: 16), const SizedBox(width: 6), Expanded(child: Text(invite.place))]),
        if (invite.note.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text(invite.note)),
        const SizedBox(height: 6),
        Text(
          invite.goingCount == 0
              ? 'Belum ada yang ikut'
              : '${invite.goingCount} ikut: ${invite.going.join(', ')}${invite.goingCount > invite.going.length ? ', …' : ''}',
          style: theme.textTheme.bodySmall,
        ),
        if (onRsvp != null && !past) ...[
          const SizedBox(height: 6),
          SizedBox(
            width: double.infinity,
            child: invite.iAmGoing
                ? OutlinedButton(onPressed: () => onRsvp!(false), child: const Text('Batal ikut'))
                : FilledButton(onPressed: () => onRsvp!(true), child: const Text('Ikut')),
          ),
        ],
      ]),
    );
  }
}

/// Gambar chat diambil lewat Dio ber-pinning dengan token (bukan Image.network).
final chatImageProvider = FutureProvider.autoDispose.family<Uint8List?, String>((ref, path) async {
  final link = ref.keepAlive();
  // Simpan sebentar agar gulir naik-turun tidak mengunduh ulang.
  final timer = Timer(const Duration(minutes: 5), link.close);
  ref.onDispose(timer.cancel);
  try {
    final res = await ref.watch(dioProvider).get<List<int>>(path, options: Options(responseType: ResponseType.bytes));
    return res.data == null ? null : Uint8List.fromList(res.data!);
  } catch (_) {
    return null;
  }
});

class ChatImage extends ConsumerWidget {
  const ChatImage({super.key, required this.url});
  final String url;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final img = ref.watch(chatImageProvider(url));
    return ClipRRect(
      borderRadius: BorderRadius.circular(8),
      child: img.when(
        loading: () => const SizedBox(width: 220, height: 160, child: Center(child: CircularProgressIndicator())),
        error: (_, _) => const SizedBox(width: 220, height: 60, child: Center(child: Text('Gagal memuat gambar'))),
        data: (bytes) => bytes == null
            ? const SizedBox(width: 220, height: 60, child: Center(child: Text('Gagal memuat gambar')))
            : GestureDetector(
                onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(
                  builder: (_) => Scaffold(
                    backgroundColor: Colors.black,
                    appBar: AppBar(backgroundColor: Colors.black, foregroundColor: Colors.white),
                    body: Center(child: InteractiveViewer(child: Image.memory(bytes))),
                  ),
                )),
                child: Image.memory(bytes, width: 220, fit: BoxFit.cover),
              ),
      ),
    );
  }
}

/// Formulir ajakan lari bareng: judul, waktu, tempat, catatan.
class RunInviteSheet extends StatefulWidget {
  const RunInviteSheet({super.key});

  @override
  State<RunInviteSheet> createState() => _RunInviteSheetState();
}

class _RunInviteSheetState extends State<RunInviteSheet> {
  final _title = TextEditingController(text: 'Lari bareng');
  final _place = TextEditingController();
  final _note = TextEditingController();
  DateTime _when = _nextMorning();

  static DateTime _nextMorning() {
    final now = DateTime.now();
    return DateTime(now.year, now.month, now.day + 1, 6);
  }

  @override
  void dispose() {
    _title.dispose();
    _place.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _pickWhen() async {
    final now = DateTime.now();
    final date = await showDatePicker(context: context, initialDate: _when, firstDate: now, lastDate: now.add(const Duration(days: 89)));
    if (date == null || !mounted) return;
    final time = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(_when));
    if (time == null) return;
    setState(() => _when = DateTime(date.year, date.month, date.day, time.hour, time.minute));
  }

  void _submit() {
    if (_title.text.trim().isEmpty || _place.text.trim().isEmpty) {
      showInfo(context, 'Isi judul dan tempat');
      return;
    }
    if (_when.isBefore(DateTime.now())) {
      showInfo(context, 'Waktu sudah lewat');
      return;
    }
    Navigator.pop(context, RunInvite(title: _title.text.trim(), startsAt: _when, place: _place.text.trim(), note: _note.text.trim()));
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 0, 16, 16 + MediaQuery.viewInsetsOf(context).bottom),
      child: SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Ajakan lari bareng', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 12),
          TextField(controller: _title, maxLength: 80, decoration: const InputDecoration(labelText: 'Judul')),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.event),
            title: Text(formatDayTime(_when)),
            trailing: const Icon(Icons.edit_calendar_outlined),
            onTap: _pickWhen,
          ),
          TextField(controller: _place, maxLength: 120, decoration: const InputDecoration(labelText: 'Tempat kumpul')),
          TextField(controller: _note, maxLength: 500, maxLines: 3, minLines: 1, decoration: const InputDecoration(labelText: 'Catatan (jarak, pace, dll.)')),
          const SizedBox(height: 12),
          FilledButton(onPressed: _submit, child: const Text('Kirim ajakan')),
        ]),
      ),
    );
  }
}
