import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config.dart';
import '../http/api_client.dart';
import '../http/pinned_security_context.dart';
import '../session/session_manager.dart';

/// Event yang diterima dari satu kanal. [name] = `reconnected` jika koneksi baru tersambung ulang
/// (event selama terputus mungkin terlewat, jadi pendengar sebaiknya memuat ulang datanya).
class RealtimeEvent {
  const RealtimeEvent(this.channel, this.name, [this.data]);
  final String channel;
  final String name;

  /// Data kecil tanpa isi pribadi (mis. `seq` atau id pesan).
  final Map<String, dynamic>? data;
}

/// Membuka WebSocket. Di aplikasi: `WebSocket.connect` dengan HttpClient ber-pinning.
typedef WebSocketConnector = Future<WebSocket> Function(Uri url, Map<String, String> headers);

/// Klien WebSocket bersama (status lari, nanti chat).
///
/// - Token akses dikirim di header `Authorization` saat handshake, tidak pernah di URL.
/// - Koneksi memakai certificate pinning yang sama dengan Dio.
/// - Tersambung hanya selama ada kanal yang didengarkan; tersambung ulang otomatis dengan jeda
///   bertambah. Server menutup koneksi (4001) saat token akses kedaluwarsa → sesi diperpanjang
///   lalu tersambung lagi.
/// - Pesan dari server hanya sinyal; data diambil lewat REST yang diperiksa hak aksesnya.
class RealtimeClient {
  RealtimeClient({required this.session, required this.refresh, required this.connector, Uri? url})
      : url = url ?? wsUrl(AppConfig.apiBaseUrl);

  final SessionManager session;

  /// Memperpanjang sesi (single-flight lewat [SessionManager]).
  final Future<bool> Function() refresh;
  final WebSocketConnector connector;
  final Uri url;

  final _channels = <String, StreamController<RealtimeEvent>>{};
  WebSocket? _ws;
  StreamSubscription<dynamic>? _wsSub;
  Timer? _retry;
  Timer? _ping;
  int _attempt = 0;
  bool _connecting = false;
  bool _everConnected = false;
  bool _disposed = false;

  static Uri wsUrl(String apiBaseUrl) {
    final base = Uri.parse(apiBaseUrl);
    return base.replace(scheme: base.scheme == 'http' ? 'ws' : 'wss', path: '/v1/ws');
  }

  /// Aliran event satu kanal. Berlangganan saat didengarkan, berhenti saat semua pendengar batal.
  Stream<RealtimeEvent> channel(String name) {
    final existing = _channels[name];
    if (existing != null) return existing.stream;
    late final StreamController<RealtimeEvent> c;
    c = StreamController<RealtimeEvent>.broadcast(
      onListen: () {
        _send({'op': 'sub', 'ch': name});
        unawaited(_ensureConnected());
      },
      onCancel: () {
        _channels.remove(name);
        _send({'op': 'unsub', 'ch': name});
        unawaited(c.close());
        if (_channels.isEmpty) _disconnect();
      },
    );
    _channels[name] = c;
    return c.stream;
  }

  bool get isConnected => _ws != null;

  void dispose() {
    _disposed = true;
    for (final c in _channels.values) {
      unawaited(c.close());
    }
    _channels.clear();
    _disconnect();
  }

  // ---------- Koneksi ----------

