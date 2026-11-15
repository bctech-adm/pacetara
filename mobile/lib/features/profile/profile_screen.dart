import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/brand.dart';
import '../../core/widgets/common.dart';
import '../../core/widgets/motion.dart';
import '../auth/auth_controller.dart';
import '../auth/models.dart';
import '../runs/runs_repository.dart';
import '../subscriptions/upgrade.dart';
import '../update/update_service.dart';

class Avatar extends ConsumerWidget {
  const Avatar({super.key, required this.profile, this.radius = 28});
  final MyProfile profile;
  final double radius;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final url = profile.avatarUrl;
    final bytes = url == null ? null : ref.watch(avatarBytesProvider(url)).value;
    final initial = profile.displayName.isNotEmpty ? profile.displayName[0].toUpperCase() : '?';
    return CircleAvatar(
      radius: radius,
      backgroundImage: bytes == null ? null : MemoryImage(Uint8List.fromList(bytes)),
      child: bytes == null ? Text(initial, style: TextStyle(fontSize: radius * 0.8)) : null,
    );
  }
}

class ProfileScreen extends ConsumerStatefulWidget {
  const ProfileScreen({super.key, this.asTab = false});

  /// Ditampilkan sebagai tab di beranda (tanpa tombol kembali).
  final bool asTab;

