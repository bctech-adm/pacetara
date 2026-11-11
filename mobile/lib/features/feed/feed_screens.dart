import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/api/api_error.dart';
import '../../core/http/api_client.dart';
import '../../core/widgets/common.dart';
import '../auth/auth_controller.dart';
import '../chat/chat_screens.dart' show formatListTime;
import '../moderation/moderation.dart';
import '../notifications/notifications_screens.dart';
import '../runs/runs_repository.dart';
import '../runs/track.dart';
import 'feed_repository.dart';
import 'share_card.dart';

/// Foto postingan: diambil lewat Dio ber-pinning dengan token (bukan URL publik), dibuang dari memori saat tidak tampil.
final feedPhotoProvider = FutureProvider.autoDispose.family<Uint8List?, String>((ref, path) async {
  try {
    final res = await ref.watch(dioProvider).get<List<int>>(path, options: Options(responseType: ResponseType.bytes));
    return res.data == null ? null : Uint8List.fromList(res.data!);
  } catch (_) {
    return null;
  }
});

/// Tab Feed: Mengikuti, Komunitas, Jelajah.
class FeedScreen extends StatelessWidget {
  const FeedScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: FeedTab.values.length,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Feed'),
          actions: [
            IconButton(tooltip: 'Pengikut dan blokir', icon: const Icon(Icons.people_outline), onPressed: () => context.push('/feed/connections')),
            const NotificationBell(),
          ],
          bottom: TabBar(tabs: [for (final t in FeedTab.values) Tab(text: feedTabText(t))]),
        ),
        floatingActionButton: FloatingActionButton.extended(
          key: const Key('new-post'),
          onPressed: () => context.push('/feed/new'),
          icon: const Icon(Icons.edit_outlined),
          label: const Text('Posting'),
        ),
        body: TabBarView(children: [for (final t in FeedTab.values) PostList(key: PageStorageKey(t), load: (r, c) => r.list(t, cursor: c), empty: _emptyText(t))]),
      ),
    );
  }

  static String _emptyText(FeedTab t) => switch (t) {
        FeedTab.following => 'Belum ada postingan. Ikuti pelari lain dari tab Jelajah, atau buat postingan pertamamu.',
        FeedTab.community => 'Belum ada postingan dari anggota komunitasmu.',
        FeedTab.explore => 'Belum ada postingan publik.',
      };
}

/// Daftar postingan dengan paging kursor dan tarik-untuk-memuat-ulang.
class PostList extends ConsumerStatefulWidget {
  const PostList({super.key, required this.load, required this.empty, this.header});
  final Future<FeedPage<FeedPost>> Function(FeedRepository repo, String? cursor) load;
  final String empty;
  final Widget? header;

  @override
  ConsumerState<PostList> createState() => _PostListState();
}

class _PostListState extends ConsumerState<PostList> {
  final _items = <FeedPost>[];
  String? _cursor;
  bool _loading = false;
  bool _done = false;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    _items.clear();
    _cursor = null;
    _done = false;
    _error = null;
    await _more();
  }

  Future<void> _more() async {
    if (_loading || _done) return;
    setState(() => _loading = true);
    try {
      final page = await widget.load(ref.read(feedRepositoryProvider), _cursor);
      _items.addAll(page.items);
      _cursor = page.nextCursor;
      _done = page.nextCursor == null;
    } catch (e) {
      _error = e;
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _replace(FeedPost p) => setState(() {
        final i = _items.indexWhere((x) => x.id == p.id);
        if (i >= 0) _items[i] = p;
      });

  void _remove(String id) => setState(() => _items.removeWhere((x) => x.id == id));

  @override
  Widget build(BuildContext context) {
    final header = widget.header;
    return RefreshIndicator(
      onRefresh: _refresh,
      child: NotificationListener<ScrollNotification>(
        onNotification: (n) {
          if (n.metrics.extentAfter < 600) _more();
          return false;
        },
        child: ListView.builder(
          padding: const EdgeInsets.only(bottom: 96),
          itemCount: _items.length + 2,
          itemBuilder: (context, i) {
            if (i == 0) return header ?? const SizedBox.shrink();
            if (i == _items.length + 1) {
              if (_loading) return const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()));
              if (_error != null && _items.isEmpty) {
                return Padding(padding: const EdgeInsets.all(32), child: Center(child: Text(ApiError.from(_error!).message, textAlign: TextAlign.center)));
              }
              if (_items.isEmpty) return Padding(padding: const EdgeInsets.all(32), child: Text(widget.empty, textAlign: TextAlign.center));
              return const SizedBox(height: 24);
            }
            final p = _items[i - 1];
            return PostCard(key: ValueKey(p.id), post: p, onChanged: _replace, onRemoved: () => _remove(p.id));
          },
        ),
      ),
    );
  }
}

