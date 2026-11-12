import 'package:flutter_test/flutter_test.dart';
import 'package:pacetara/features/moderation/removals.dart';

void main() {
  Map<String, dynamic> j({Map<String, dynamic>? appeal, bool canAppeal = true, bool restored = false}) => {
        'id': 'r1',
        'targetType': 'community',
        'label': 'Lari Pagi',
        'restorable': true,
        'removedAt': '2026-11-10T06:00:00Z',
        'appealUntil': '2026-11-24T06:00:00Z',
        'canAppeal': canAppeal,
        'appeal': appeal,
        'restored': restored,
      };

  test('status penurunan konten dan banding', () {
    final open = ContentRemoval.fromJson(j());
    expect(open.typeLabel, 'Komunitas');
    expect(open.statusText, startsWith('Bisa dibanding sampai'));
    expect(ContentRemoval.fromJson(j(canAppeal: false, appeal: {'status': 'open', 'note': null})).statusText, 'Banding sedang ditinjau');
    expect(ContentRemoval.fromJson(j(canAppeal: false, appeal: {'status': 'accepted', 'note': 'ok'}, restored: true)).statusText,
        'Banding diterima, konten dipulihkan');
    expect(ContentRemoval.fromJson(j(canAppeal: false, appeal: {'status': 'rejected', 'note': 'Tetap melanggar'})).statusText,
        'Banding ditolak: Tetap melanggar');
    expect(ContentRemoval.fromJson(j(canAppeal: false)).statusText, 'Batas banding sudah lewat');
  });
}
