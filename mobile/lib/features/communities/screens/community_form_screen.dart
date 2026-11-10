import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/widgets/common.dart';
import '../communities_repository.dart';
import '../models.dart';
import '../widgets.dart';

/// Buat komunitas baru ([initial] null) atau ubah pengaturan komunitas (admin).
class CommunityFormScreen extends ConsumerStatefulWidget {
  const CommunityFormScreen({super.key, this.initial});
  final CommunityDetail? initial;

  @override
  ConsumerState<CommunityFormScreen> createState() => _CommunityFormScreenState();
}

class _CommunityFormScreenState extends ConsumerState<CommunityFormScreen> {
  final _form = GlobalKey<FormState>();
  late final _name = TextEditingController(text: widget.initial?.summary.name ?? '');
  late final _city = TextEditingController(text: widget.initial?.summary.city ?? '');
  late final _description = TextEditingController(text: widget.initial?.description ?? '');
  late CommunityVisibility _visibility = widget.initial?.summary.visibility ?? CommunityVisibility.open;
  late bool _seeHistory = widget.initial?.newMembersSeeHistory ?? false;

  bool get _editing => widget.initial != null;

  @override
  void dispose() {
    _name.dispose();
    _city.dispose();
    _description.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    final repo = ref.read(communitiesRepositoryProvider);
    final router = GoRouter.of(context);
    if (_editing) {
      final id = widget.initial!.summary.id;
      await repo.update(id, {
        'name': _name.text.trim(),
        'city': _city.text.trim(),
        'description': _description.text.trim(),
        'visibility': _visibility.name,
        'newMembersSeeHistory': _seeHistory,
      });
      refreshCommunity(ref, id);
      router.pop();
    } else {
      late CommunityDetail created;
      final ok = await runCommunityAction(context, () async {
        created = await repo.create(
          name: _name.text.trim(),
          city: _city.text.trim(),
          description: _description.text.trim(),
          visibility: _visibility,
        );
      });
      if (!ok) return;
      ref.invalidate(myCommunitiesProvider);
      router.pushReplacement('/communities/${created.summary.id}');
    }
  }

  Future<void> _pickLogo() async {
    final file = await ImagePicker().pickImage(source: ImageSource.gallery, maxWidth: 1024, imageQuality: 90);
    if (file == null || !mounted) return;
    final id = widget.initial!.summary.id;
    await runCommunityAction(context, () => ref.read(communitiesRepositoryProvider).uploadLogo(id, file.path), success: 'Logo diperbarui');
    refreshCommunity(ref, id);
  }

  @override
  Widget build(BuildContext context) {
    return FormPage(
      title: _editing ? 'Pengaturan komunitas' : 'Buat komunitas',
      children: [
        if (_editing) ...[
          Center(
            child: Stack(
              children: [
                CommunityLogo(name: widget.initial!.summary.name, logoUrl: widget.initial!.summary.logoUrl, size: 96),
                Positioned(
                  right: -4,
                  bottom: -4,
                  child: IconButton.filledTonal(tooltip: 'Ganti logo', icon: const Icon(Icons.photo_camera_outlined), onPressed: _pickLogo),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
        ],
        Form(
          key: _form,
          child: Column(
            children: [
              TextFormField(
                controller: _name,
                maxLength: 60,
                textCapitalization: TextCapitalization.words,
                validator: (v) => (v ?? '').trim().length < 3 ? 'Nama minimal 3 karakter' : null,
                decoration: const InputDecoration(labelText: 'Nama komunitas', border: OutlineInputBorder()),
              ),
              const SizedBox(height: 8),
              TextFormField(
                controller: _city,
                maxLength: 60,
                textCapitalization: TextCapitalization.words,
                validator: (v) => (v ?? '').trim().length < 2 ? 'Kota wajib diisi' : null,
                decoration: const InputDecoration(labelText: 'Kota', border: OutlineInputBorder()),
              ),
              const SizedBox(height: 8),
              TextFormField(
                controller: _description,
                maxLength: 1000,
                minLines: 3,
                maxLines: 6,
                decoration: const InputDecoration(labelText: 'Deskripsi', alignLabelWithHint: true, border: OutlineInputBorder()),
              ),
            ],
          ),
        ),
        const SizedBox(height: 8),
        Text('Jenis komunitas', style: Theme.of(context).textTheme.titleSmall),
        RadioGroup<CommunityVisibility>(
          groupValue: _visibility,
          onChanged: (v) => setState(() => _visibility = v ?? _visibility),
          child: const Column(
            children: [
              RadioListTile(
                value: CommunityVisibility.open,
                contentPadding: EdgeInsets.zero,
                title: Text('Terbuka'),
                subtitle: Text('Siapa pun bisa langsung bergabung'),
              ),
              RadioListTile(
                value: CommunityVisibility.private,
                contentPadding: EdgeInsets.zero,
                title: Text('Privat'),
                subtitle: Text('Bergabung lewat kode undangan atau persetujuan admin'),
              ),
            ],
          ),
        ),
        if (_editing)
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            value: _seeHistory,
            onChanged: (v) => setState(() => _seeHistory = v),
            title: const Text('Anggota baru melihat riwayat chat'),
            subtitle: const Text('Jika mati, anggota baru hanya melihat pesan setelah mereka bergabung'),
          ),
        const SizedBox(height: 16),
        AsyncButton(label: _editing ? 'Simpan' : 'Buat komunitas', onPressed: _submit),
        if (!_editing) ...[
          const SizedBox(height: 12),
          const Text('Paket gratis: 1 komunitas dengan maksimal 3 anggota. Komunitas Pro menampung lebih banyak anggota dan multi-admin.'),
        ],
      ],
    );
  }
}
