import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_error.dart';
import '../../core/realtime/realtime_client.dart';
import 'chat_repository.dart';

class ChatRoomState {
  const ChatRoomState({this.messages = const [], this.hasMore = true, this.loading = true, this.loadingOlder = false, this.error});

  /// Urut naik (lama → baru); pesan yang belum terkirim di akhir.
  final List<ChatMessage> messages;
  final bool hasMore;
  final bool loading;
  final bool loadingOlder;
  final String? error;

  int? get newestSeq {
    for (final m in messages.reversed) {
      if (!m.isPending) return m.seq;
    }
    return null;
  }

  int? get oldestSeq {
    for (final m in messages) {
      if (!m.isPending) return m.seq;
    }
    return null;
  }

  ChatRoomState copy({List<ChatMessage>? messages, bool? hasMore, bool? loading, bool? loadingOlder, String? error, bool clearError = false}) =>
      ChatRoomState(
        messages: messages ?? this.messages,
        hasMore: hasMore ?? this.hasMore,
        loading: loading ?? this.loading,
        loadingOlder: loadingOlder ?? this.loadingOlder,
        error: clearError ? null : (error ?? this.error),
      );
}

/// Sumber pesan yang bisa dipalsukan di tes.
typedef ChatEvents = Stream<RealtimeEvent> Function(String channel);

final chatEventsProvider = Provider<ChatEvents>((ref) {
  final rt = ref.watch(realtimeClientProvider);
  return rt.channel;
});

/// Satu percakapan: riwayat bertahap, sinkron lewat sinyal WebSocket, kirim dengan id klien
/// (kirim ulang aman), dan menandai pesan sudah dibaca.
class ChatRoomController extends Notifier<ChatRoomState> {
  ChatRoomController(this.convId);
  final String convId;

  StreamSubscription<RealtimeEvent>? _sub;
  bool _syncing = false;
  bool _syncAgain = false;
  int _readSeq = 0;
  Timer? _poll;

  ChatRepository get _repo => ref.read(chatRepositoryProvider);

  @override
  ChatRoomState build() {
    _sub = ref.read(chatEventsProvider)('conv:$convId').listen(_onEvent);
    // Cadangan jika WebSocket terputus lama.
    _poll = Timer.periodic(const Duration(seconds: 30), (_) => unawaited(sync()));
    ref.onDispose(() {
      unawaited(_sub?.cancel());
      _poll?.cancel();
    });
    unawaited(_loadInitial());
    return const ChatRoomState();
  }

  Future<void> _loadInitial() async {
    try {
      final page = await _repo.messages(convId);
      state = state.copy(messages: _merge(state.messages, page.items), hasMore: page.hasMore, loading: false, clearError: true);
      unawaited(_markRead());
    } catch (e) {
      state = state.copy(loading: false, error: ApiError.from(e).message);
    }
  }

  Future<void> loadOlder() async {
    final oldest = state.oldestSeq;
    if (!state.hasMore || state.loadingOlder || oldest == null) return;
    state = state.copy(loadingOlder: true);
    try {
      final page = await _repo.messages(convId, before: oldest);
      state = state.copy(messages: _merge(state.messages, page.items), hasMore: page.hasMore, loadingOlder: false);
    } catch (_) {
      state = state.copy(loadingOlder: false);
    }
  }

  /// Ambil pesan baru setelah seq terbaru yang dimiliki.
  Future<void> sync() async {
    if (_syncing) {
      _syncAgain = true;
      return;
    }
    _syncing = true;
    try {
      var more = true;
      while (more) {
        final after = state.newestSeq;
        if (after == null) {
          final page = await _repo.messages(convId);
          state = state.copy(messages: _merge(state.messages, page.items), hasMore: page.hasMore, loading: false);
          break;
        }
        final page = await _repo.messages(convId, after: after, limit: 100);
        state = state.copy(messages: _merge(state.messages, page.items));
        more = page.hasMore;
      }
      unawaited(_markRead());
    } catch (e) {
      if (kDebugMode) debugPrint('Sinkron chat gagal: $e');
    } finally {
      _syncing = false;
      if (_syncAgain) {
        _syncAgain = false;
        unawaited(sync());
      }
    }
  }

  void _onEvent(RealtimeEvent e) {
    switch (e.name) {
      case 'message.updated':
        final id = e.data?['id'];
        if (id is String) unawaited(_refreshMessage(id));
      default:
        unawaited(sync());
    }
  }

  Future<void> _refreshMessage(String id) async {
    try {
      _replace(await _repo.message(id));
    } catch (_) {}
  }

  // ---------- Kirim ----------