class UserAvatar extends ConsumerWidget {
  const UserAvatar({super.key, required this.name, required this.url, this.radius = 20});
  final String name;
  final String? url;
  final double radius;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final u = url;
    final bytes = u == null ? null : ref.watch(avatarBytesProvider(u)).value;
    return CircleAvatar(
      radius: radius,
      backgroundImage: bytes == null ? null : MemoryImage(Uint8List.fromList(bytes)),
      child: bytes == null ? Text(name.isEmpty ? '?' : name[0].toUpperCase(), style: TextStyle(fontSize: radius * 0.8)) : null,
    );
  }
}

IconData _visIcon(PostVisibility v) => switch (v) {
      PostVisibility.public => Icons.public,
      PostVisibility.community => Icons.groups_outlined,
      PostVisibility.followers => Icons.people_outline,
    };

/// Kartu satu postingan: penulis, teks, foto, hasil lari, suka/komentar, dan menu (laporkan, blokir, hapus).
class PostCard extends ConsumerStatefulWidget {
  const PostCard({super.key, required this.post, this.onChanged, this.onRemoved, this.inDetail = false});
  final FeedPost post;
  final ValueChanged<FeedPost>? onChanged;
  final VoidCallback? onRemoved;
  final bool inDetail;

  @override
  ConsumerState<PostCard> createState() => _PostCardState();
}

class _PostCardState extends ConsumerState<PostCard> {
  bool _liking = false;

