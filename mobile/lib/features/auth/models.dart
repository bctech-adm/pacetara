/// Profil milik sendiri dari `GET /v1/me`.
class MyProfile {
  const MyProfile({
    required this.id,
    required this.displayName,
    required this.email,
    required this.emailVerified,
    required this.phone,
    required this.phoneVerified,
    required this.hasPassword,
    required this.googleLinked,
    required this.avatarUrl,
    required this.city,
    required this.avgPaceSecPerKm,
    required this.verificationLevel,
    required this.badges,
    this.privacyRadiusM = 250,
  });

  final String id;
  final String displayName;
  final String? email;
  final bool emailVerified;
  final String? phone;
  final bool phoneVerified;
  final bool hasPassword;
  final bool googleLinked;
  final String? avatarUrl;
  final String? city;
  final int? avgPaceSecPerKm;
  final int verificationLevel;
  final List<String> badges;

  /// Radius zona privasi rute lari (meter).
  final int privacyRadiusM;

  bool get isLevel1 => verificationLevel >= 1;

  factory MyProfile.fromJson(Map<String, dynamic> j) => MyProfile(
        id: j['id'] as String,
        displayName: j['displayName'] as String,
        email: j['email'] as String?,
        emailVerified: j['emailVerified'] as bool? ?? false,
        phone: j['phone'] as String?,
        phoneVerified: j['phoneVerified'] as bool? ?? false,
        hasPassword: j['hasPassword'] as bool? ?? false,
        googleLinked: j['googleLinked'] as bool? ?? false,
        avatarUrl: j['avatarUrl'] as String?,
        city: j['city'] as String?,
        avgPaceSecPerKm: (j['avgPaceSecPerKm'] as num?)?.toInt(),
        verificationLevel: (j['verificationLevel'] as num?)?.toInt() ?? 0,
        badges: (j['badges'] as List<dynamic>? ?? const []).whereType<String>().toList(),
        privacyRadiusM: (j['privacyRadiusM'] as num?)?.toInt() ?? 250,
      );
}

/// Konfigurasi layar daftar dari `GET /v1/auth/config`.
class AuthConfig {
  const AuthConfig({required this.privacyVersion, required this.privacyUrl, required this.googleEnabled});
  final String privacyVersion;
  final String privacyUrl;
  final bool googleEnabled;

  factory AuthConfig.fromJson(Map<String, dynamic> j) => AuthConfig(
        privacyVersion: j['privacyVersion'] as String,
        privacyUrl: j['privacyUrl'] as String,
        googleEnabled: j['googleEnabled'] as bool? ?? false,
      );
}

/// Kanal pengiriman kode OTP nomor HP.
enum OtpChannel { whatsapp, email }

/// Format pace detik/km menjadi "m:ss".
String formatPace(int secPerKm) {
  final m = secPerKm ~/ 60;
  final s = (secPerKm % 60).toString().padLeft(2, '0');
  return '$m:$s';
}

/// Mengurai pace menjadi detik/km. Null jika format tidak valid atau di luar 2:00–30:00.
/// Menerima "6:30", "6.30", "6,30" (keyboard angka di banyak HP tidak punya ":"), dan "630".
int? parsePace(String input) {
  final t = input.trim();
  final match = RegExp(r'^(\d{1,2})[:.,]([0-5]\d)$').firstMatch(t) ?? RegExp(r'^(\d{1,2})([0-5]\d)$').firstMatch(t);
  if (match == null) return null;
  final total = int.parse(match.group(1)!) * 60 + int.parse(match.group(2)!);
  return total >= 120 && total <= 1800 ? total : null;
}

/// Pace dari dua kolom terpisah (menit dan detik, angka saja). Keduanya kosong = tanpa pace.
/// Detik kosong dianggap 0. Mengembalikan pesan galat, atau null jika valid.
String? paceFieldsError(String minutes, String seconds) {
  final m = minutes.trim();
  final s = seconds.trim();
  if (m.isEmpty && s.isEmpty) return null;
  if (m.isEmpty) return 'Isi menit';
  final mm = int.tryParse(m);
  final ss = s.isEmpty ? 0 : int.tryParse(s);
  if (mm == null || ss == null) return 'Hanya angka';
  if (ss > 59) return 'Detik 0–59';
  final total = mm * 60 + ss;
  if (total < 120 || total > 1800) return 'Pace antara 2:00 dan 30:00';
  return null;
}

/// Detik per km dari dua kolom; null jika kosong atau tidak valid.
int? paceFromFields(String minutes, String seconds) {
  if (paceFieldsError(minutes, seconds) != null || minutes.trim().isEmpty) return null;
  final s = seconds.trim();
  return int.parse(minutes.trim()) * 60 + (s.isEmpty ? 0 : int.parse(s));
}