  Future<void> sendText(String text, {required String senderId, required String senderName}) =>
      _send(_local(kind: 'text', text: text, senderId: senderId, senderName: senderName), (m) => _repo.sendText(convId, m.clientMsgId!, text));

  Future<void> sendInvite(RunInvite invite, {required String senderId, required String senderName}) => _send(
        _local(kind: 'run_invite', invite: invite, senderId: senderId, senderName: senderName),
        (m) => _repo.sendInvite(convId, m.clientMsgId!, invite),
      );

  Future<void> sendImage(String path, {required String senderId, required String senderName}) => _send(
        _local(kind: 'image', localImagePath: path, senderId: senderId, senderName: senderName),
        (m) => _repo.sendImage(convId, m.clientMsgId!, path),
      );

  /// Kirim ulang pesan yang gagal dengan clientMsgId yang sama (server tidak membuat pesan ganda).
  Future<void> retry(ChatMessage failed) {
    final again = failed.withState(SendState.sending);
    return _send(again, (m) => switch (m.kind) {
          'image' => _repo.sendImage(convId, m.clientMsgId!, m.localImagePath!),
          'run_invite' => _repo.sendInvite(convId, m.clientMsgId!, m.invite!),
          _ => _repo.sendText(convId, m.clientMsgId!, m.text!),
        });
  }

  void discard(ChatMessage failed) {
    state = state.copy(messages: state.messages.where((m) => m.clientMsgId != failed.clientMsgId || !m.isPending).toList());
  }

  Future<void> _send(ChatMessage local, Future<ChatMessage> Function(ChatMessage) call) async {
    state = state.copy(messages: [...state.messages.where((m) => m.clientMsgId != local.clientMsgId || !m.isPending), local]);
    try {
      final saved = await call(local);
      final rest = state.messages.where((m) => !(m.isPending && m.clientMsgId == local.clientMsgId)).toList();
      state = state.copy(messages: _merge(rest, [saved]));
      _readSeq = math.max(_readSeq, saved.seq);
    } catch (e) {
      state = state.copy(
        messages: [for (final m in state.messages) m.isPending && m.clientMsgId == local.clientMsgId ? m.withState(SendState.failed) : m],
      );
      rethrow;
    }
  }

  ChatMessage _local({
    required String kind,
    required String senderId,
    required String senderName,
    String? text,
    RunInvite? invite,
    String? localImagePath,
  }) {
    final clientMsgId = newClientId();
    return ChatMessage(
      id: 'local-$clientMsgId',
      seq: -1,
      senderId: senderId,
      senderName: senderName,
      senderAvatarUrl: null,
      isMine: true,
      kind: kind,
      createdAt: DateTime.now(),
      text: text,
      invite: invite,
      localImagePath: localImagePath,
      clientMsgId: clientMsgId,
      sendState: SendState.sending,
    );
  }

  // ---------- Lainnya ----------

  Future<void> delete(ChatMessage m) async {
    await _repo.delete(m.id);
    await _refreshMessage(m.id);
  }

  Future<void> rsvp(ChatMessage m, {required bool going}) async => _replace(await _repo.rsvp(m.id, going: going));

  Future<void> _markRead() async {
    final newest = state.newestSeq;
    if (newest == null || newest <= _readSeq) return;
    _readSeq = newest;
    try {
      await _repo.markRead(convId, newest);
    } catch (_) {}
  }

  void _replace(ChatMessage updated) {
    state = state.copy(messages: [for (final m in state.messages) m.id == updated.id ? updated : m]);
  }

  /// Gabung tanpa duplikat (per id), urut seq; pesan lokal yang belum terkirim tetap di akhir.
  static List<ChatMessage> _merge(List<ChatMessage> current, List<ChatMessage> incoming) {
    final byId = <String, ChatMessage>{for (final m in current.where((m) => !m.isPending)) m.id: m};
    for (final m in incoming) {
      byId[m.id] = m;
    }
    final sent = byId.values.toList()..sort((a, b) => a.seq.compareTo(b.seq));
    return [...sent, ...current.where((m) => m.isPending)];
  }
}

final chatRoomProvider = NotifierProvider.autoDispose.family<ChatRoomController, ChatRoomState, String>(ChatRoomController.new);

final _rand = math.Random.secure();

/// UUID v4 untuk id klien pesan (kirim ulang idempoten).
String newClientId() {
  final r = List<int>.generate(16, (_) => _rand.nextInt(256));
  r[6] = (r[6] & 0x0f) | 0x40;
  r[8] = (r[8] & 0x3f) | 0x80;
  final h = r.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}
