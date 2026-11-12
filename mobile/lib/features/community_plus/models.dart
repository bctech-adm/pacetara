/// Model modul 2.6 Fitur komunitas lanjutan: jadwal/sesi + RSVP + absensi, liga, statistik, cari teman,
/// kas, pre-order jersey, dan spot lari. Semua batas paket ditegakkan server; aplikasi hanya menampilkan.
library;

class GeoPoint {
  const GeoPoint(this.lat, this.lng);
  final double lat;
  final double lng;

  static GeoPoint? fromJson(Object? j) {
    if (j is! Map<String, dynamic>) return null;
    return GeoPoint((j['lat'] as num).toDouble(), (j['lng'] as num).toDouble());
  }

  Map<String, dynamic> toJson() => {'lat': lat, 'lng': lng};
}

const weekdayNames = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];

/// Label zona waktu Indonesia.
String tzLabel(String tz) => switch (tz) {
      'Asia/Makassar' => 'WITA',
      'Asia/Jayapura' => 'WIT',
      _ => 'WIB',
    };

int tzOffsetHours(String tz) => switch (tz) {
      'Asia/Makassar' => 8,
      'Asia/Jayapura' => 9,
      _ => 7,
    };

/// Waktu setempat sesi (zona sesi, bukan zona HP), mis. "Sabtu, 15 Nov · 05.30 WIB".
String sessionTimeLabel(DateTime startsAtUtc, String tz) {
  final local = startsAtUtc.toUtc().add(Duration(hours: tzOffsetHours(tz)));
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  final hh = local.hour.toString().padLeft(2, '0');
  final mm = local.minute.toString().padLeft(2, '0');
  return '${weekdayNames[local.weekday - 1]}, ${local.day} ${months[local.month - 1]} · $hh.$mm ${tzLabel(tz)}';
}

/// Pace detik/km → "6:30/km".
String paceLabel(int? s) {
  if (s == null) return '-';
  return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}/km';
}

/// Rupiah bulat dengan pemisah ribuan titik: 1250000 → "Rp1.250.000".
String rupiah(int amount) {
  final neg = amount < 0;
  final digits = amount.abs().toString();
  final buf = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0) buf.write('.');
    buf.write(digits[i]);
  }
  return '${neg ? '-' : ''}Rp$buf';
}

String kmLabel(num meters) {
  final km = meters / 1000;
  return '${km.toStringAsFixed(km >= 100 ? 0 : 1).replaceAll('.', ',')} km';
}

class RunSchedule {
  const RunSchedule({
    required this.id,
    required this.title,
    required this.weekday,
    required this.startTime,
    required this.timezone,
    required this.locationName,
    this.point,
    this.distanceM,
    this.paceTargetSPerKm,
    this.notes = '',
    this.remind = true,
  });
  final String id;
  final String title;
  final int weekday;
  final String startTime;
  final String timezone;
  final String locationName;
  final GeoPoint? point;
  final int? distanceM;
  final int? paceTargetSPerKm;
  final String notes;
  final bool remind;

  String get label => 'Tiap ${weekdayNames[weekday - 1]} ${startTime.replaceAll(':', '.')} ${tzLabel(timezone)}';

  factory RunSchedule.fromJson(Map<String, dynamic> j) => RunSchedule(
        id: j['id'] as String,
        title: j['title'] as String,
        weekday: (j['weekday'] as num).toInt(),
        startTime: j['startTime'] as String,
        timezone: j['timezone'] as String? ?? 'Asia/Jakarta',
        locationName: j['locationName'] as String,
        point: GeoPoint.fromJson(j['point']),
        distanceM: (j['distanceM'] as num?)?.toInt(),
        paceTargetSPerKm: (j['paceTargetSPerKm'] as num?)?.toInt(),
        notes: j['notes'] as String? ?? '',
        remind: j['remind'] as bool? ?? true,
      );
}

