import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/widgets/common.dart';
import '../communities_repository.dart';
import '../models.dart';
import '../widgets.dart';

/// Direktori komunitas dengan pencarian nama dan filter kota.
class DirectoryScreen extends ConsumerStatefulWidget {
  const DirectoryScreen({super.key});

  @override
  ConsumerState<DirectoryScreen> createState() => _DirectoryScreenState();
}

class _DirectoryScreenState extends ConsumerState<DirectoryScreen> {
  final _search = TextEditingController();
  Timer? _debounce;
  String? _city;
  final List<CommunitySummary> _items = [];
  String? _cursor;
  bool _loading = false;
  bool _done = false;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  @override
  void dispose() {
    _search.dispose();
    _debounce?.cancel();
    super.dispose();
  }

  Future<void> _reload() async {
    _generation++;
    setState(() {
      _items.clear();
      _cursor = null;
      _done = false;
    });
    await _loadMore();
  }

  Future<void> _loadMore() async {
    if (_loading || _done) return;
    final gen = _generation;
    setState(() => _loading = true);
    try {
      final page = await ref.read(communitiesRepositoryProvider).directory(city: _city, search: _search.text.trim(), cursor: _cursor);
      if (!mounted || gen != _generation) return;
      setState(() {
        _items.addAll(page.items);
        _cursor = page.nextCursor;
        _done = page.nextCursor == null;
      });
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted && gen == _generation) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final cities = ref.watch(citiesProvider).value ?? const <String>[];
    return Scaffold(
      appBar: AppBar(title: const Text('Jelajahi komunitas')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: TextField(
              controller: _search,
              textInputAction: TextInputAction.search,
              decoration: const InputDecoration(
                prefixIcon: Icon(Icons.search),
                hintText: 'Cari nama komunitas atau kota',
                border: OutlineInputBorder(),
              ),
              onChanged: (_) {
                _debounce?.cancel();
                _debounce = Timer(const Duration(milliseconds: 400), _reload);
              },
            ),
          ),
          if (cities.isNotEmpty)
            SizedBox(
              height: 52,
              child: ListView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                children: [
                  for (final city in [null, ...cities])
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 4),
                      child: ChoiceChip(
                        label: Text(city ?? 'Semua kota'),
                        selected: _city == city,
                        onSelected: (_) {
                          _city = city;
                          _reload();
                        },
                      ),
                    ),
                ],
              ),
            ),
          Expanded(
            child: NotificationListener<ScrollNotification>(
              onNotification: (n) {
                if (n.metrics.pixels > n.metrics.maxScrollExtent - 200) _loadMore();
                return false;
              },
              child: RefreshIndicator(
                onRefresh: _reload,
                child: _items.isEmpty && !_loading
                    ? ListView(children: const [
                        SizedBox(height: 96),
                        Center(child: Text('Tidak ada komunitas yang cocok')),
                      ])
                    : ListView.builder(
                        itemCount: _items.length + (_loading ? 1 : 0),
                        itemBuilder: (context, i) {
                          if (i >= _items.length) {
                            return const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()));
                          }
                          final c = _items[i];
                          return CommunityTile(community: c, onTap: () => context.push('/communities/${c.id}'));
                        },
                      ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