  @override
  ConsumerState<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends ConsumerState<ProfileScreen> {
  final _form = GlobalKey<FormState>();
  late final TextEditingController _name;
  late final TextEditingController _city;
  late final TextEditingController _paceMin;
  late final TextEditingController _paceSec;

  @override
  void initState() {
    super.initState();
    final p = ref.read(authControllerProvider).value;
    _name = TextEditingController(text: p?.displayName ?? '');
    _city = TextEditingController(text: p?.city ?? '');
    final pace = p?.avgPaceSecPerKm;
    _paceMin = TextEditingController(text: pace == null ? '' : '${pace ~/ 60}');
    _paceSec = TextEditingController(text: pace == null ? '' : (pace % 60).toString().padLeft(2, '0'));
  }

  @override
  void dispose() {
    _name.dispose();
    _city.dispose();
    _paceMin.dispose();
    _paceSec.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    final pace = paceFromFields(_paceMin.text, _paceSec.text);
    await ref.read(authControllerProvider.notifier).updateProfile(
          displayName: _name.text.trim(),
          city: _city.text.trim(),
          avgPaceSecPerKm: pace,
          clearPace: pace == null,
        );
    if (mounted) showInfo(context, 'Profil disimpan');
  }

  Future<void> _pickAvatar() async {
    final file = await ImagePicker().pickImage(source: ImageSource.gallery, maxWidth: 1024, imageQuality: 90);
    if (file == null) return;
    try {
      await ref.read(authControllerProvider.notifier).uploadAvatar(file.path);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final profile = ref.watch(authControllerProvider).value;
    if (profile == null) return const Scaffold(body: Center(child: CircularProgressIndicator()));

    final theme = Theme.of(context);
    final top = MediaQuery.paddingOf(context).top;
    final sections = <Widget>[
      // Pintasan cepat bergradien.
      Padding(
        padding: const EdgeInsets.fromLTRB(12, 4, 12, 0),
        child: Row(children: [
          _QuickAction(icon: Icons.history_rounded, label: 'Riwayat', gradient: Brand.gradient, onTap: () => context.push('/runs')),
          _QuickAction(icon: Icons.military_tech_rounded, label: 'Paspor', gradient: Brand.gradientGold, onTap: () => context.push('/passport')),
          _QuickAction(icon: Icons.sync_alt_rounded, label: 'Impor', gradient: Brand.gradientTeal, onTap: () => context.push('/imports')),
          _QuickAction(
            icon: Icons.workspace_premium_rounded,
            label: profile.isPremium ? 'Premium' : 'Upgrade',
            gradient: Brand.gradientViolet,
            onTap: () => context.push('/subscription'),
          ),
        ]),
      ),
      const SectionHeader('Edit profil'),
      Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(children: [
                Form(
                  key: _form,
                  child: Column(
                    children: [
                      TextFormField(
                        controller: _name,
                        maxLength: 60,
                        validator: (v) => (v ?? '').trim().isEmpty ? 'Nama wajib diisi' : null,
                        decoration: const InputDecoration(labelText: 'Nama', border: OutlineInputBorder()),
                      ),
                      const SizedBox(height: 8),
                      TextFormField(
                        controller: _city,
                        maxLength: 60,
                        textCapitalization: TextCapitalization.words,
                        decoration: const InputDecoration(labelText: 'Kota (opsional)', border: OutlineInputBorder()),
                      ),
                      const SizedBox(height: 8),
                      // Dua kolom angka terpisah: keyboard angka di banyak HP tidak punya tanda ":".
                      Align(
                        alignment: Alignment.centerLeft,
                        child: Padding(
                          padding: const EdgeInsets.only(bottom: 8),
                          child: Text('Pace rata-rata per km (opsional)', style: Theme.of(context).textTheme.labelLarge),
                        ),
                      ),
                      Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Expanded(
                          child: TextFormField(
                            key: const Key('pace-min'),
                            controller: _paceMin,
                            keyboardType: TextInputType.number,
                            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(2)],
                            validator: (_) => paceFieldsError(_paceMin.text, _paceSec.text),
                            decoration: const InputDecoration(labelText: 'Menit', hintText: '6', border: OutlineInputBorder()),
                          ),
                        ),
                        const Padding(padding: EdgeInsets.fromLTRB(8, 14, 8, 0), child: Text(':', style: TextStyle(fontSize: 20))),
                        Expanded(
                          child: TextFormField(
                            key: const Key('pace-sec'),
                            controller: _paceSec,
                            keyboardType: TextInputType.number,
                            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(2)],
                            decoration: const InputDecoration(labelText: 'Detik', hintText: '30', border: OutlineInputBorder()),
                          ),
                        ),
                      ]),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: Text('Contoh: 6 menit 30 detik per km. Kosongkan jika belum tahu.', style: Theme.of(context).textTheme.bodySmall),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),
                AsyncButton(label: 'Simpan', onPressed: _save),
          ]),
        ),
      ),
      const SectionHeader('Akun dan verifikasi'),
      _Section(children: [
            ListTile(
              leading: const Icon(Icons.mail_outline),
              title: Text(profile.email ?? '-'),
              subtitle: Text(profile.emailVerified ? 'Email terverifikasi' : 'Email belum terverifikasi'),
            ),
            ListTile(
              leading: const Icon(Icons.phone_outlined),
              title: Text(profile.phone ?? '-'),
              subtitle: Text(profile.phoneVerified ? 'Nomor HP terverifikasi' : 'Nomor HP belum terverifikasi'),
            ),
            ListTile(
              key: const Key('kyc-tile'),
              leading: Icon(profile.verificationLevel >= 2 ? Icons.verified : Icons.badge_outlined),
              title: const Text('Verifikasi KTP (Level 2)'),
              subtitle: Text(profile.verificationLevel >= 2
                  ? 'Terverifikasi'
                  : 'Wajib untuk membuat komunitas, berjualan dengan pembayaran di aplikasi, dan sponsor'),
              onTap: () => context.push('/verification'),
            ),
            ListTile(
              leading: const Icon(Icons.storefront_outlined),
              title: const Text('Marketplace'),
              subtitle: const Text('Listing saya, pesanan, dan akun pembayaran'),
              onTap: () => context.push('/market/mine'),
            ),
      ]),
      const SectionHeader('Aktivitas'),
      _Section(children: [
            ListTile(
              key: const Key('subscription-tile'),
              leading: const Icon(Icons.workspace_premium_outlined),
              title: const Text('Langganan'),
              subtitle: Text(profile.isPremium ? 'Premium aktif' : 'Gratis · lihat Premium dan Komunitas Pro'),
              onTap: () => context.push('/subscription'),
            ),
            ListTile(
              leading: const Icon(Icons.history),
              title: const Text('Riwayat lari'),
              onTap: () => context.push('/runs'),
            ),
            ListTile(
              leading: const Icon(Icons.military_tech_outlined),
              title: const Text('Paspor lari'),
              subtitle: const Text('Lencana, rak medali, dan hasil resmi event'),
              onTap: () => context.push('/passport'),
            ),
            ListTile(
              leading: const Icon(Icons.sync_alt),
              title: const Text('Impor data lari'),
              subtitle: const Text('Health Connect, Garmin, Strava'),
              onTap: () => context.push('/imports'),
            ),
            ListTile(
              leading: const Icon(Icons.dynamic_feed_outlined),
              title: const Text('Profil feed saya'),
              subtitle: const Text('Postingan, pengikut, dan blokir'),
              onTap: () => context.push('/feed/users/${profile.id}'),
            ),
      ]),
      const SectionHeader('Privasi dan keamanan'),
      _Section(children: [
            _PrivacyZoneTile(profile: profile),
            ListTile(
              leading: const Icon(Icons.notifications_outlined),
              title: const Text('Notifikasi'),
              subtitle: const Text('Pilih notifikasi push yang kamu terima'),
              onTap: () => context.push('/settings/notifications'),
            ),
            ListTile(
              leading: const Icon(Icons.sos_outlined),
              title: const Text('Kontak darurat'),
              subtitle: const Text('Penerima lokasimu saat menekan SOS ketika lari'),
              onTap: () => context.push('/settings/emergency-contacts'),
            ),
            ListTile(
              leading: const Icon(Icons.gavel_outlined),
              title: const Text('Konten yang diturunkan'),
              subtitle: const Text('Keputusan moderasi dan banding'),
              onTap: () => context.push('/moderation/removals'),
            ),
      ]),
      const SectionHeader('Lainnya'),
      _Section(children: [
            const _VersionTile(),
            ListTile(
              leading: const Icon(Icons.logout),
              title: const Text('Keluar'),
              onTap: () => ref.read(authControllerProvider.notifier).logout(),
            ),
            ListTile(
              leading: Icon(Icons.delete_forever_outlined, color: Theme.of(context).colorScheme.error),
              title: Text('Hapus akun', style: TextStyle(color: Theme.of(context).colorScheme.error)),
              subtitle: const Text('Menghapus akun dan data pribadi secara permanen'),
              onTap: () => showDialog<void>(context: context, builder: (_) => DeleteAccountDialog(profile: profile)),
            ),
      ]),
      const SizedBox(height: 32),
    ];

    return Scaffold(
      body: ListView(
        padding: EdgeInsets.zero,
        children: [
          // Header bergradien: foto, nama, kota, status verifikasi.
          SizedBox(
            height: 262 + top,
            child: BrandBackdrop(
              borderRadius: const BorderRadius.vertical(bottom: Radius.circular(36)),
              child: Padding(
                padding: EdgeInsets.fromLTRB(20, top + 4, 20, 24),
                child: Column(children: [
                  SizedBox(
                    height: 48,
                    child: Row(children: [
                      if (!widget.asTab)
                        IconButton(
                          tooltip: 'Kembali',
                          color: Colors.white,
                          icon: const Icon(Icons.arrow_back_rounded),
                          onPressed: () => Navigator.maybePop(context),
                        ),
                      const Spacer(),
                    ]),
                  ),
                  FadeSlideIn(
                    child: Stack(clipBehavior: Clip.none, children: [
                      Container(
                        padding: const EdgeInsets.all(4),
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: Colors.white,
                          boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.18), blurRadius: 20, offset: const Offset(0, 8))],
                        ),
                        child: Avatar(profile: profile, radius: 46),
                      ),
                      if (profile.isPremium) const Positioned(left: -4, bottom: 0, child: PremiumBadge()),
                      Positioned(
                        right: -6,
                        bottom: -2,
                        child: Pressable(
                          child: Material(
                            color: Colors.white,
                            shape: const CircleBorder(),
                            elevation: 3,
                            child: IconButton(
                              tooltip: 'Ganti foto',
                              color: Brand.orange,
                              icon: const Icon(Icons.photo_camera_rounded, size: 20),
                              onPressed: _pickAvatar,
                            ),
                          ),
                        ),
                      ),
                    ]),
                  ),
                  const SizedBox(height: 12),
                  FadeSlideIn(
                    index: 1,
                    child: Text(
                      profile.displayName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.headlineSmall?.copyWith(color: Colors.white, fontWeight: FontWeight.w800),
                    ),
                  ),
                  const SizedBox(height: 6),
                  FadeSlideIn(
                    index: 2,
                    child: Wrap(alignment: WrapAlignment.center, spacing: 6, runSpacing: 6, children: [
                      if ((profile.city ?? '').isNotEmpty) _HeaderChip(icon: Icons.place_rounded, label: profile.city!),
                      if (profile.verificationLevel >= 2) const _HeaderChip(icon: Icons.verified_rounded, label: 'KTP terverifikasi'),
                      if (profile.avgPaceSecPerKm != null)
                        _HeaderChip(
                          icon: Icons.speed_rounded,
                          label: "${profile.avgPaceSecPerKm! ~/ 60}:${(profile.avgPaceSecPerKm! % 60).toString().padLeft(2, '0')} /km",
                        ),
                    ]),
                  ),
                ]),
              ),
            ),
          ),
          const SizedBox(height: 12),
          for (var i = 0; i < sections.length; i++) FadeSlideIn(index: i, child: sections[i]),
        ],
      ),
    );
  }
}

