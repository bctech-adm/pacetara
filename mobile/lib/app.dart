import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'features/auth/auth_controller.dart';
import 'features/auth/models.dart';
import 'features/auth/screens/forgot_password_screen.dart';
import 'features/auth/screens/login_screen.dart';
import 'features/auth/screens/register_screen.dart';
import 'features/auth/screens/verify_screens.dart';
import 'features/home/home_screen.dart';
import 'features/profile/profile_screen.dart';

const _publicRoutes = {'/login', '/register', '/forgot-password'};

/// Ke mana pengguna harus diarahkan berdasarkan status login dan verifikasi.
/// Null = boleh tetap di [location].
@visibleForTesting
String? authRedirect(AsyncValue<MyProfile?> auth, String location) {
  // Memuat, atau server tak terjangkau saat membuka aplikasi: tetap di splash (ada tombol coba lagi),
  // jangan anggap pengguna keluar.
  if (!auth.hasValue) return location == '/splash' ? null : '/splash';
  final profile = auth.value;
  if (profile == null) return _publicRoutes.contains(location) ? null : '/login';
  if (!profile.emailVerified) return location == '/verify-email' ? null : '/verify-email';
  if (!profile.phoneVerified) return location == '/verify-phone' ? null : '/verify-phone';
  if (_publicRoutes.contains(location) || location.startsWith('/verify') || location == '/splash') return '/';
  return null;
}

final routerProvider = Provider<GoRouter>((ref) {
  final refresh = ValueNotifier<int>(0);
  ref.listen(authControllerProvider, (_, _) => refresh.value++);
  ref.onDispose(refresh.dispose);

  return GoRouter(
    initialLocation: '/splash',
    refreshListenable: refresh,
    redirect: (context, state) => authRedirect(ref.read(authControllerProvider), state.matchedLocation),
    routes: [
      GoRoute(path: '/splash', builder: (_, _) => const _Splash()),
      GoRoute(path: '/login', builder: (_, _) => const LoginScreen()),
      GoRoute(path: '/register', builder: (_, _) => const RegisterScreen()),
      GoRoute(path: '/forgot-password', builder: (_, _) => const ForgotPasswordScreen()),
      GoRoute(path: '/verify-email', builder: (_, _) => const VerifyEmailScreen()),
      GoRoute(path: '/verify-phone', builder: (_, _) => const VerifyPhoneScreen()),
      GoRoute(path: '/', builder: (_, _) => const HomeScreen()),
      GoRoute(path: '/profile', builder: (_, _) => const ProfileScreen()),
    ],
  );
});

const _brand = Color(0xFFF0590E);

class PaceTaraApp extends ConsumerWidget {
  const PaceTaraApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp.router(
      title: 'PaceTara',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorSchemeSeed: _brand, useMaterial3: true),
      darkTheme: ThemeData(colorSchemeSeed: _brand, brightness: Brightness.dark, useMaterial3: true),
      routerConfig: ref.watch(routerProvider),
    );
  }
}

class _Splash extends ConsumerWidget {
  const _Splash();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authControllerProvider);
    return Scaffold(
      body: Center(
        child: auth.hasError
            ? Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text('Tidak bisa terhubung ke server'),
                  TextButton(onPressed: () => ref.invalidate(authControllerProvider), child: const Text('Coba lagi')),
                ],
              )
            : const CircularProgressIndicator(),
      ),
    );
  }
}
