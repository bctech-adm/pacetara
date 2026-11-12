import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/auth_controller.dart';
import 'chat_outbox.dart';
import 'chat_repository.dart';
import 'chat_room.dart';

/// Batas kanal per koneksi di server adalah 50; sisakan ruang untuk kanal lain (status lari, ruang chat).
const _maxConvSubscriptions = 40;

/// Daftar percakapan. Dimuat ulang saat ada sinyal di kanal pribadi (`user:<id>:chat`, chat pribadi
/// baru) atau di kanal percakapan yang tampil, dengan cadangan polling 60 detik.
final inboxProvider = StreamProvider.autoDispose<List<ConversationSummary>>((ref) {
  final me = ref.watch(authControllerProvider.select((a) => a.value?.id));
  final repo = ref.watch(chatRepositoryProvider);
  final events = ref.watch(chatEventsProvider);
  final out = StreamController<List<ConversationSummary>>();
  final subs = <String, StreamSubscription<Object?>>{};
  Timer? debounce;
  var loading = false;
  var again = false;
  // late: schedule/listenTo dan load saling memanggil.
  late final Future<void> Function() load;

  void schedule() {
    debounce?.cancel();
    debounce = Timer(const Duration(milliseconds: 600), () => unawaited(load()));
  }

  void listenTo(String channel) {
    subs[channel] ??= events(channel).listen((_) => schedule());
  }

  load = () async {
    if (loading) {
      again = true;
      return;
    }
    loading = true;
    try {
      // Kirim antrean pesan yang tertunda (mis. dibuat offline lalu aplikasi ditutup) sebelum memuat daftar.
      final outbox = ref.read(chatOutboxProvider);
      if (outbox != null) await outbox.flush(repo).catchError((_) => 0);
      final items = await repo.conversations();
      if (out.isClosed) return;
      out.add(items);
      final wanted = {for (final c in items.take(_maxConvSubscriptions)) 'conv:${c.id}'};
      if (me != null) wanted.add('user:$me:chat');
      for (final ch in subs.keys.where((k) => !wanted.contains(k)).toList()) {
        unawaited(subs.remove(ch)!.cancel());
      }
      wanted.forEach(listenTo);
    } catch (e, st) {
      if (!out.isClosed) out.addError(e, st);
    } finally {
      loading = false;
      if (again && !out.isClosed) {
        again = false;
        unawaited(load());
      }
    }
  };

  if (me != null) listenTo('user:$me:chat');
  final poll = Timer.periodic(const Duration(seconds: 60), (_) => unawaited(load()));
  unawaited(load());

  ref.onDispose(() {
    debounce?.cancel();
    poll.cancel();
    for (final s in subs.values) {
      unawaited(s.cancel());
    }
    unawaited(out.close());
  });
  return out.stream;
});

/// Jumlah total pesan belum dibaca (lencana tab Chat).
final unreadTotalProvider = Provider.autoDispose<int>((ref) {
  final list = ref.watch(inboxProvider).value ?? const <ConversationSummary>[];
  return list.fold(0, (n, c) => n + c.unread);
});

/// Ringkasan satu percakapan (judul layar chat).
final conversationProvider =
    FutureProvider.autoDispose.family<ConversationSummary, String>((ref, id) => ref.watch(chatRepositoryProvider).conversation(id));
