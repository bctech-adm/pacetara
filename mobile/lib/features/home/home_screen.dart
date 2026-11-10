import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../auth/auth_controller.dart';
import '../profile/profile_screen.dart';

/// Beranda sementara. Komunitas (1.3), lari (1.4), dan status lari (1.5) mengisi layar ini.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profile = ref.watch(authControllerProvider).value;
    final theme = Theme.of(context);
    if (profile == null) return const Scaffold(body: Center(child: CircularProgressIndicator()));

    return Scaffold(
      appBar: AppBar(
        title: const Text('PaceTara'),
        actions: [
          IconButton(
            tooltip: 'Profil',
            onPressed: () => context.push('/profile'),
            icon: Avatar(profile: profile, radius: 16),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.verified_user_outlined, size: 64, color: theme.colorScheme.primary),
              const SizedBox(height: 16),
              Text('Halo, ${profile.displayName}!', style: theme.textTheme.titleLarge, textAlign: TextAlign.center),
              const SizedBox(height: 8),
              Text(
                'Akun kamu sudah terverifikasi (Level ${profile.verificationLevel}). '
                'Komunitas dan pelacakan lari segera hadir.',
                textAlign: TextAlign.center,
                key: const Key('home-level'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