  Future<void> _toggleLike() async {
    if (_liking) return;
    setState(() => _liking = true);
    try {
      final p = await ref.read(feedRepositoryProvider).setLike(widget.post.id, like: !widget.post.likedByMe);
      widget.onChanged?.call(p);
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _liking = false);
    }
  }

  Future<void> _menu(String action) async {
    final p = widget.post;
    switch (action) {
      case 'report':
        await showReportSheet(context, ref, target: ReportTarget.post, targetId: p.id, title: 'Laporkan postingan');
      case 'block':
        if (await _confirm(context, 'Blokir ${p.author.displayName}?', 'Kalian tidak akan saling melihat postingan dan komentar di feed, dan tidak bisa saling mengikuti.', 'Blokir')) {
          try {
            await ref.read(feedRepositoryProvider).setBlock(p.author.id, block: true);
            widget.onRemoved?.call();
            if (mounted) showInfo(context, '${p.author.displayName} diblokir');
          } catch (e) {
            if (mounted) showError(context, e);
          }
        }
      case 'delete':
        if (await _confirm(context, 'Hapus postingan?', 'Postingan beserta foto, suka, dan komentarnya dihapus permanen.', 'Hapus')) {
          try {
            await ref.read(feedRepositoryProvider).delete(p.id);
            widget.onRemoved?.call();
            if (mounted && widget.inDetail) context.pop();
          } catch (e) {
            if (mounted) showError(context, e);
          }
        }
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.post;
    final theme = Theme.of(context);
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: widget.inDetail ? null : () => context.push('/feed/posts/${p.id}'),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          ListTile(
            leading: GestureDetector(
              onTap: () => context.push('/feed/users/${p.author.id}'),
              child: UserAvatar(name: p.author.displayName, url: p.author.avatarUrl),
            ),
            title: Text(p.author.displayName, style: const TextStyle(fontWeight: FontWeight.w600)),
            subtitle: Row(children: [
              Text(formatListTime(p.createdAt, DateTime.now())),
              const SizedBox(width: 6),
              Icon(_visIcon(p.visibility), size: 14),
            ]),
            trailing: PopupMenuButton<String>(
              key: Key('post-menu-${p.id}'),
              onSelected: _menu,
              itemBuilder: (_) => p.isMine
                  ? const [PopupMenuItem(value: 'delete', child: Text('Hapus'))]
                  : const [
                      PopupMenuItem(value: 'report', child: Text('Laporkan')),
                      PopupMenuItem(value: 'block', child: Text('Blokir pengguna')),
                    ],
            ),
          ),
          if (p.isMine && (p.underReview || p.hidden))
            Container(
              color: theme.colorScheme.errorContainer,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: Text(
                p.hidden ? 'Disembunyikan dari orang lain sambil ditinjau karena laporan' : 'Sedang ditinjau karena laporan',
                style: TextStyle(color: theme.colorScheme.onErrorContainer),
              ),
            ),
          if (p.text != null && p.text!.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: Text(p.text!, maxLines: widget.inDetail ? null : 8, overflow: widget.inDetail ? null : TextOverflow.ellipsis),
            ),
          if (p.run != null) RunCardTile(run: p.run!),
          if (p.runUnavailable)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: Text('Hasil lari ini tidak tersedia lagi', style: theme.textTheme.bodySmall),
            ),
          if (p.photoUrls.isNotEmpty) _Photos(urls: p.photoUrls),
          Row(children: [
            TextButton.icon(
              key: Key('like-${p.id}'),
              onPressed: _liking ? null : _toggleLike,
              icon: Icon(p.likedByMe ? Icons.favorite : Icons.favorite_border, color: p.likedByMe ? theme.colorScheme.primary : null),
              label: Text('${p.likeCount}'),
            ),
            TextButton.icon(
              onPressed: widget.inDetail ? null : () => context.push('/feed/posts/${p.id}'),
              icon: const Icon(Icons.mode_comment_outlined),
              label: Text('${p.commentCount}'),
            ),
          ]),
        ]),
      ),
    );
  }
}

Future<bool> _confirm(BuildContext context, String title, String body, String action) async =>
    await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: Text(title),
        content: Text(body),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Batal')),
          FilledButton(onPressed: () => Navigator.pop(d, true), child: Text(action)),
        ],
      ),
    ) ==
    true;

/// Hasil lari di feed: statistik + sketsa rute publik (tanpa peta, tanpa titik di zona privasi).
class RunCardTile extends StatelessWidget {
  const RunCardTile({super.key, required this.run});
  final FeedRun run;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 0, 12, 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: theme.colorScheme.primaryContainer, borderRadius: BorderRadius.circular(12)),
      child: Row(children: [
        SizedBox(
          width: 88,
          height: 88,
          child: run.route.isEmpty
              ? Icon(Icons.directions_run, size: 40, color: theme.colorScheme.onPrimaryContainer)
              : CustomPaint(painter: RouteSketch(run.route, theme.colorScheme.onPrimaryContainer)),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(run.title, style: theme.textTheme.titleSmall, maxLines: 1, overflow: TextOverflow.ellipsis),
            Text('${formatDistanceKm(run.distanceM.toDouble())} km', style: theme.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
            Text('${formatDuration(run.movingTimeS)} · ${formatPaceS(run.avgPaceSPerKm?.toDouble())} /km'),
          ]),
        ),
      ]),
    );
  }
}

class RouteSketch extends CustomPainter {
  RouteSketch(this.route, this.color);
  final RunRoute route;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    for (final seg in projectRoute(route, Offset.zero & size)) {
      if (seg.length < 2) continue;
      final path = Path()..moveTo(seg.first.dx, seg.first.dy);
      for (final p in seg.skip(1)) {
        path.lineTo(p.dx, p.dy);
      }
      canvas.drawPath(path, paint);
    }
  }

  @override
  bool shouldRepaint(RouteSketch old) => old.route != route || old.color != color;
}