  Future<void> _ensureConnected() async {
    if (_disposed || _ws != null || _connecting || _channels.isEmpty) return;
    _retry?.cancel();
    _connecting = true;
    try {
      if (_expiresSoon(session.accessToken)) await refresh();
      final token = session.accessToken;
      if (token == null) {
        _scheduleRetry();
        return;
      }
      final ws = await connector(url, {'Authorization': 'Bearer $token'});
      if (_disposed || _channels.isEmpty) {
        await ws.close(1000);
        return;
      }
      _ws = ws;
      _attempt = 0;
      _wsSub = ws.listen(_onMessage, onDone: _onDone, onError: (_) {}, cancelOnError: false);
      _ping = Timer.periodic(const Duration(seconds: 25), (_) => _send({'op': 'ping'}));
      for (final ch in _channels.keys) {
        _send({'op': 'sub', 'ch': ch});
      }
      if (_everConnected) {
        for (final e in _channels.entries) {
          e.value.add(RealtimeEvent(e.key, 'reconnected'));
        }
      }
      _everConnected = true;
    } catch (e) {
      if (kDebugMode) debugPrint('WebSocket gagal tersambung: $e');
      // Handshake ditolak bisa karena token kedaluwarsa (jam HP tidak tepat): perpanjang sebelum mencoba lagi.
      if (_attempt >= 1) await refresh();
      _scheduleRetry();
    } finally {
      _connecting = false;
    }
  }

  void _onMessage(dynamic raw) {
    if (raw is! String) return;
    final Object? msg;
    try {
      msg = jsonDecode(raw);
    } catch (_) {
      return;
    }
    if (msg is! Map<String, dynamic> || msg['op'] != 'event') return;
    final ch = msg['ch'];
    final ev = msg['ev'];
    final data = msg['data'];
    if (ch is String && ev is String) _channels[ch]?.add(RealtimeEvent(ch, ev, data is Map<String, dynamic> ? data : null));
  }

  void _onDone() {
    final code = _ws?.closeCode;
    _cleanupSocket();
    if (_disposed || _channels.isEmpty) return;
    if (code == 4001) {
      // Token akses kedaluwarsa: perpanjang lalu sambung lagi segera.
      unawaited(refresh().then((_) => _ensureConnected()));
    } else {
      _scheduleRetry();
    }
  }

  void _scheduleRetry() {
    if (_disposed || _channels.isEmpty) return;
    final seconds = math.min(30, 1 << math.min(_attempt, 5));
    _attempt++;
    _retry?.cancel();
    _retry = Timer(Duration(seconds: seconds), () => unawaited(_ensureConnected()));
  }

  void _send(Map<String, Object?> msg) {
    final ws = _ws;
    if (ws != null && ws.readyState == WebSocket.open) ws.add(jsonEncode(msg));
  }

  void _cleanupSocket() {
    _ping?.cancel();
    _ping = null;
    unawaited(_wsSub?.cancel());
    _wsSub = null;
    _ws = null;
  }

  void _disconnect() {
    _retry?.cancel();
    final ws = _ws;
    _cleanupSocket();
    if (ws != null) unawaited(ws.close(1000));
  }

  /// Token akses berakhir dalam < 30 detik (dibaca dari klaim `exp`, tanpa verifikasi).
  static bool _expiresSoon(String? jwt) {
    if (jwt == null) return true;
    try {
      final parts = jwt.split('.');
      final payload = jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(parts[1])))) as Map<String, dynamic>;
      final exp = (payload['exp'] as num).toInt();
      return DateTime.fromMillisecondsSinceEpoch(exp * 1000).isBefore(DateTime.now().add(const Duration(seconds: 30)));
    } catch (_) {
      return false;
    }
  }
}

final webSocketConnectorProvider = Provider<WebSocketConnector>((ref) {
  final ctx = ref.watch(securityContextProvider);
  return (url, headers) => WebSocket.connect(url.toString(), headers: headers, customClient: createPinnedHttpClient(ctx))
      .timeout(const Duration(seconds: 15));
});

final realtimeClientProvider = Provider<RealtimeClient>((ref) {
  final session = ref.watch(sessionManagerProvider);
  final Dio bare = ref.watch(bareDioProvider);
  final client = RealtimeClient(
    session: session,
    refresh: () => session.refresh(bare),
    connector: ref.watch(webSocketConnectorProvider),
  );
  ref.onDispose(client.dispose);
  return client;
});