class SessionMember {
  const SessionMember(this.userId, this.displayName, this.avatarUrl);
  final String userId;
  final String displayName;
  final String? avatarUrl;
}

class RunSession {
  const RunSession({
    required this.id,
    required this.communityId,
    required this.title,
    required this.startsAt,
    required this.timezone,
    required this.locationName,
    this.scheduleId,
    this.point,
    this.distanceM,
    this.paceTargetSPerKm,
    this.notes = '',
    this.cancelled = false,
    this.going = 0,
    this.notGoing = 0,
    this.myRsvp,
    this.attended = false,
    this.checkInOpen = false,
    this.gpsCheckIn = false,
    this.goingMembers = const [],
    this.attendanceEnabled = false,
    this.myRole,
    this.communityName,
  });

  final String id;
  final String communityId;
  final String? scheduleId;
  final String title;
  final DateTime startsAt;
  final String timezone;
  final String locationName;
  final GeoPoint? point;
  final int? distanceM;
  final int? paceTargetSPerKm;
  final String notes;
  final bool cancelled;
  final int going;
  final int notGoing;

  /// 'going', 'not_going', atau null (belum menjawab).
  final String? myRsvp;
  final bool attended;
  final bool checkInOpen;
  final bool gpsCheckIn;
  final List<SessionMember> goingMembers;
  final bool attendanceEnabled;
  final String? myRole;
  final String? communityName;

  bool get isStaff => myRole == 'owner' || myRole == 'admin';
  String get timeLabel => sessionTimeLabel(startsAt, timezone);

  factory RunSession.fromJson(Map<String, dynamic> j) {
    final rsvp = j['rsvp'] as Map<String, dynamic>? ?? const {};
    final checkIn = j['checkIn'] as Map<String, dynamic>? ?? const {};
    return RunSession(
      id: j['id'] as String,
      communityId: j['communityId'] as String,
      scheduleId: j['scheduleId'] as String?,
      title: j['title'] as String,
      startsAt: DateTime.parse(j['startsAt'] as String),
      timezone: j['timezone'] as String? ?? 'Asia/Jakarta',
      locationName: j['locationName'] as String,
      point: GeoPoint.fromJson(j['point']),
      distanceM: (j['distanceM'] as num?)?.toInt(),
      paceTargetSPerKm: (j['paceTargetSPerKm'] as num?)?.toInt(),
      notes: j['notes'] as String? ?? '',
      cancelled: j['cancelled'] as bool? ?? false,
      going: (rsvp['going'] as num?)?.toInt() ?? 0,
      notGoing: (rsvp['notGoing'] as num?)?.toInt() ?? 0,
      myRsvp: rsvp['mine'] as String?,
      attended: j['attended'] as bool? ?? false,
      checkInOpen: checkIn['open'] as bool? ?? false,
      gpsCheckIn: checkIn['gps'] as bool? ?? false,
      goingMembers: [
        for (final m in (j['goingMembers'] as List<dynamic>? ?? const []))
          SessionMember((m as Map<String, dynamic>)['userId'] as String, m['displayName'] as String, m['avatarUrl'] as String?),
      ],
      attendanceEnabled: j['attendanceEnabled'] as bool? ?? false,
      myRole: j['myRole'] as String?,
      communityName: (j['community'] as Map<String, dynamic>?)?['name'] as String?,
    );
  }
}

class AttendanceRow {
  const AttendanceRow({required this.userId, required this.displayName, required this.present, this.method, this.rsvp});
  final String userId;
  final String displayName;
  final bool present;
  final String? method;
  final String? rsvp;

  factory AttendanceRow.fromJson(Map<String, dynamic> j) => AttendanceRow(
        userId: j['userId'] as String,
        displayName: j['displayName'] as String,
        present: j['present'] as bool? ?? false,
        method: j['method'] as String?,
        rsvp: j['rsvp'] as String?,
      );
}