class _Photos extends StatelessWidget {
  const _Photos({required this.urls});
  final List<String> urls;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 260,
      child: PageView(children: [
        for (var i = 0; i < urls.length; i++)
          Stack(fit: StackFit.expand, children: [
            _Photo(url: urls[i]),
            if (urls.length > 1)
              Positioned(
                right: 8,
                top: 8,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(12)),
                  child: Text('${i + 1}/${urls.length}', style: const TextStyle(color: Colors.white)),
                ),
              ),
          ]),
      ]),
    );
  }
}

class _Photo extends ConsumerWidget {
  const _Photo({required this.url});
  final String url;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final bytes = ref.watch(feedPhotoProvider(url));
    return ColoredBox(
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      child: bytes.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => const Center(child: Icon(Icons.broken_image_outlined)),
        data: (b) => b == null ? const Center(child: Icon(Icons.broken_image_outlined)) : Image.memory(b, fit: BoxFit.cover),
      ),
    );
  }
}

// ---------- Detail + komentar ----------

class PostDetailScreen extends ConsumerStatefulWidget {
  const PostDetailScreen({super.key, required this.id});
  final String id;

  @override
  ConsumerState<PostDetailScreen> createState() => _PostDetailScreenState();
}

class _PostDetailScreenState extends ConsumerState<PostDetailScreen> {
  final _input = TextEditingController();
  final _comments = <FeedComment>[];
  String? _cursor;
  bool _loadedOnce = false;
  bool _sending = false;

  @override
  void initState() {
    super.initState();
    _loadComments();
  }

  @override
  void dispose() {
    _input.dispose();
    super.dispose();
  }

  Future<void> _loadComments({bool more = false}) async {
    try {
      final page = await ref.read(feedRepositoryProvider).comments(widget.id, cursor: more ? _cursor : null);
      if (!mounted) return;
      setState(() {
        if (!more) _comments.clear();
        _comments.addAll(page.items);
        _cursor = page.nextCursor;
        _loadedOnce = true;
      });
    } catch (_) {
      if (mounted) setState(() => _loadedOnce = true);
    }
  }

  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      final c = await ref.read(feedRepositoryProvider).addComment(widget.id, text);
      _input.clear();
      setState(() => _comments.add(c));
      ref.invalidate(feedPostProvider(widget.id));
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _commentMenu(FeedComment c, String action) async {
    if (action == 'report') {
      await showReportSheet(context, ref, target: ReportTarget.comment, targetId: c.id, title: 'Laporkan komentar');
    } else if (action == 'delete') {
      try {
        await ref.read(feedRepositoryProvider).deleteComment(c.id);
        setState(() => _comments.removeWhere((x) => x.id == c.id));
        ref.invalidate(feedPostProvider(widget.id));
      } catch (e) {
        if (mounted) showError(context, e);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final post = ref.watch(feedPostProvider(widget.id));
    return Scaffold(
      appBar: AppBar(title: const Text('Postingan')),
      body: post.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(ApiError.from(e).message, textAlign: TextAlign.center))),
        data: (p) => Column(children: [
          Expanded(
            child: ListView(children: [
              PostCard(
                post: p,
                inDetail: true,
                onChanged: (_) => ref.invalidate(feedPostProvider(widget.id)),
                onRemoved: () {},
              ),
              if (!_loadedOnce) const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator())),
              if (_loadedOnce && _comments.isEmpty) const Padding(padding: EdgeInsets.all(24), child: Center(child: Text('Belum ada komentar'))),
              for (final c in _comments)
                ListTile(
                  key: Key('comment-${c.id}'),
                  leading: GestureDetector(
                    onTap: () => context.push('/feed/users/${c.author.id}'),
                    child: UserAvatar(name: c.author.displayName, url: c.author.avatarUrl, radius: 16),
                  ),
                  title: Text(c.author.displayName, style: const TextStyle(fontWeight: FontWeight.w600)),
                  subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(c.text),
                    Text(
                      c.hidden ? 'Disembunyikan sambil ditinjau' : formatListTime(c.createdAt, DateTime.now()),
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ]),
                  trailing: PopupMenuButton<String>(
                    onSelected: (a) => _commentMenu(c, a),
                    itemBuilder: (_) => [
                      if (!c.isMine) const PopupMenuItem(value: 'report', child: Text('Laporkan')),
                      if (c.canDelete) const PopupMenuItem(value: 'delete', child: Text('Hapus')),
                    ],
                  ),
                ),
              if (_cursor != null) TextButton(onPressed: () => _loadComments(more: true), child: const Text('Muat komentar lain')),
            ]),
          ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 4, 8),
              child: Row(children: [
                Expanded(
                  child: TextField(
                    key: const Key('comment-input'),
                    controller: _input,
                    maxLength: 1000,
                    minLines: 1,
                    maxLines: 4,
                    decoration: const InputDecoration(hintText: 'Tulis komentar…', counterText: '', border: OutlineInputBorder()),
                  ),
                ),
                IconButton(key: const Key('comment-send'), onPressed: _sending ? null : _send, icon: const Icon(Icons.send)),
              ]),
            ),
          ),
        ]),
      ),
    );
  }
}

