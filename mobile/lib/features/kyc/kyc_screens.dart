import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/api/api_error.dart';
import '../../core/widgets/common.dart';
import '../auth/auth_controller.dart';
import 'kyc_repository.dart';

/// Pengambil foto dari kamera. Bisa diganti di tes. Mengembalikan byte foto, atau null jika dibatalkan.
typedef CapturePhoto = Future<Uint8List?> Function({required bool selfie});

/// Kamera HP lewat image_picker. Plugin menulis hasil jepretan ke folder cache aplikasi; byte dibaca ke memori lalu
/// berkasnya langsung dihapus agar foto KTP/selfie tidak tertinggal di HP.
Future<Uint8List?> cameraCapture({required bool selfie}) async {
  final file = await ImagePicker().pickImage(
    source: ImageSource.camera,
    preferredCameraDevice: selfie ? CameraDevice.front : CameraDevice.rear,
    maxWidth: 2000,
    imageQuality: 90,
    requestFullMetadata: false,
  );
  if (file == null) return null;
  try {
    return await file.readAsBytes();
  } finally {
    try {
      await File(file.path).delete();
    } catch (_) {
      // Berkas sementara sudah tidak ada.
    }
  }
}

final capturePhotoProvider = Provider<CapturePhoto>((ref) => cameraCapture);

/// Verifikasi Level 2 (modul 3.1): status → persetujuan (layar terpisah) → NIK + nama → foto KTP → selfie → hasil.
class KycScreen extends ConsumerWidget {
  const KycScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = ref.watch(kycStatusProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Verifikasi KTP')),
      body: status.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Text(ApiError.from(e).message, textAlign: TextAlign.center),
              const SizedBox(height: 12),
              OutlinedButton(onPressed: () => ref.invalidate(kycStatusProvider), child: const Text('Coba lagi')),
            ]),
          ),
        ),
        data: (s) => _StatusView(status: s),
      ),
    );
  }
}

class _StatusView extends StatelessWidget {
  const _StatusView({required this.status});
  final KycStatus status;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final last = status.last;
    Widget body;
    if (status.verified) {
      body = _Info(
        icon: Icons.verified,
        color: theme.colorScheme.primary,
        title: 'Akunmu Terverifikasi (Level 2)',
        text: 'Lencana Terverifikasi tampil di profilmu. Foto KTP dan selfie tidak disimpan; yang tersimpan hanya status ini dan NIK dalam bentuk kode satu arah.',
      );
    } else if (status.level < 1) {
      body = const _Info(icon: Icons.mark_email_read_outlined, title: 'Verifikasi email dan nomor HP dulu', text: 'Verifikasi KTP bisa dilakukan setelah akunmu Level 1.');
    } else if (status.inReview) {
      body = _Info(
        icon: Icons.hourglass_top,
        title: 'Sedang ditinjau tim PaceTara',
        text: 'Verifikasi otomatis belum yakin, jadi tim kami meninjaunya. Kamu akan mendapat notifikasi hasilnya.\n\n${last!.messages.join('\n')}',
      );
    } else if (!status.enabled) {
      body = const _Info(icon: Icons.construction, title: 'Verifikasi KTP belum tersedia', text: 'Coba lagi nanti.');
    } else {
      body = Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const _Info(
          icon: Icons.badge_outlined,
          title: 'Kenapa verifikasi KTP?',
          text: 'Level 2 wajib untuk membuat komunitas baru, berjualan dengan pembayaran di aplikasi, dan memasang banner sponsor. '
              'Kamu mendapat lencana Terverifikasi.',
        ),
        if (last != null && (last.status == 'rejected' || last.status == 'retry' || last.status == 'expired' || last.status == 'revoked')) ...[
          const SizedBox(height: 16),
          Card(
            color: theme.colorScheme.errorContainer,
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Text(
                [
                  switch (last.status) {
                    'rejected' => 'Percobaan terakhir tidak disetujui.',
                    'expired' => 'Tinjauan sebelumnya kedaluwarsa.',
                    'revoked' => 'Status Terverifikasi akunmu dicabut.',
                    _ => 'Percobaan terakhir perlu diulang.',
                  },
                  ...last.messages,
                  if (last.note != null) 'Catatan tim: ${last.note}',
                ].join('\n'),
                key: const Key('kyc-last'),
              ),
            ),
          ),
        ],
        const SizedBox(height: 24),
        FilledButton(
          key: const Key('kyc-start'),
          onPressed: status.attemptsLeft <= 0
              ? null
              : () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => KycConsentScreen(consentVersion: status.consentVersion))),
          child: Text(status.attemptsLeft <= 0 ? 'Batas percobaan hari ini habis' : 'Mulai verifikasi'),
        ),
        const SizedBox(height: 8),
        Text('Sisa percobaan hari ini: ${status.attemptsLeft}', textAlign: TextAlign.center, style: theme.textTheme.bodySmall),
      ]);
    }
    return ListView(padding: const EdgeInsets.all(24), children: [body]);
  }
}

