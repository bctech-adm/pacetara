import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../core/api/api_error.dart';
import '../auth/auth_controller.dart';
import 'chat_repository.dart';

/// Penyimpanan antrean (bisa dipalsukan di tes).
abstract class OutboxStore {
  Future<String?> read(String key);
  Future<void> write(String key, String? value);
}

/// Bawaan: Android Keystore lewat flutter_secure_storage (isi pesan tidak pernah ditulis ke berkas biasa).
class SecureOutboxStore implements OutboxStore {
  const SecureOutboxStore([this._s = const FlutterSecureStorage()]);
  final FlutterSecureStorage _s;

  @override
  Future<String?> read(String key) => _s.read(key: key);

  @override
  Future<void> write(String key, String? value) => value == null ? _s.delete(key: key) : _s.write(key: key, value: value);
}

/// Satu pesan yang belum terkirim. Hanya teks dan ajakan lari (gambar tidak disimpan: berkas sementaranya bisa hilang).
class OutboxEntry {
  const OutboxEntry({
    required this.clientMsgId,
    required this.convId,
    required this.kind,
    required this.senderName,
    required this.createdAt,
    this.text,
    this.invite,
  });

  final String clientMsgId;
  final String convId;
  final String kind;
  final String senderName;
  final DateTime createdAt;
  final String? text;
  final RunInvite? invite;

  Map<String, Object?> toJson() => {
        'c': clientMsgId,
        'v': convId,
        'k': kind,
        'n': senderName,
        't': createdAt.toUtc().toIso8601String(),
        if (text != null) 'x': text,
        if (invite != null) 'i': invite!.toJson(),
      };

  static OutboxEntry? fromJson(Object? raw) {
    if (raw is! Map<String, dynamic>) return null;
    try {
      return OutboxEntry(
        clientMsgId: raw['c'] as String,
        convId: raw['v'] as String,
        kind: raw['k'] as String,
        senderName: raw['n'] as String? ?? '',
        createdAt: DateTime.parse(raw['t'] as String),
        text: raw['x'] as String?,
        invite: raw['i'] == null ? null : RunInvite.fromJson(raw['i'] as Map<String, dynamic>),
      );
    } catch (_) {
      return null;
    }
  }
}

/// Antrean kirim chat yang bertahan setelah aplikasi ditutup, per akun. Kirim ulang memakai clientMsgId yang sama,
/// jadi server tidak pernah membuat pesan ganda. Maks. [maxEntries] pesan, kedaluwarsa setelah [maxAge].
class ChatOutbox {
  ChatOutbox(this._store, this.ownerId);
  final OutboxStore _store;
  final String ownerId;

  static const maxEntries = 50;
  static const maxAge = Duration(days: 7);

  String get _key => _keyFor(ownerId);
  static String _keyFor(String ownerId) => 'chat_outbox_v1_$ownerId';

  /// Hapus seluruh antrean satu akun (hapus akun).
  static Future<void> clear(OutboxStore store, String ownerId) => store.write(_keyFor(ownerId), null);
  Future<void> _lock = Future.value();

  /// Jalankan berurutan agar baca-ubah-tulis tidak saling menimpa.
  Future<T> _serial<T>(Future<T> Function() fn) {
    final next = _lock.then((_) => fn());
    _lock = next.then((_) {}, onError: (_) {});
    return next;
  }

  Future<List<OutboxEntry>> _read() async {
    final raw = await _store.read(_key);
    if (raw == null) return [];
    try {
      final cutoff = DateTime.now().subtract(maxAge);
      return (jsonDecode(raw) as List<dynamic>).map(OutboxEntry.fromJson).whereType<OutboxEntry>().where((e) => e.createdAt.isAfter(cutoff)).toList();
    } catch (_) {
      return [];
    }
  }

  Future<void> _write(List<OutboxEntry> list) => _store.write(_key, list.isEmpty ? null : jsonEncode([for (final e in list) e.toJson()]));

  Future<List<OutboxEntry>> all() => _serial(_read);

  Future<List<OutboxEntry>> forConversation(String convId) async => (await all()).where((e) => e.convId == convId).toList();

  Future<void> add(OutboxEntry entry) => _serial(() async {
        final list = [...(await _read()).where((e) => e.clientMsgId != entry.clientMsgId), entry];
        await _write(list.length > maxEntries ? list.sublist(list.length - maxEntries) : list);
      });

  Future<void> remove(String clientMsgId) => _serial(() async {
        final list = await _read();
        final rest = list.where((e) => e.clientMsgId != clientMsgId).toList();
        if (rest.length != list.length) await _write(rest);
      });

  /// Kirim semua antrean (mis. saat kotak masuk dibuka). Berhenti pada galat sementara (masih offline).
  Future<int> flush(ChatRepository repo) async {
    var sent = 0;
    for (final e in await all()) {
      try {
        await send(repo, e);
        await remove(e.clientMsgId);
        sent++;
      } catch (err) {
        if (isPermanentSendError(err)) {
          await remove(e.clientMsgId);
        } else {
          break;
        }
      }
    }
    return sent;
  }

  static Future<ChatMessage> send(ChatRepository repo, OutboxEntry e) => e.kind == 'run_invite' && e.invite != null
      ? repo.sendInvite(e.convId, e.clientMsgId, e.invite!)
      : repo.sendText(e.convId, e.clientMsgId, e.text ?? '');
}

/// Galat yang tidak akan berhasil walau dikirim ulang (diblokir, bukan peserta, isi tidak sah). Tanpa koneksi = 0.
bool isPermanentSendError(Object e) {
  final s = ApiError.from(e).status;
  return s >= 400 && s < 500 && s != 408 && s != 429;
}

/// Antrean akun yang sedang masuk; null sebelum masuk.
final chatOutboxProvider = Provider<ChatOutbox?>((ref) {
  final me = ref.watch(authControllerProvider.select((a) => a.value?.id));
  return me == null ? null : ChatOutbox(const SecureOutboxStore(), me);
});