// ---------- Buat postingan ----------

class ComposePostScreen extends ConsumerStatefulWidget {
  const ComposePostScreen({super.key, this.runId});

  /// Diisi = membagikan hasil lari ini.
  final String? runId;

  @override
  ConsumerState<ComposePostScreen> createState() => _ComposePostScreenState();
}

class _ComposePostScreenState extends ConsumerState<ComposePostScreen> {
  final _text = TextEditingController();
  final _photos = <String>[];
  PostVisibility? _visibility;
  bool _busy = false;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _pick() async {
    final left = 4 - _photos.length;
    if (left <= 0) return;
    // Diperkecil di HP agar unggahan ringan; server tetap memproses ulang dan membuang EXIF/lokasi.
    final files = await ImagePicker().pickMultiImage(maxWidth: 2048, maxHeight: 2048, imageQuality: 85, limit: left);
    if (files.isEmpty) return;
    setState(() => _photos.addAll(files.take(left).map((f) => f.path)));
  }

  Future<void> _submit(PostVisibility visibility) async {
    setState(() => _busy = true);
    try {
      final post = await ref.read(feedRepositoryProvider).create(text: _text.text, visibility: visibility, runId: widget.runId, photoPaths: _photos);
      if (!mounted) return;
      showInfo(context, 'Postingan terbit');
      context.pushReplacement('/feed/posts/${post.id}');
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final runId = widget.runId;
    final run = runId == null ? null : ref.watch(runDetailProvider(runId));
    final runVis = run?.value?.summary.visibility;
    final allowed = runVis == null ? PostVisibility.values : allowedForRun(runVis);
    final visibility = _visibility != null && allowed.contains(_visibility) ? _visibility! : (runVis == RunVisibility.public || runVis == null ? PostVisibility.public : PostVisibility.community);
    final ready = runId == null || run?.hasValue == true;
    return Scaffold(
      appBar: AppBar(
        title: Text(runId == null ? 'Postingan baru' : 'Bagikan hasil lari'),
        actions: [
          TextButton(
            key: const Key('post-submit'),
            onPressed: _busy || !ready ? null : () => _submit(visibility),
            child: Text(_busy ? 'Mengirim…' : 'Posting'),
          ),
        ],
      ),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        if (run != null)
          run.when(
            loading: () => const LinearProgressIndicator(),
            error: (e, _) => Text(ApiError.from(e).message),
            data: (r) => RunCardTile(
              run: FeedRun(
                id: r.summary.id,
                title: r.summary.title,
                startedAt: r.summary.startedAt,
                distanceM: r.summary.distanceM,
                movingTimeS: r.summary.movingTimeS,
                avgPaceSPerKm: r.summary.avgPaceSPerKm,
                // Pratinjau memakai rute publik, sama dengan yang dilihat orang lain.
                route: r.publicRoute ?? const [],
              ),
            ),
          ),
        TextField(
          key: const Key('post-text'),
          controller: _text,
          maxLength: 2000,
          minLines: 3,
          maxLines: 10,
          decoration: const InputDecoration(hintText: 'Ceritakan larimu…', border: OutlineInputBorder()),
        ),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final path in _photos)
            InputChip(label: Text('Foto ${_photos.indexOf(path) + 1}'), onDeleted: () => setState(() => _photos.remove(path))),
          if (_photos.length < 4) ActionChip(avatar: const Icon(Icons.add_photo_alternate_outlined), label: const Text('Tambah foto'), onPressed: _pick),
        ]),
        const SizedBox(height: 16),
        Text('Siapa yang bisa melihat?', style: Theme.of(context).textTheme.titleSmall),
        RadioGroup<PostVisibility>(
          groupValue: visibility,
          onChanged: (v) => setState(() => _visibility = v),
          child: Column(children: [
            for (final v in allowed)
              RadioListTile<PostVisibility>(key: Key('vis-${v.name}'), value: v, contentPadding: EdgeInsets.zero, title: Text(postVisibilityText(v))),
          ]),
        ),
        if (runVis == RunVisibility.community)
          Text('Lari ini hanya untuk anggota komunitasmu, jadi postingannya juga.', style: Theme.of(context).textTheme.bodySmall),
        if (runId != null)
          Text('Rute ditampilkan tanpa area di sekitar titik awal dan akhir (zona privasi).', style: Theme.of(context).textTheme.bodySmall),
      ]),
    );
  }
}

