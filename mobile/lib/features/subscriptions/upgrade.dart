import 'package:flutter/material.dart';

/// Batas paket yang diangkat Premium (per pengguna).
const premiumLimitKinds = {'user_join', 'run_history', 'medals', 'full_stats'};

/// Batas yang diangkat Komunitas Pro (per komunitas).
const communityLimitKinds = {'community_members', 'multi_admin'};

/// Rute layar langganan untuk ajakan upgrade (iklan internal PRD 2.5) dari `limit.kind` server.
/// Batas komunitas hanya mengarah ke Komunitas Pro jika pengguna adalah pemilik komunitas itu ([ownedCommunityId]);
/// selain itu tidak ada tombol upgrade (tidak menawarkan membayar komunitas orang lain). null = tanpa tombol.
String? upgradeRoute(String? kind, {String? ownedCommunityId}) {
  if (kind != null && premiumLimitKinds.contains(kind)) return '/subscription';
  if (kind != null && communityLimitKinds.contains(kind)) {
    return ownedCommunityId == null ? null : '/subscription/community/$ownedCommunityId';
  }
  // owned_communities (upgrade komunitas yang ada ke Pro) dan jenis lain: ringkasan langganan.
  return '/subscription';
}

/// Label tombol dialog batas.
String upgradeLabel(String? kind) => kind != null && communityLimitKinds.contains(kind)
    ? 'Lihat Komunitas Pro'
    : kind == 'owned_communities'
        ? 'Lihat Komunitas Pro'
        : 'Lihat Premium';

/// Baris perbandingan fitur (PRD "Gratis vs berbayar"). Harga TIDAK di sini: selalu dari Google Play.
const premiumFeatures = <(String, String, String)>[
  ('Bergabung ke komunitas', 'Maksimal 3', 'Tak terbatas'),
  ('Tracking, status lari, chat, feed', 'Ya', 'Ya'),
  ('Mode aman / SOS', 'Ya', 'Ya'),
  ('Riwayat lari', '3 bulan terakhir', 'Penuh + statistik lengkap'),
  ('Rak medali', '5 medali', 'Tak terbatas'),
  ('Lencana', '-', 'Premium di avatar dan profil'),
];

const communityFeatures = <(String, String, String, String)>[
  ('Anggota', 'Maksimal 3', 'Maksimal 30', 'Tanpa batas'),
  ('Multi-admin', '-', 'Ya', 'Ya'),
  ('Komunitas yang dibuat', '1 gratis', 'Tidak dihitung', 'Tidak dihitung'),
  ('Lencana', '-', 'Pro', 'Pro'),
];

String planLabel(String plan) => switch (plan) {
      'premium' => 'Premium',
      'pro' => 'Komunitas Pro',
      'pro_unlimited' => 'Komunitas Pro Unlimited',
      _ => 'Gratis',
    };

/// Lencana Premium kecil (PRD Lencana: avatar dan profil pelari).
class PremiumBadge extends StatelessWidget {
  const PremiumBadge({super.key});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Tooltip(
      message: 'Premium',
      child: Container(
        key: const Key('premium-badge'),
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
        decoration: BoxDecoration(color: scheme.primary, borderRadius: BorderRadius.circular(6)),
        child: Text('PREMIUM', style: TextStyle(color: scheme.onPrimary, fontSize: 10, fontWeight: FontWeight.w700)),
      ),
    );
  }
}

/// Nama + lencana (Premium/Pro) dalam satu baris.
class NameWithBadges extends StatelessWidget {
  const NameWithBadges({super.key, required this.name, required this.badges, this.style, this.proBadge});
  final String name;
  final List<String> badges;
  final TextStyle? style;

  /// Widget lencana Pro (dari modul komunitas) agar tidak ada impor melingkar.
  final Widget? proBadge;

  @override
  Widget build(BuildContext context) {
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Flexible(child: Text(name, style: style, overflow: TextOverflow.ellipsis)),
      if (badges.contains('premium')) ...[const SizedBox(width: 6), const PremiumBadge()],
      if (badges.contains('pro') && proBadge != null) ...[const SizedBox(width: 6), proBadge!],
    ]);
  }
}
