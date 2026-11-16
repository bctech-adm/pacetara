import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app.dart';
import 'core/config.dart';
import 'core/http/pinned_security_context.dart';
import 'core/system_ui.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  AppConfig.validate();
  await SystemUi.instance.init();
  final securityContext = await loadPinnedSecurityContext();
  runApp(
    ProviderScope(
      overrides: [securityContextProvider.overrideWithValue(securityContext)],
      child: const PaceTaraApp(),
    ),
  );
}