// ---------- Profil feed ----------

class FeedProfileScreen extends ConsumerWidget {
  const FeedProfileScreen({super.key, required this.userId});
  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profile = ref.watch(feedProfileProvider(userId));
    return Scaffold(
      appBar: AppBar(
        title: Text(profile.value?.displayName ?? 'Profil'),
        actions: [
          if (profile.value != null && !profile.value!.isMe)
            PopupMenuButton<String>(
              onSelected: (a) async {
                final p = profile.value!;
                if (a == 'report') {
                  await showReportSheet(context, ref, target: ReportTarget.user, targetId: p.id, title: 'Laporkan ${p.displayName}');
                } else if (a == 'block' && await _confirm(context, 'Blokir ${p.displayName}?', 'Kalian tidak akan saling melihat di feed.', 'Blokir')) {
                  try {
                    await ref.read(feedRepositoryProvider).setBlock(p.id, block: true);
                    if (context.mounted) context.pop();
                  } catch (e) {
                    if (context.mounted) showError(context, e);
                  }
                }
              },
              itemBuilder: (_) => const [
                PopupMenuItem(value: 'report', child: Text('Laporkan')),
                PopupMenuItem(value: 'block', child: Text('Blokir')),
              ],
            ),
        ],
      ),
      body: profile.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(ApiError.from(e).message, textAlign: TextAlign.center))),
        data: (p) => PostList(
          load: (r, c) => r.userPosts(userId, cursor: c),
          empty: 'Belum ada postingan yang bisa kamu lihat.',
          header: Padding(
            padding: const EdgeInsets.all(16),
            child: Row(children: [
              UserAvatar(name: p.displayName, url: p.avatarUrl, radius: 36),
              const SizedBox(width: 16),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(p.displayName, style: Theme.of(context).textTheme.titleLarge),
                  Text('${p.followers} pengikut · ${p.following} mengikuti${p.followsMe ? ' · mengikutimu' : ''}'),
                  if (!p.isMe) ...[
                    const SizedBox(height: 8),
                    p.iFollow
                        ? OutlinedButton(key: const Key('unfollow'), onPressed: () => _follow(context, ref, false), child: const Text('Mengikuti'))
                        : FilledButton(key: const Key('follow'), onPressed: () => _follow(context, ref, true), child: const Text('Ikuti')),
                  ],
                  TextButton.icon(
                    key: const Key('passport'),
                    onPressed: () => context.push(p.isMe ? '/passport' : '/passport/users/${p.id}'),
                    icon: const Icon(Icons.military_tech_outlined),
                    label: const Text('Paspor lari'),
                  ),
                ]),
              ),
            ]),
          ),
        ),
      ),
    );
  }

  Future<void> _follow(BuildContext context, WidgetRef ref, bool follow) async {
    try {
      await ref.read(feedRepositoryProvider).setFollow(userId, follow: follow);
      ref.invalidate(feedProfileProvider(userId));
    } catch (e) {
      if (context.mounted) showError(context, e);
    }
  }
}