/// Kartu berisi daftar ListTile (satu bagian menu).
class _Section extends StatelessWidget {
  const _Section({required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Card(
      clipBehavior: Clip.antiAlias,
      child: ListTileTheme.merge(
        iconColor: Theme.of(context).colorScheme.primary,
        shape: const RoundedRectangleBorder(),
        child: Column(children: children),
      ),
    );
  }
}

class _QuickAction extends StatelessWidget {
  const _QuickAction({required this.icon, required this.label, required this.gradient, required this.onTap});
  final IconData icon;
  final String label;
  final Gradient gradient;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Pressable(
        scale: 0.92,
        child: InkWell(
          borderRadius: BorderRadius.circular(18),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 10),
            child: Column(children: [
              GradientIcon(icon: icon, gradient: gradient, size: 52),
              const SizedBox(height: 8),
              Text(label, style: Theme.of(context).textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w700)),
            ]),
          ),
        ),
      ),
    );
  }
}

class _HeaderChip extends StatelessWidget {
  const _HeaderChip({required this.icon, required this.label});
  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.2), borderRadius: BorderRadius.circular(999)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 14, color: Colors.white),
        const SizedBox(width: 4),
        Text(label, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 12)),
      ]),
    );
  }
}

class DeleteAccountDialog extends ConsumerStatefulWidget {
  const DeleteAccountDialog({super.key, required this.profile});
  final MyProfile profile;

