// Tes ini memakai socket sungguhan (server WebSocket lokal), jadi sengaja tanpa testWidgets:
// binding widget memalsukan HttpClient untuk seluruh berkas.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pacetara/core/realtime/realtime_client.dart';
import 'package:pacetara/core/session/session_manager.dart';
import 'package:pacetara/core/storage/token_storage.dart';

class MemoryTokenStorage implements TokenStorage {
  String? access;
  String? refresh;
  @override
  Future<String?> readAccess() async => access;
  @override
  Future<String?> readRefresh() async => refresh;
  @override
  Future<void> save({required String access, required String refresh}) async {
    this.access = access;
    this.refresh = refresh;
  }

  @override
  Future<void> clear() async {
    access = null;
    refresh = null;
  }
}

/// JWT palsu (tanpa tanda tangan sah) dengan klaim exp; klien hanya membaca exp-nya.
String fakeJwt(String id, {Duration ttl = const Duration(minutes: 15)}) {
  String b64(Map<String, Object> m) => base64Url.encode(utf8.encode(jsonEncode(m))).replaceAll('=', '');
  final exp = DateTime.now().add(ttl).millisecondsSinceEpoch ~/ 1000;
  return '${b64({'alg': 'HS256'})}.${b64({'sub': id, 'exp': exp})}.sig';
}

void main() {
  test('wsUrl: https → wss, path /v1/ws, tanpa token di URL', () {
    expect(RealtimeClient.wsUrl('https://pace-api.bimacreative.tech').toString(), 'wss://pace-api.bimacreative.tech/v1/ws');
    expect(RealtimeClient.wsUrl('https://api.localhost:8443').toString(), 'wss://api.localhost:8443/v1/ws');
  });

  group('RealtimeClient dengan server lokal', () {
    late HttpServer server;
    late SessionManager session;
    late RealtimeClient client;
    final auth = <String?>[];
    final received = <Map<String, dynamic>>[];
    final sockets = <WebSocket>[];
    var refreshes = 0;

    setUp(() async {
      auth.clear();
      received.clear();
      sockets.clear();
      refreshes = 0;
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((req) async {
        auth.add(req.headers.value('authorization'));
        final ws = await WebSocketTransformer.upgrade(req);
        sockets.add(ws);
        ws.add(jsonEncode({'op': 'ready'}));
        ws.listen((raw) {
          final m = jsonDecode(raw as String) as Map<String, dynamic>;
          received.add(m);
          if (m['op'] == 'sub') ws.add(jsonEncode({'op': 'subscribed', 'ch': m['ch']}));
        });
      });

      session = SessionManager(MemoryTokenStorage());
      await session.save(TokenPair(accessToken: fakeJwt('t1'), refreshToken: 'r1'));
      client = RealtimeClient(
        session: session,
        refresh: () async {
          refreshes++;
          await session.save(TokenPair(accessToken: fakeJwt('t${refreshes + 1}'), refreshToken: 'r${refreshes + 1}'));
          return true;
        },
        connector: (url, headers) => WebSocket.connect(url.toString(), headers: headers),
        url: Uri.parse('ws://127.0.0.1:${server.port}/v1/ws'),
      );
    });

    tearDown(() async {
      client.dispose();
      await server.close(force: true);
    });

    Future<void> until(bool Function() cond) async {
      for (var i = 0; i < 200 && !cond(); i++) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
      expect(cond(), isTrue);
    }

    test('berlangganan dengan token di header, meneruskan event, dan menutup saat tidak didengarkan', () async {
      const ch = 'community:abc:live';
      final events = <RealtimeEvent>[];
      final sub = client.channel(ch).listen(events.add);

      await until(() => received.any((m) => m['op'] == 'sub' && m['ch'] == ch));
      expect(auth.single, 'Bearer ${session.accessToken}');

      sockets.single.add(jsonEncode({'op': 'event', 'ch': ch, 'ev': 'live.changed'}));
      sockets.single.add(jsonEncode({'op': 'event', 'ch': 'community:lain:live', 'ev': 'live.changed'}));
      await until(() => events.isNotEmpty);
      expect(events.single.name, 'live.changed');

      await sub.cancel();
      await until(() => sockets.single.closeCode != null);
      expect(client.isConnected, isFalse);
    });

    test('token kedaluwarsa (4001): sesi diperpanjang, tersambung ulang, dan berlangganan lagi', () async {
      const ch = 'community:abc:live';
      final events = <RealtimeEvent>[];
      final sub = client.channel(ch).listen(events.add);
      await until(() => received.where((m) => m['op'] == 'sub').length == 1);

      await sockets.single.close(4001, 'token_expired');
      await until(() => sockets.length == 2 && received.where((m) => m['op'] == 'sub').length == 2);
      expect(refreshes, 1);
      expect(auth.last, 'Bearer ${session.accessToken}');
      expect(auth.last, isNot(auth.first));
      // Event yang mungkin terlewat saat terputus → pendengar diminta memuat ulang.
      await until(() => events.any((e) => e.name == 'reconnected'));
      await sub.cancel();
    });

    test('token hampir kedaluwarsa diperpanjang sebelum menyambung', () async {
      await session.save(TokenPair(accessToken: fakeJwt('old', ttl: const Duration(seconds: 5)), refreshToken: 'r'));
      final sub = client.channel('community:abc:live').listen((_) {});
      await until(() => auth.isNotEmpty);
      expect(refreshes, 1);
      expect(auth.single, 'Bearer ${session.accessToken}');
      await sub.cancel();
    });
  });
}