/// Pengikut, yang diikuti, dan yang diblokir (hanya milik sendiri).
class FeedConnectionsScreen extends ConsumerWidget {
  const FeedConnectionsScreen({super.key});

  static const _tabs = {'followers': 'Pengikut', 'following': 'Mengikuti', 'blocks': 'Diblokir'};

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return DefaultTabController(
      length: _tabs.length,
      child: Scaffold(
        appBar: AppBar(title: const Text('Jejaring feed'), bottom: TabBar(tabs: [for (final t in _tabs.values) Tab(text: t)])),
        body: TabBarView(children: [for (final which in _tabs.keys) _ConnectionList(which: which)]),
      ),
    );
  }
}

class _ConnectionList extends ConsumerWidget {
  const _ConnectionList({required this.which});
  final String which;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(feedConnectionsProvider(which));
    final repo = ref.read(feedRepositoryProvider);
    Future<void> act(Future<void> Function() fn) async {
      try {
        await fn();
        ref.invalidate(feedConnectionsProvider(which));
      } catch (e) {
        if (context.mounted) showError(context, e);
      }
    }

    return list.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => Center(child: Text(ApiError.from(e).message)),
      data: (items) => items.isEmpty
          ? Center(
              child: Text(switch (which) {
              'followers' => 'Belum ada pengikut',
              'following' => 'Kamu belum mengikuti siapa pun',
              _ => 'Tidak ada yang diblokir',
            }))
          : ListView(children: [
              if (which == 'followers')
                const Padding(
                  padding: EdgeInsets.fromLTRB(16, 12, 16, 4),
                  child: Text('Hanya kamu yang bisa melihat daftar ini. Pengikut melihat postingan "Pengikutku".'),
                ),
              for (final u in items)
                ListTile(
                  leading: UserAvatar(name: u.displayName, url: u.avatarUrl),
                  title: Text(u.displayName),
                  onTap: which == 'blocks' ? null : () => context.push('/feed/users/${u.id}'),
                  trailing: TextButton(
                    onPressed: () => act(() => switch (which) {
                          'followers' => repo.removeFollower(u.id),
                          'following' => repo.setFollow(u.id, follow: false),
                          _ => repo.setBlock(u.id, block: false),
                        }),
                    child: Text(switch (which) { 'followers' => 'Hapus', 'following' => 'Berhenti', _ => 'Buka blokir' }),
                  ),
                ),
            ]),
    );
  }
}

/// Aksi berbagi untuk lari milik sendiri: posting ke feed atau kartu Instagram Story.
Future<void> showRunShareSheet(BuildContext context, WidgetRef ref, RunDetail run) async {
  final choice = await showModalBottomSheet<String>(
    context: context,
    showDragHandle: true,
    builder: (s) => SafeArea(
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        ListTile(
          key: const Key('share-feed'),
          leading: const Icon(Icons.dynamic_feed_outlined),
          title: const Text('Bagikan ke feed'),
          subtitle: run.summary.visibility == RunVisibility.private ? const Text('Ubah visibilitas lari dulu (sekarang: hanya saya)') : null,
          enabled: run.summary.visibility != RunVisibility.private,
          onTap: () => Navigator.pop(s, 'feed'),
        ),
        ListTile(
          key: const Key('share-story'),
          leading: const Icon(Icons.image_outlined),
          title: const Text('Kartu untuk Instagram Story'),
          subtitle: const Text('Gambar 1080×1920 dengan logo komunitas'),
          onTap: () => Navigator.pop(s, 'story'),
        ),
      ]),
    ),
  );
  if (!context.mounted) return;
  if (choice == 'feed') {
    await context.push('/feed/new?runId=${run.summary.id}');
  } else if (choice == 'story') {
    await shareRunCard(context, ref, run);
  }
}
