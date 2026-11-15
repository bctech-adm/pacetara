import 'package:flutter/material.dart';

/// Sistem desain PaceTara: oranye "sunset" sebagai warna utama, permukaan bersih, sudut membulat,
/// tipografi Plus Jakarta Sans yang tebal untuk angka lari. Semua layar mengambil warna dari sini,
/// jangan menulis warna mentah di layar kecuali untuk status (berhasil/peringatan).
abstract final class Brand {
  static const orange = Color(0xFFFF5B14);
  static const orangeDeep = Color(0xFFE8430A);
  static const coral = Color(0xFFFF3D6E);
  static const amber = Color(0xFFFFA025);
  static const violet = Color(0xFF7B61FF);
  static const success = Color(0xFF1DB954);
  static const warning = Color(0xFFFFB020);

  /// Gradien utama (tombol mulai, header, kartu hasil lari).
  static const gradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [amber, orange, coral],
    stops: [0, 0.5, 1],
  );

  /// Gradien sekunder untuk aksen (fitur komunitas, premium).
  static const gradientViolet = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFF9D7BFF), violet, Color(0xFF4F7BFF)],
  );

  static const gradientTeal = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFF2BD9A8), Color(0xFF15A3C9)],
  );

  static const gradientRose = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFFFF7EB3), Color(0xFFFF4D6D)],
  );

  static const gradientGold = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFFFFD25E), Color(0xFFFF9A1F)],
  );
}

/// Angka statistik lari: rata tabel agar tidak "melompat" saat berubah tiap detik.
const tabularFigures = [FontFeature.tabularFigures()];

abstract final class AppTheme {
  static const fontFamily = 'PlusJakartaSans';
  static const radius = 20.0;
  static const radiusSmall = 14.0;

  static ThemeData light() => _build(Brightness.light);
  static ThemeData dark() => _build(Brightness.dark);