class _Info extends StatelessWidget {
  const _Info({required this.icon, required this.title, required this.text, this.color});
  final IconData icon;
  final String title;
  final String text;
  final Color? color;

  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(icon, size: 48, color: color),
        const SizedBox(height: 12),
        Text(title, style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 8),
        Text(text),
      ]);
}

/// Layar persetujuan terpisah sebelum unggah (PRD 3.1). Versi naskah dikirim ke server dan dicatat per percobaan.
class KycConsentScreen extends StatefulWidget {
  const KycConsentScreen({super.key, required this.consentVersion});
  final String consentVersion;

  @override
  State<KycConsentScreen> createState() => _KycConsentScreenState();
}

class _KycConsentScreenState extends State<KycConsentScreen> {
  bool _agree = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Persetujuan verifikasi')),
      body: ListView(padding: const EdgeInsets.all(24), children: [
        Text('Sebelum kamu mengunggah foto KTP dan selfie', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 12),
        const Text(
          '• Foto KTP dan selfie dikirim terenkripsi ke server PaceTara, diproses di memori untuk membaca NIK dan nama serta '
          'mencocokkan wajah, lalu langsung dibuang. Foto tidak disimpan di server, tidak ditulis ke log, dan tidak dikirim ke pihak lain.\n\n'
          '• Yang disimpan: status verifikasi, NIK dalam bentuk kode HMAC satu arah (agar satu NIK hanya untuk satu akun), '
          'dan skor kecocokan tanpa data pribadi.\n\n'
          '• Jika verifikasi otomatis ragu, tim PaceTara meninjau skor serta nama yang terbaca dari KTP dan nama yang kamu ketik. '
          'Nama itu disimpan terenkripsi sampai ditinjau (paling lama 30 hari), lalu dihapus. Tim tidak bisa melihat fotomu.\n\n'
          '• Di HP, foto dari kamera langsung dihapus dari folder sementara setelah dibaca.\n\n'
          '• Kamu bisa menghapus akun kapan saja; status verifikasi dan kode NIK ikut terhapus.\n\n'
          '• Pakai hanya KTP milikmu sendiri. Memakai KTP orang lain melanggar hukum dan membuat akunmu diblokir.',
        ),
        const SizedBox(height: 16),
        CheckboxListTile(
          key: const Key('kyc-consent'),
          value: _agree,
          onChanged: (v) => setState(() => _agree = v ?? false),
          contentPadding: EdgeInsets.zero,
          controlAffinity: ListTileControlAffinity.leading,
          title: const Text('Saya setuju foto KTP dan selfie saya diproses untuk verifikasi seperti dijelaskan di atas'),
        ),
        const SizedBox(height: 16),
        FilledButton(
          key: const Key('kyc-consent-next'),
          onPressed: _agree
              ? () => Navigator.of(context).pushReplacement(MaterialPageRoute<void>(builder: (_) => KycCaptureScreen(consentVersion: widget.consentVersion)))
              : null,
          child: const Text('Lanjut'),
        ),
      ]),
    );
  }
}

/// NIK + nama sesuai KTP, foto KTP (kamera belakang), selfie (kamera depan), lalu kirim. Foto hanya di memori.
class KycCaptureScreen extends ConsumerStatefulWidget {
  const KycCaptureScreen({super.key, required this.consentVersion});
  final String consentVersion;

  @override
  ConsumerState<KycCaptureScreen> createState() => _KycCaptureScreenState();
}

class _KycCaptureScreenState extends ConsumerState<KycCaptureScreen> {
  final _form = GlobalKey<FormState>();
  final _nik = TextEditingController();
  final _name = TextEditingController();
  Uint8List? _ktp;
  Uint8List? _selfie;

  @override
  void dispose() {
    _nik.dispose();
    _name.dispose();
    _wipe();
    super.dispose();
  }

  /// Upaya terbaik menghapus isi foto dari memori aplikasi.
  void _wipe() {
    _ktp?.fillRange(0, _ktp!.length, 0);
    _selfie?.fillRange(0, _selfie!.length, 0);
    _ktp = null;
    _selfie = null;
  }