  @override
  ConsumerState<DeleteAccountDialog> createState() => _DeleteAccountDialogState();
}

class _DeleteAccountDialogState extends ConsumerState<DeleteAccountDialog> {
  final _confirm = TextEditingController();
  final _password = TextEditingController();

  @override
  void dispose() {
    _confirm.dispose();
    _password.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: Listenable.merge([_confirm, _password]),
      builder: (context, _) => _buildDialog(context),
    );
  }

  Widget _buildDialog(BuildContext context) {
    final ready = _confirm.text == 'HAPUS' && (!widget.profile.hasPassword || _password.text.isNotEmpty);
    return AlertDialog(
      title: const Text('Hapus akun?'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Email, nomor HP, foto, dan profil kamu akan dihapus permanen dan tidak bisa dikembalikan. '
              'Di chat komunitas, nama kamu akan tampil sebagai "Pengguna dihapus". '
              'Langganan Google Play yang masih berjalan dihentikan perpanjangannya (tanpa refund otomatis); '
              'periksa juga di Google Play → Pembayaran & langganan.',
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _confirm,
              decoration: const InputDecoration(labelText: 'Ketik HAPUS untuk konfirmasi', border: OutlineInputBorder()),
            ),
            if (widget.profile.hasPassword) ...[
              const SizedBox(height: 12),
              PasswordField(controller: _password),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Batal')),
        FilledButton(
          style: FilledButton.styleFrom(backgroundColor: Theme.of(context).colorScheme.error),
          onPressed: !ready
              ? null
              : () async {
                  final nav = Navigator.of(context);
                  try {
                    await ref
                        .read(authControllerProvider.notifier)
                        .deleteAccount(password: widget.profile.hasPassword ? _password.text : null);
                    nav.pop();
                  } catch (e) {
                    if (context.mounted) showError(context, e);
                  }
                },
          child: const Text('Hapus permanen'),
        ),
      ],
    );
  }
}

class _VersionTile extends ConsumerWidget {
  const _VersionTile();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final info = ref.watch(packageInfoProvider).value;
    return ListTile(
      leading: const Icon(Icons.system_update_outlined),
      title: const Text('Periksa pembaruan'),
      subtitle: Text(info == null ? 'Versi ...' : 'Versi ${info.version} (build ${info.buildNumber})'),
      onTap: () async {
        final release = await checkForUpdate(ref);
        if (!context.mounted) return;
        if (release == null) {
          showInfo(context, 'Aplikasi sudah versi terbaru');
        } else {
          await showUpdateDialog(context, release);
        }
      },
    );
  }
}

class _PrivacyZoneTile extends ConsumerWidget {
  const _PrivacyZoneTile({required this.profile});
  final MyProfile profile;

  static const _options = [100, 250, 500, 1000];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ListTile(
      leading: const Icon(Icons.shield_moon_outlined),
      title: const Text('Zona privasi lari'),
      subtitle: Text('Area ${profile.privacyRadiusM} m dari titik awal dan akhir disembunyikan dari orang lain'),
      onTap: () async {
        final chosen = await showDialog<int>(
          context: context,
          builder: (context) => SimpleDialog(
            title: const Text('Radius zona privasi'),
            children: [
              for (final m in _options)
                RadioGroup<int>(
                  groupValue: profile.privacyRadiusM,
                  onChanged: (v) => Navigator.pop(context, v),
                  child: RadioListTile<int>(value: m, title: Text(m >= 1000 ? '${m ~/ 1000} km' : '$m m')),
                ),
              const Padding(
                padding: EdgeInsets.fromLTRB(24, 8, 24, 0),
                child: Text('Berlaku untuk lari yang disimpan setelah ini.'),
              ),
            ],
          ),
        );
        if (chosen == null || chosen == profile.privacyRadiusM) return;
        try {
          await ref.read(runsRepositoryProvider).setPrivacyRadius(chosen);
          await ref.read(authControllerProvider.notifier).reload();
        } catch (e) {
          if (context.mounted) showError(context, e);
        }
      },
    );
  }
}