class LeagueEntry {
  const LeagueEntry({required this.rank, required this.communityId, required this.name, required this.totalM, required this.runs, required this.activeMembers, required this.scoreM, this.logoUrl});
  final int rank;
  final String communityId;
  final String name;
  final String? logoUrl;
  final int totalM;
  final int runs;
  final int activeMembers;
  final int scoreM;

  factory LeagueEntry.fromJson(Map<String, dynamic> j) {
    final c = j['community'] as Map<String, dynamic>;
    return LeagueEntry(
      rank: (j['rank'] as num).toInt(),
      communityId: c['id'] as String,
      name: c['name'] as String,
      logoUrl: c['logoUrl'] as String?,
      totalM: (j['totalM'] as num).toInt(),
      runs: (j['runs'] as num).toInt(),
      activeMembers: (j['activeMembers'] as num).toInt(),
      scoreM: (j['scoreM'] as num).toInt(),
    );
  }
}

class MyLeagueCommunity {
  const MyLeagueCommunity({required this.communityId, required this.name, required this.participating, required this.upgradeRequired, required this.isOwner, this.rank});
  final String communityId;
  final String name;
  final bool participating;
  final bool upgradeRequired;
  final bool isOwner;
  final int? rank;

  factory MyLeagueCommunity.fromJson(Map<String, dynamic> j) => MyLeagueCommunity(
        communityId: j['communityId'] as String,
        name: j['name'] as String,
        participating: j['participating'] as bool? ?? false,
        upgradeRequired: j['upgradeRequired'] as bool? ?? false,
        isOwner: j['isOwner'] as bool? ?? false,
        rank: (j['rank'] as num?)?.toInt(),
      );
}

class League {
  const League({required this.month, required this.city, required this.cities, required this.items, required this.mine, required this.rules});
  final String month;
  final String? city;
  final List<String> cities;
  final List<LeagueEntry> items;
  final List<MyLeagueCommunity> mine;
  final String rules;

  factory League.fromJson(Map<String, dynamic> j) => League(
        month: j['month'] as String,
        city: j['city'] as String?,
        cities: [for (final c in (j['cities'] as List<dynamic>? ?? const [])) (c as Map<String, dynamic>)['city'] as String],
        items: [for (final e in (j['items'] as List<dynamic>? ?? const [])) LeagueEntry.fromJson(e as Map<String, dynamic>)],
        mine: [for (final e in (j['mine'] as List<dynamic>? ?? const [])) MyLeagueCommunity.fromJson(e as Map<String, dynamic>)],
        rules: (j['rules'] as Map<String, dynamic>?)?['description'] as String? ?? '',
      );
}

class StatsPoint {
  const StatsPoint(this.start, this.totalM, this.runs, this.activeMembers, this.sessions, this.attendees);
  final String start;
  final int totalM;
  final int runs;
  final int activeMembers;
  final int sessions;
  final int attendees;

  factory StatsPoint.fromJson(Map<String, dynamic> j) => StatsPoint(
        j['start'] as String,
        (j['totalM'] as num).toInt(),
        (j['runs'] as num).toInt(),
        (j['activeMembers'] as num).toInt(),
        (j['sessions'] as num?)?.toInt() ?? 0,
        (j['attendees'] as num?)?.toInt() ?? 0,
      );
}

/// Jam lari favorit cari teman.
const buddySlots = <String, String>{
  'subuh': 'Subuh (04–06)',
  'pagi': 'Pagi (06–09)',
  'siang': 'Siang (09–15)',
  'sore': 'Sore (15–18)',
  'malam': 'Malam (18–22)',
};

class BuddyProfile {
  const BuddyProfile({required this.enabled, required this.paceSPerKm, required this.city, required this.slots, this.area});
  final bool enabled;
  final int paceSPerKm;
  final String city;
  final GeoPoint? area;
  final List<String> slots;

