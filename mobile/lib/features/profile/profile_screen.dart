import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/widgets/common.dart';
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

    return FormPage(
      title: 'Profil',
      showBack: !widget.asTab,
      children: [
        Center(
          child: Stack(
            children: [
              Avatar(profile: profile, radius: 48),
              if (profile.isPremium) const Positioned(left: 0, bottom: 4, child: PremiumBadge()),
              Positioned(
                right: 0,
                bottom: 0,
                child: IconButton.filledTonal(
                  tooltip: 'Ganti foto',
                  icon: const Icon(Icons.photo_camera_outlined),
                  onPressed: _pickAvatar,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 24),
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
        const SizedBox(height: 32),
        const Divider(),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.mail_outline),
          title: Text(profile.email ?? '-'),
          subtitle: Text(profile.emailVerified ? 'Email terverifikasi' : 'Email belum terverifikasi'),
        ),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.phone_outlined),
          title: Text(profile.phone ?? '-'),
          subtitle: Text(profile.phoneVerified ? 'Nomor HP terverifikasi' : 'Nomor HP belum terverifikasi'),
        ),
        ListTile(
          key: const Key('kyc-tile'),
          contentPadding: EdgeInsets.zero,
          leading: Icon(profile.verificationLevel >= 2 ? Icons.verified : Icons.badge_outlined),
          title: const Text('Verifikasi KTP (Level 2)'),
          subtitle: Text(profile.verificationLevel >= 2
              ? 'Terverifikasi'
              : 'Wajib untuk membuat komunitas, berjualan dengan pembayaran di aplikasi, dan sponsor'),
          onTap: () => context.push('/verification'),
        ),
        const Divider(),
        ListTile(
          key: const Key('subscription-tile'),
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.workspace_premium_outlined),
          title: const Text('Langganan'),
          subtitle: Text(profile.isPremium ? 'Premium aktif' : 'Gratis · lihat Premium dan Komunitas Pro'),
          onTap: () => context.push('/subscription'),
        ),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.history),
          title: const Text('Riwayat lari'),
          onTap: () => context.push('/runs'),
        ),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.military_tech_outlined),
          title: const Text('Paspor lari'),
          subtitle: const Text('Lencana, rak medali, dan hasil resmi event'),
          onTap: () => context.push('/passport'),
        ),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.sync_alt),
          title: const Text('Impor data lari'),
          subtitle: const Text('Health Connect, Garmin, Strava'),
          onTap: () => context.push('/imports'),
        ),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.dynamic_feed_outlined),
          title: const Text('Profil feed saya'),
          subtitle: const Text('Postingan, pengikut, dan blokir'),
          onTap: () => context.push('/feed/users/${profile.id}'),
        ),
        _PrivacyZoneTile(profile: profile),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.notifications_outlined),
          title: const Text('Notifikasi'),
          subtitle: const Text('Pilih notifikasi push yang kamu terima'),
          onTap: () => context.push('/settings/notifications'),
        ),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.sos_outlined),
          title: const Text('Kontak darurat'),
          subtitle: const Text('Penerima lokasimu saat menekan SOS ketika lari'),
          onTap: () => context.push('/settings/emergency-contacts'),
        ),
        const _VersionTile(),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.logout),
          title: const Text('Keluar'),
          onTap: () => ref.read(authControllerProvider.notifier).logout(),
        ),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Icon(Icons.delete_forever_outlined, color: Theme.of(context).colorScheme.error),
          title: Text('Hapus akun', style: TextStyle(color: Theme.of(context).colorScheme.error)),
          subtitle: const Text('Menghapus akun dan data pribadi secara permanen'),
          onTap: () => showDialog<void>(context: context, builder: (_) => DeleteAccountDialog(profile: profile)),
        ),
      ],
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
      contentPadding: EdgeInsets.zero,
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
      contentPadding: EdgeInsets.zero,
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