  static ThemeData _build(Brightness brightness) {
    final dark = brightness == Brightness.dark;
    final base = ColorScheme.fromSeed(seedColor: Brand.orange, brightness: brightness, dynamicSchemeVariant: DynamicSchemeVariant.vibrant);
    final scheme = base.copyWith(
      primary: Brand.orange,
      onPrimary: Colors.white,
      primaryContainer: dark ? const Color(0xFF3A1A0B) : const Color(0xFFFFE7DB),
      onPrimaryContainer: dark ? const Color(0xFFFFC2A6) : const Color(0xFF5C1D00),
      secondary: Brand.violet,
      onSecondary: Colors.white,
      secondaryContainer: dark ? const Color(0xFF26214A) : const Color(0xFFEDE9FF),
      onSecondaryContainer: dark ? const Color(0xFFD5CCFF) : const Color(0xFF271A6B),
      tertiary: Brand.coral,
      onTertiary: Colors.white,
      surface: dark ? const Color(0xFF15161B) : Colors.white,
      onSurface: dark ? const Color(0xFFF3F3F6) : const Color(0xFF14151A),
      onSurfaceVariant: dark ? const Color(0xFFA2A4AE) : const Color(0xFF6B6E78),
      surfaceContainerLowest: dark ? const Color(0xFF0B0C10) : Colors.white,
      surfaceContainerLow: dark ? const Color(0xFF18191F) : const Color(0xFFF8F8FA),
      surfaceContainer: dark ? const Color(0xFF1D1E25) : const Color(0xFFF3F3F6),
      surfaceContainerHigh: dark ? const Color(0xFF23242C) : const Color(0xFFEDEDF1),
      surfaceContainerHighest: dark ? const Color(0xFF2A2B34) : const Color(0xFFE7E7EC),
      outline: dark ? const Color(0xFF4A4C57) : const Color(0xFFCDCED6),
      outlineVariant: dark ? const Color(0xFF2E3039) : const Color(0xFFE6E7EC),
      surfaceTint: Colors.transparent,
    );
    final background = dark ? const Color(0xFF0E0F13) : const Color(0xFFF5F5F8);

    final typography = Typography.material2021(platform: TargetPlatform.android);
    final baseText = (dark ? typography.white : typography.black).apply(
      fontFamily: fontFamily,
      bodyColor: scheme.onSurface,
      displayColor: scheme.onSurface,
    );
    final text = baseText.copyWith(
      displayLarge: baseText.displayLarge?.copyWith(fontWeight: FontWeight.w800, letterSpacing: -2),
      displayMedium: baseText.displayMedium?.copyWith(fontWeight: FontWeight.w800, letterSpacing: -1.5),
      displaySmall: baseText.displaySmall?.copyWith(fontWeight: FontWeight.w800, letterSpacing: -1),
      headlineLarge: baseText.headlineLarge?.copyWith(fontWeight: FontWeight.w800, letterSpacing: -0.8),
      headlineMedium: baseText.headlineMedium?.copyWith(fontWeight: FontWeight.w800, letterSpacing: -0.6),
      headlineSmall: baseText.headlineSmall?.copyWith(fontWeight: FontWeight.w700, letterSpacing: -0.4),
      titleLarge: baseText.titleLarge?.copyWith(fontWeight: FontWeight.w700, letterSpacing: -0.3),
      titleMedium: baseText.titleMedium?.copyWith(fontWeight: FontWeight.w700),
      titleSmall: baseText.titleSmall?.copyWith(fontWeight: FontWeight.w700),
      labelLarge: baseText.labelLarge?.copyWith(fontWeight: FontWeight.w700),
      labelMedium: baseText.labelMedium?.copyWith(fontWeight: FontWeight.w600, color: scheme.onSurfaceVariant),
      labelSmall: baseText.labelSmall?.copyWith(fontWeight: FontWeight.w600, color: scheme.onSurfaceVariant),
      bodySmall: baseText.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
    );

    final rounded = RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusSmall + 2));
    OutlineInputBorder inputBorder(Color color, [double width = 1.4]) => OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusSmall + 2),
          borderSide: BorderSide(color: color, width: width),
        );
    const buttonText = TextStyle(fontFamily: fontFamily, fontWeight: FontWeight.w700, fontSize: 15, letterSpacing: 0.1);

    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      fontFamily: fontFamily,
      textTheme: text,
      scaffoldBackgroundColor: background,
      canvasColor: background,
      visualDensity: VisualDensity.standard,
      pageTransitionsTheme: const PageTransitionsTheme(builders: {
        TargetPlatform.android: FadeForwardsPageTransitionsBuilder(),
      }),
      appBarTheme: AppBarThemeData(
        backgroundColor: background,
        foregroundColor: scheme.onSurface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleSpacing: 20,
        titleTextStyle: text.titleLarge?.copyWith(fontSize: 22, fontWeight: FontWeight.w800, letterSpacing: -0.5),
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        color: scheme.surface,
        surfaceTintColor: Colors.transparent,
        margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radius),
          side: BorderSide(color: scheme.outlineVariant.withValues(alpha: dark ? 0.9 : 0.7)),
        ),
      ),
      inputDecorationTheme: InputDecorationThemeData(
        filled: true,
        fillColor: scheme.surfaceContainer,
        contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
        // Batas tiap keadaan diisi di sini, jadi `border: OutlineInputBorder()` di layar tidak menimpanya.
        border: inputBorder(Colors.transparent),
        enabledBorder: inputBorder(Colors.transparent),
        disabledBorder: inputBorder(Colors.transparent),
        focusedBorder: inputBorder(scheme.primary, 1.8),
        errorBorder: inputBorder(scheme.error),
        focusedErrorBorder: inputBorder(scheme.error, 1.8),
        labelStyle: TextStyle(color: scheme.onSurfaceVariant, fontWeight: FontWeight.w500),
        floatingLabelStyle: WidgetStateTextStyle.resolveWith(
          (states) => TextStyle(
            fontWeight: FontWeight.w700,
            color: states.contains(WidgetState.error)
                ? scheme.error
                : states.contains(WidgetState.focused)
                    ? scheme.primary
                    : scheme.onSurfaceVariant,
          ),
        ),
        hintStyle: TextStyle(color: scheme.onSurfaceVariant.withValues(alpha: 0.7)),
        prefixIconColor: scheme.onSurfaceVariant,
        suffixIconColor: scheme.onSurfaceVariant,
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size(64, 52),
          padding: const EdgeInsets.symmetric(horizontal: 22),
          shape: rounded,
          textStyle: buttonText,
          elevation: 0,
        ),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(minimumSize: const Size(64, 52), shape: rounded, textStyle: buttonText, elevation: 0),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(64, 52),
          padding: const EdgeInsets.symmetric(horizontal: 22),
          shape: rounded,
          textStyle: buttonText,
          side: BorderSide(color: scheme.outline, width: 1.2),
          foregroundColor: scheme.onSurface,
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(textStyle: buttonText.copyWith(fontSize: 14), shape: rounded),
      ),
      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(foregroundColor: scheme.onSurface),
      ),
      floatingActionButtonTheme: FloatingActionButtonThemeData(
        backgroundColor: scheme.primary,
        foregroundColor: Colors.white,
        elevation: 4,
        focusElevation: 4,
        hoverElevation: 6,
        highlightElevation: 2,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radius)),
        extendedTextStyle: buttonText,
      ),
      tabBarTheme: TabBarThemeData(
        indicator: PillTabIndicator(color: scheme.primary),
        indicatorSize: TabBarIndicatorSize.tab,
        dividerColor: Colors.transparent,
        labelColor: Colors.white,
        unselectedLabelColor: scheme.onSurfaceVariant,
        labelStyle: buttonText.copyWith(fontSize: 14),
        unselectedLabelStyle: buttonText.copyWith(fontSize: 14, fontWeight: FontWeight.w600),
        splashBorderRadius: BorderRadius.circular(999),
        overlayColor: WidgetStatePropertyAll(scheme.primary.withValues(alpha: 0.06)),
      ),
      chipTheme: ChipThemeData(
        shape: const StadiumBorder(),
        side: BorderSide(color: scheme.outlineVariant),
        backgroundColor: scheme.surface,
        selectedColor: scheme.primaryContainer,
        labelStyle: TextStyle(fontFamily: fontFamily, fontWeight: FontWeight.w600, color: scheme.onSurface),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: scheme.surface,
        surfaceTintColor: Colors.transparent,
        showDragHandle: true,
        dragHandleColor: scheme.outline,
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(28))),
        clipBehavior: Clip.antiAlias,
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: scheme.surface,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(28)),
        titleTextStyle: text.titleLarge?.copyWith(fontWeight: FontWeight.w800),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: dark ? const Color(0xFF2A2B34) : const Color(0xFF1B1C22),
        contentTextStyle: const TextStyle(fontFamily: fontFamily, color: Colors.white, fontWeight: FontWeight.w600),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusSmall)),
        insetPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      ),
      listTileTheme: ListTileThemeData(
        iconColor: scheme.onSurfaceVariant,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusSmall)),
        titleTextStyle: text.bodyLarge?.copyWith(fontWeight: FontWeight.w600),
        subtitleTextStyle: text.bodyMedium?.copyWith(color: scheme.onSurfaceVariant),
      ),
      dividerTheme: DividerThemeData(color: scheme.outlineVariant, thickness: 1, space: 24),
      popupMenuTheme: PopupMenuThemeData(
        color: scheme.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 8,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusSmall)),
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: scheme.surface,
        surfaceTintColor: Colors.transparent,
        indicatorColor: scheme.primaryContainer,
        labelTextStyle: WidgetStatePropertyAll(text.labelSmall?.copyWith(fontWeight: FontWeight.w700)),
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(color: scheme.primary, linearTrackColor: scheme.surfaceContainerHigh),
      badgeTheme: const BadgeThemeData(backgroundColor: Brand.coral, textColor: Colors.white),
      segmentedButtonTheme: SegmentedButtonThemeData(
        style: SegmentedButton.styleFrom(
          selectedBackgroundColor: scheme.primary,
          selectedForegroundColor: Colors.white,
          textStyle: buttonText.copyWith(fontSize: 13),
        ),
      ),
    );
  }
}

/// Indikator tab berbentuk pil, sedikit lebih pendek dari tinggi tab.
class PillTabIndicator extends Decoration {
  const PillTabIndicator({required this.color, this.insets = const EdgeInsets.symmetric(horizontal: 4, vertical: 7)});
  final Color color;
  final EdgeInsets insets;

  @override
  BoxPainter createBoxPainter([VoidCallback? onChanged]) => _PillPainter(this);
}

class _PillPainter extends BoxPainter {
  _PillPainter(this.decoration);
  final PillTabIndicator decoration;

  @override
  void paint(Canvas canvas, Offset offset, ImageConfiguration configuration) {
    final size = configuration.size;
    if (size == null) return;
    final rect = decoration.insets.deflateRect(offset & size);
    canvas.drawRRect(
      RRect.fromRectAndRadius(rect, Radius.circular(rect.height / 2)),
      Paint()..color = decoration.color,
    );
  }
}