  factory BuddyProfile.fromJson(Map<String, dynamic> j) => BuddyProfile(
        enabled: j['enabled'] as bool? ?? true,
        paceSPerKm: (j['paceSPerKm'] as num).toInt(),
        city: j['city'] as String,
        area: GeoPoint.fromJson(j['area']),
        slots: [for (final s in (j['slots'] as List<dynamic>? ?? const [])) s as String],
      );
}

class BuddyResult {
  const BuddyResult({required this.userId, required this.displayName, required this.paceSPerKm, required this.city, required this.slots, required this.connection, this.avatarUrl, this.distanceKm, this.requestId});
  final String userId;
  final String displayName;
  final String? avatarUrl;
  final int? paceSPerKm;
  final String? city;
  final List<String> slots;
  final int? distanceKm;

  /// none, sent, received, connected.
  final String connection;
  final String? requestId;

  factory BuddyResult.fromJson(Map<String, dynamic> j) {
    final user = j['user'] as Map<String, dynamic>?;
    return BuddyResult(
      userId: (user?['id'] ?? j['userId']) as String,
      displayName: (user?['displayName'] ?? j['displayName']) as String,
      avatarUrl: (user?['avatarUrl'] ?? j['avatarUrl']) as String?,
      paceSPerKm: (j['paceSPerKm'] as num?)?.toInt(),
      city: j['city'] as String?,
      slots: [for (final s in (j['slots'] as List<dynamic>? ?? const [])) s as String],
      distanceKm: (j['distanceKm'] as num?)?.toInt(),
      connection: j['connection'] as String? ?? 'none',
      requestId: user != null ? j['id'] as String? : null,
    );
  }
}

class CashEntry {
  const CashEntry({required this.id, required this.kind, required this.amount, required this.category, required this.occurredOn, required this.description, this.recordedBy});
  final String id;
  final String kind;
  final int amount;
  final String category;
  final String occurredOn;
  final String description;
  final String? recordedBy;

  factory CashEntry.fromJson(Map<String, dynamic> j) => CashEntry(
        id: j['id'] as String,
        kind: j['kind'] as String,
        amount: (j['amount'] as num).toInt(),
        category: j['category'] as String,
        occurredOn: j['occurredOn'] as String,
        description: j['description'] as String? ?? '',
        recordedBy: j['recordedBy'] as String?,
      );
}

const cashCategories = <String, String>{
  'iuran': 'Iuran',
  'sponsor': 'Sponsor',
  'donasi': 'Donasi',
  'jersey': 'Jersey',
  'event': 'Event',
  'perlengkapan': 'Perlengkapan',
  'konsumsi': 'Konsumsi',
  'operasional': 'Operasional',
  'lainnya': 'Lainnya',
};

class CashBook {
  const CashBook({required this.notice, required this.proActive, required this.canWrite, required this.balance, required this.totalIn, required this.totalOut, required this.items});
  final String notice;
  final bool proActive;
  final bool canWrite;
  final int balance;
  final int totalIn;
  final int totalOut;
  final List<CashEntry> items;

  factory CashBook.fromJson(Map<String, dynamic> j) => CashBook(
        notice: j['notice'] as String? ?? '',
        proActive: j['proActive'] as bool? ?? false,
        canWrite: j['canWrite'] as bool? ?? false,
        balance: (j['balance'] as num).toInt(),
        totalIn: (j['totalIn'] as num).toInt(),
        totalOut: (j['totalOut'] as num).toInt(),
        items: [for (final e in (j['items'] as List<dynamic>? ?? const [])) CashEntry.fromJson(e as Map<String, dynamic>)],
      );
}

class JerseyOrder {
  const JerseyOrder({required this.id, required this.size, required this.quantity, required this.paid, this.note = '', this.userName});
  final String id;
  final String size;
  final int quantity;
  final bool paid;
  final String note;
  final String? userName;

