import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/config.dart';
import 'notifications_repository.dart';

/// Mendaftarkan perangkat untuk push FCM selama beranda terbuka (pengguna login dan Level 1).
/// Logout menghapus token di server (terikat sesi), jadi tidak perlu langkah tambahan saat keluar.
/// Tanpa konfigurasi Firebase (dart-define), widget ini tidak melakukan apa pun.
class PushRegistrar extends ConsumerStatefulWidget {
  const PushRegistrar({super.key, required this.child});
  final Widget child;

  @override
  ConsumerState<PushRegistrar> createState() => _PushRegistrarState();
}

class _PushRegistrarState extends ConsumerState<PushRegistrar> {
  final _subs = <StreamSubscription<Object?>>[];

  @override
  void initState() {
    super.initState();
    if (AppConfig.pushConfigured) WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(_setup()));
  }

  @override
  void dispose() {
    for (final s in _subs) {
      unawaited(s.cancel());
    }
    super.dispose();
  }

  Future<void> _setup() async {
    try {
      if (Firebase.apps.isEmpty) {
        await Firebase.initializeApp(
          options: const FirebaseOptions(
            apiKey: AppConfig.firebaseApiKey,
            appId: AppConfig.firebaseAppId,
            messagingSenderId: AppConfig.firebaseSenderId,
            projectId: AppConfig.firebaseProjectId,
          ),
        );
      }
      final fm = FirebaseMessaging.instance;
      // Android 13+: dialog izin notifikasi.
      final perm = await fm.requestPermission();
      if (perm.authorizationStatus == AuthorizationStatus.denied) return;
      final repo = ref.read(notificationsRepositoryProvider);
      Future<void> register(String token) => repo.registerPushToken(token).catchError((_) {});
      // getToken/onTokenRefresh usang di firebase_messaging 17 (diganti register()/onRegistered yang
      // memberi Firebase Installation ID). Server mengirim lewat FCM HTTP v1 ke token registrasi, jadi
      // tetap memakai token sampai pengiriman ke FID terbukti didukung (KEPUTUSAN.md).
      // ignore: deprecated_member_use
      final token = await fm.getToken();
      if (token != null) await register(token);
      // ignore: deprecated_member_use
      _subs.add(fm.onTokenRefresh.listen((t) => unawaited(register(t))));
      // Push saat aplikasi terbuka tidak ditampilkan sistem; cukup segarkan lonceng.
      _subs.add(FirebaseMessaging.onMessage.listen((_) => ref.invalidate(notificationsProvider)));
      _subs.add(FirebaseMessaging.onMessageOpenedApp.listen(_open));
      final initial = await fm.getInitialMessage();
      if (initial != null) _open(initial);
    } catch (_) {
      // Push opsional: kegagalan (mis. Google Play Services tidak ada) tidak mengganggu aplikasi.
    }
  }

  void _open(RemoteMessage m) {
    final route = routeForPush(m.data);
    if (route != null && mounted) unawaited(context.push(route));
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
