import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/widgets/common.dart';
import '../auth/auth_controller.dart';
import '../auth/models.dart';
import '../runs/runs_repository.dart';
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
  const ProfileScreen({super.key});

  @override
  ConsumerState<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends ConsumerState<ProfileScreen> {
  final _form = GlobalKey<FormState>();
  late final TextEditingController _name;
  late final TextEditingController _city;
  late final TextEditingController _pace;

  @override
  void initState() {
    super.initState();
    final p = ref.read(authControllerProvider).value;
    _name = TextEditingController(text: p?.displayName ?? '');
    _city = TextEditingController(text: p?.city ?? '');
    _pace = TextEditingController(text: p?.avgPaceSecPerKm == null ? '' : formatPace(p!.avgPaceSecPerKm!));
  }

  @override
  void dispose() {
    _name.dispose();
    _city.dispose();
    _pace.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    final paceText = _pace.text.trim();
    await ref.read(authControllerProvider.notifier).updateProfile(
          displayName: _name.text.trim(),
          city: _city.text.trim(),
          avgPaceSecPerKm: paceText.isEmpty ? null : parsePace(paceText),
          clearPace: paceText.isEmpty,
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
      children: [
        Center(
          child: Stack(
            children: [
              Avatar(profile: profile, radius: 48),
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
                decoration: const InputDecoration(labelText: 'Kota', border: OutlineInputBorder()),
              ),
              const SizedBox(height: 8),
              TextFormField(
                controller: _pace,
                keyboardType: TextInputType.datetime,
                validator: (v) => (v ?? '').trim().isEmpty || parsePace(v!) != null ? null : 'Format m:dd, antara 2:00 dan 30:00',
                decoration: const InputDecoration(
                  labelText: 'Pace rata-rata (menit/km)',
                  hintText: '6:30',
                  border: OutlineInputBorder(),
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
        const Divider(),
        _PrivacyZoneTile(profile: profile),
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
              'Di chat komunitas, nama kamu akan tampil sebagai "Pengguna dihapus".',
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
        ref.invalidate(availableUpdateProvider);
        final release = await ref.read(availableUpdateProvider.future);
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
