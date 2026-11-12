import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pacetara/features/community_plus/community_plus_repository.dart';
import 'package:pacetara/features/community_plus/models.dart';
import 'package:pacetara/features/community_plus/treasury_screens.dart';
import 'package:pacetara/features/subscriptions/upgrade.dart';

void main() {
  group('format', () {
    test('rupiah bulat dengan titik ribuan', () {
      expect(rupiah(0), 'Rp0');
      expect(rupiah(185000), 'Rp185.000');
      expect(rupiah(1250000), 'Rp1.250.000');
      expect(rupiah(-75000), '-Rp75.000');
    });

    test('pace dan waktu sesi di zona sesi (bukan zona HP)', () {
      expect(paceLabel(390), '6:30/km');
      expect(paceLabel(null), '-');
      // 22:30 UTC Jumat = Sabtu 05.30 WIB = 06.30 WITA.
      final t = DateTime.utc(2026, 11, 13, 22, 30);
      expect(sessionTimeLabel(t, 'Asia/Jakarta'), 'Sabtu, 14 Nov · 05.30 WIB');
      expect(sessionTimeLabel(t, 'Asia/Makassar'), 'Sabtu, 14 Nov · 06.30 WITA');
    });
  });

  group('model', () {
    test('sesi dengan RSVP dan check-in', () {
      final s = RunSession.fromJson({
        'id': 's1',
        'communityId': 'c1',
        'scheduleId': null,
        'title': 'Long run',
        'startsAt': '2026-11-13T22:30:00.000Z',
        'timezone': 'Asia/Jakarta',
        'locationName': 'Gasibu',
        'point': {'lat': -6.9, 'lng': 107.6},
        'distanceM': 15000,
        'paceTargetSPerKm': 390,
        'notes': '',
        'cancelled': false,
        'rsvp': {'going': 3, 'notGoing': 1, 'mine': 'going'},
        'attended': false,
        'checkIn': {'open': true, 'gps': true},
        'myRole': 'admin',
      });
      expect(s.going, 3);
      expect(s.myRsvp, 'going');
      expect(s.checkInOpen, isTrue);
      expect(s.gpsCheckIn, isTrue);
      expect(s.isStaff, isTrue);
      expect(s.point!.lat, -6.9);
    });

    test('hasil cari teman dan sapaan', () {
      final r = BuddyResult.fromJson({'userId': 'u1', 'displayName': 'Ani', 'paceSPerKm': 330, 'city': 'Bandung', 'slots': ['pagi'], 'distanceKm': 3, 'connection': 'none'});
      expect(r.distanceKm, 3);
      expect(r.requestId, isNull);
      final q = BuddyResult.fromJson({
        'id': 'r1',
        'user': {'id': 'u2', 'displayName': 'Budi', 'avatarUrl': null},
        'paceSPerKm': null,
        'city': null,
        'connection': 'received',
      });
      expect(q.userId, 'u2');
      expect(q.requestId, 'r1');
    });

    test('liga: komunitas gratis menampilkan ajakan upgrade', () {
      final l = League.fromJson({
        'month': '2026-11',
        'city': 'Bandung',
        'cities': [
          {'city': 'Bandung', 'communities': 2},
        ],
        'items': [
          {
            'rank': 1,
            'community': {'id': 'c1', 'name': 'Alpha', 'city': 'Bandung', 'logoUrl': null},
            'totalM': 15000,
            'runs': 2,
            'activeMembers': 2,
            'scoreM': 3000,
          },
        ],
        'mine': [
          {'communityId': 'c9', 'name': 'Charlie', 'participating': false, 'upgradeRequired': true, 'isOwner': true},
        ],
        'rules': {'description': 'Skor'},
      });
      expect(l.items.single.scoreM, 3000);
      expect(l.mine.single.upgradeRequired, isTrue);
    });
  });

  group('ajakan upgrade (limit.kind modul 2.6)', () {
    test('fitur komunitas ke Komunitas Pro hanya untuk pemilik; filter cari teman ke Premium', () {
      for (final k in ['attendance', 'community_cash', 'jersey', 'community_stats', 'league']) {
        expect(upgradeRoute(k, ownedCommunityId: 'c1'), '/subscription/community/c1');
        expect(upgradeRoute(k), isNull);
      }
      expect(upgradeRoute('buddy_filters'), '/subscription');
    });
  });

  testWidgets('kas menampilkan "pencatatan saja" dan saldo, tanpa tombol catat untuk anggota', (tester) async {
    await tester.pumpWidget(ProviderScope(
      overrides: [
        cashProvider('c1').overrideWith((ref) async => CashBook.fromJson({
              'notice': 'Pencatatan saja. Pembayaran dilakukan di luar aplikasi',
              'proActive': true,
              'canWrite': false,
              'balance': 175000,
              'totalIn': 250000,
              'totalOut': 75000,
              'items': [
                {'id': 'e1', 'kind': 'in', 'amount': 250000, 'category': 'iuran', 'occurredOn': '2026-11-01', 'description': 'Iuran', 'recordedBy': 'Bendahara'},
              ],
            })),
      ],
      child: const MaterialApp(home: CashScreen(communityId: 'c1')),
    ));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('record-only')), findsOneWidget);
    expect(find.text('Rp175.000'), findsOneWidget);
    expect(find.byKey(const Key('add-cash')), findsNothing);
  });
}
