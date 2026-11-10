import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'features/home/home_screen.dart';

final _router = GoRouter(
  routes: [
    GoRoute(path: '/', builder: (context, state) => const HomeScreen()),
  ],
);

const _brand = Color(0xFFF0590E);

class PaceTaraApp extends StatelessWidget {
  const PaceTaraApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: 'PaceTara',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorSchemeSeed: _brand, useMaterial3: true),
      darkTheme: ThemeData(colorSchemeSeed: _brand, brightness: Brightness.dark, useMaterial3: true),
      routerConfig: _router,
    );
  }
}
