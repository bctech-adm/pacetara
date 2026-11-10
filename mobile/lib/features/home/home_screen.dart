import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/http/api_client.dart';

/// Layar sementara modul 1.1: memastikan aplikasi bisa menjangkau API lewat HTTPS ter-pin.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final health = ref.watch(apiHealthProvider);
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(title: const Text('PaceTara')),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.directions_run, size: 72, color: theme.colorScheme.primary),
              const SizedBox(height: 16),
              Text('Komunitas lari Indonesia', style: theme.textTheme.titleMedium),
              const SizedBox(height: 32),
              health.when(
                loading: () => const CircularProgressIndicator(),
                error: (e, _) => Column(
                  children: [
                    const Text('Server tidak bisa dijangkau'),
                    TextButton(
                      onPressed: () => ref.invalidate(apiHealthProvider),
                      child: const Text('Coba lagi'),
                    ),
                  ],
                ),
                data: (h) => Text(
                  h.status == 'ok' ? 'Terhubung ke server' : 'Server bermasalah (${h.status})',
                  key: const Key('health-status'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