  factory JerseyOrder.fromJson(Map<String, dynamic> j) => JerseyOrder(
        id: j['id'] as String,
        size: j['size'] as String,
        quantity: (j['quantity'] as num).toInt(),
        paid: j['paid'] as bool? ?? false,
        note: j['note'] as String? ?? '',
        userName: (j['user'] as Map<String, dynamic>?)?['displayName'] as String?,
      );
}

class JerseyItem {
  const JerseyItem({
    required this.id,
    required this.name,
    required this.description,
    required this.price,
    required this.sizes,
    required this.orderDeadline,
    required this.open,
    required this.totals,
    required this.totalQuantity,
    required this.myOrders,
    this.paidQuantity,
  });
  final String id;
  final String name;
  final String description;
  final int price;
  final List<String> sizes;
  final DateTime orderDeadline;
  final bool open;
  final Map<String, int> totals;
  final int totalQuantity;
  final int? paidQuantity;
  final List<JerseyOrder> myOrders;

  factory JerseyItem.fromJson(Map<String, dynamic> j) => JerseyItem(
        id: j['id'] as String,
        name: j['name'] as String,
        description: j['description'] as String? ?? '',
        price: (j['price'] as num).toInt(),
        sizes: [for (final s in (j['sizes'] as List<dynamic>)) s as String],
        orderDeadline: DateTime.parse(j['orderDeadline'] as String),
        open: j['open'] as bool? ?? false,
        totals: {
          for (final t in (j['totals'] as List<dynamic>? ?? const []))
            (t as Map<String, dynamic>)['size'] as String: (t['quantity'] as num).toInt(),
        },
        totalQuantity: (j['totalQuantity'] as num?)?.toInt() ?? 0,
        paidQuantity: (j['paidQuantity'] as num?)?.toInt(),
        myOrders: [for (final o in (j['myOrders'] as List<dynamic>? ?? const [])) JerseyOrder.fromJson(o as Map<String, dynamic>)],
      );
}

class JerseyBoard {
  const JerseyBoard({required this.notice, required this.proActive, required this.canManage, required this.items});
  final String notice;
  final bool proActive;
  final bool canManage;
  final List<JerseyItem> items;

  factory JerseyBoard.fromJson(Map<String, dynamic> j) => JerseyBoard(
        notice: j['notice'] as String? ?? '',
        proActive: j['proActive'] as bool? ?? false,
        canManage: j['canManage'] as bool? ?? false,
        items: [for (final e in (j['items'] as List<dynamic>? ?? const [])) JerseyItem.fromJson(e as Map<String, dynamic>)],
      );
}

class RunSpot {
  const RunSpot({required this.id, required this.name, required this.city, required this.point, this.lighting, this.toilet, this.parking, this.notes = '', this.status, this.rejectReason});
  final String id;
  final String name;
  final String city;
  final GeoPoint point;
  final int? lighting;
  final bool? toilet;
  final bool? parking;
  final String notes;
  final String? status;
  final String? rejectReason;

  factory RunSpot.fromJson(Map<String, dynamic> j) => RunSpot(
        id: j['id'] as String,
        name: j['name'] as String,
        city: j['city'] as String,
        point: GeoPoint.fromJson(j['point'])!,
        lighting: (j['lighting'] as num?)?.toInt(),
        toilet: j['toilet'] as bool?,
        parking: j['parking'] as bool?,
        notes: j['notes'] as String? ?? '',
        status: j['status'] as String?,
        rejectReason: j['rejectReason'] as String?,
      );
}

String lightingLabel(int? v) => switch (v) {
      0 => 'Tidak ada penerangan',
      1 => 'Penerangan sebagian',
      2 => 'Terang',
      _ => 'Penerangan tidak diketahui',
    };

String yesNo(bool? v, String label) => v == null ? '$label: ?' : '$label: ${v ? 'ada' : 'tidak ada'}';