  Future<void> _capture({required bool selfie}) async {
    try {
      final bytes = await ref.read(capturePhotoProvider)(selfie: selfie);
      if (bytes == null || !mounted) return;
      setState(() {
        if (selfie) {
          _selfie?.fillRange(0, _selfie!.length, 0);
          _selfie = bytes;
        } else {
          _ktp?.fillRange(0, _ktp!.length, 0);
          _ktp = bytes;
        }
      });
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    if (_ktp == null || _selfie == null) {
      showInfo(context, 'Ambil foto KTP dan selfie dulu');
      return;
    }
    final nav = Navigator.of(context);
    final result = await ref.read(kycRepositoryProvider).submit(
          nik: _nik.text.trim(),
          name: _name.text.trim(),
          consentVersion: widget.consentVersion,
          ktp: _ktp!,
          selfie: _selfie!,
        );
    ref.invalidate(kycStatusProvider);
    if (result.status == 'approved') await ref.read(authControllerProvider.notifier).reload();
    if (!mounted) return;
    if (result.status == 'retry') {
      // Ulangi: foto lama dibuang, ketikan tetap.
      setState(_wipe);
      await showDialog<void>(
        context: context,
        builder: (d) => AlertDialog(
          title: const Text('Coba lagi'),
          content: Text(result.messages.join('\n\n')),
          actions: [TextButton(onPressed: () => Navigator.pop(d), child: const Text('Mengerti'))],
        ),
      );
      return;
    }
    setState(_wipe);
    await showDialog<void>(
      context: context,
      builder: (d) => AlertDialog(
        icon: Icon(result.status == 'approved' ? Icons.verified : Icons.hourglass_top),
        title: Text(result.status == 'approved' ? 'Terverifikasi' : 'Sedang ditinjau'),
        content: Text(result.status == 'approved'
            ? 'Akunmu sekarang Level 2 dan mendapat lencana Terverifikasi.'
            : 'Verifikasi otomatis belum yakin, jadi tim PaceTara akan meninjaunya. Kamu akan mendapat notifikasi hasilnya.'),
        actions: [TextButton(onPressed: () => Navigator.pop(d), child: const Text('Selesai'))],
      ),
    );
    nav.pop();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Foto KTP dan selfie')),
      body: Form(
        key: _form,
        child: ListView(padding: const EdgeInsets.all(24), children: [
          TextFormField(
            key: const Key('kyc-nik'),
            controller: _nik,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(16)],
            decoration: const InputDecoration(labelText: 'NIK (16 digit)', border: OutlineInputBorder()),
            validator: (v) => (v ?? '').length == 16 ? null : 'NIK harus 16 digit',
          ),
          const SizedBox(height: 12),
          TextFormField(
            key: const Key('kyc-name'),
            controller: _name,
            textCapitalization: TextCapitalization.characters,
            decoration: const InputDecoration(labelText: 'Nama lengkap sesuai KTP', border: OutlineInputBorder()),
            validator: (v) => (v ?? '').trim().length >= 2 ? null : 'Nama wajib diisi',
          ),
          const SizedBox(height: 20),
          _PhotoTile(
            key: const Key('kyc-photo-ktp'),
            title: 'Foto KTP',
            hint: 'KTP utuh, tegak, fokus, tanpa pantulan cahaya. Pakai kamera belakang.',
            bytes: _ktp,
            onTap: () => _capture(selfie: false),
          ),
          const SizedBox(height: 12),
          _PhotoTile(
            key: const Key('kyc-photo-selfie'),
            title: 'Selfie',
            hint: 'Wajah menghadap kamera, cahaya cukup, tanpa masker/kacamata hitam. Hanya kamu di foto.',
            bytes: _selfie,
            onTap: () => _capture(selfie: true),
          ),
          const SizedBox(height: 24),
          AsyncButton(key: const Key('kyc-submit'), label: 'Kirim untuk verifikasi', onPressed: _submit),
        ]),
      ),
    );
  }
}

class _PhotoTile extends StatelessWidget {
  const _PhotoTile({super.key, required this.title, required this.hint, required this.bytes, required this.onTap});
  final String title;
  final String hint;
  final Uint8List? bytes;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Card(
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Row(children: [
              SizedBox(
                width: 96,
                height: 72,
                child: bytes == null
                    ? const Icon(Icons.photo_camera_outlined, size: 36)
                    : Image.memory(bytes!, fit: BoxFit.cover, gaplessPlayback: true),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(bytes == null ? title : '$title ✓', style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 4),
                  Text(bytes == null ? hint : 'Ketuk untuk mengambil ulang', style: Theme.of(context).textTheme.bodySmall),
                ]),
              ),
            ]),
          ),
        ),
      );
}
