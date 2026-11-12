import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { type CommunityAccess, communityAccess, requirePro, requireStaff } from '../communities/access.js';
import { type Queryable, withTx } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { ENV, type Env } from '../config/env.js';
import { PG_POOL } from '../core.module.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { hasProFeature } from '../plans/plans.js';
import { avatarPath } from '../users/users.repository.js';
import {
  CHECKIN_MAX_ACCURACY_M,
  CHECKIN_OPENS_BEFORE_MS,
  CHECKIN_RADIUS_M,
  checkInWindow,
  distanceM,
  isCheckInOpen,
  makeQrToken,
  QR_STEP_S,
  qrKey,
  verifyQrToken,
} from './attendance.js';

export const TIMEZONES = ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'] as const;
/** Admin bisa mengoreksi absensi manual sampai sekian hari setelah sesi mulai. */
export const MANUAL_ATTENDANCE_DAYS = 7;
export type Timezone = (typeof TIMEZONES)[number];

/** Sesi dari jadwal rutin dibentuk sampai 28 hari ke depan (job worker + saat jadwal dibuat/daftar dibuka). */
export const SESSION_HORIZON_DAYS = 28;
/** Batas wajar (bukan batas paket; jadwal + RSVP gratis untuk semua komunitas). */
export const MAX_ACTIVE_SCHEDULES = 10;
export const MAX_UPCOMING_ONE_OFF = 20;
/** Pengingat dikirim 2 jam sebelum sesi ke anggota yang RSVP "ikut". */
export const REMINDER_BEFORE_MS = 2 * 3_600_000;

export interface SessionFields {
  title: string;
  locationName: string;
  point?: { lat: number; lng: number } | null;
  distanceM?: number | null;
  paceTargetSPerKm?: number | null;
  notes?: string;
  remind?: boolean;
  timezone?: Timezone;
}

interface ScheduleRow {
  id: string;
  community_id: string;
  title: string;
  weekday: number;
  start_time: string;
  timezone: Timezone;
  location_name: string;
  lat: number | null;
  lng: number | null;
  distance_m: number | null;
  pace_target_s_per_km: number | null;
  notes: string;
  remind: boolean;
  active: boolean;
}

interface SessionRow {
  id: string;
  community_id: string;
  schedule_id: string | null;
  title: string;
  starts_at: Date;
  timezone: Timezone;
  location_name: string;
  lat: number | null;
  lng: number | null;
  distance_m: number | null;
  pace_target_s_per_km: number | null;
  notes: string;
  remind: boolean;
  cancelled_at: Date | null;
}

const SESSION_COLS = `s.id, s.community_id, s.schedule_id, s.title, s.starts_at, s.timezone, s.location_name, s.lat, s.lng,
  s.distance_m, s.pace_target_s_per_km, s.notes, s.remind, s.cancelled_at`;

/** Bentuk sesi dari jadwal aktif untuk SESSION_HORIZON_DAYS ke depan. Idempoten (unik schedule_id + starts_at). */
const MATERIALIZE_SQL = (where: string) => `
  INSERT INTO community_sessions (community_id, schedule_id, title, starts_at, timezone, location_name, lat, lng,
                                  distance_m, pace_target_s_per_km, notes, remind, created_by)
  SELECT sc.community_id, sc.id, sc.title, ((d::date + sc.start_time) AT TIME ZONE sc.timezone), sc.timezone, sc.location_name,
         sc.lat, sc.lng, sc.distance_m, sc.pace_target_s_per_km, sc.notes, sc.remind, sc.created_by
    FROM community_schedules sc
    JOIN communities c ON c.id = sc.community_id AND c.removed_at IS NULL
    CROSS JOIN LATERAL generate_series((now() AT TIME ZONE sc.timezone)::date,
                                       (now() AT TIME ZONE sc.timezone)::date + ${SESSION_HORIZON_DAYS}, interval '1 day') d
   WHERE sc.active AND extract(isodow FROM d) = sc.weekday
     AND ((d::date + sc.start_time) AT TIME ZONE sc.timezone) > now()
     AND ${where}
  ON CONFLICT (schedule_id, starts_at) WHERE schedule_id IS NOT NULL DO NOTHING`;

/**
 * Jadwal lari rutin + RSVP (gratis & Pro) dan absensi QR/GPS (Komunitas Pro). Hak akses selalu lewat
 * communityAccess: orang luar/komunitas diturunkan = 404. Jadwal ditulis admin/pemilik; RSVP oleh anggota aktif.
 */
@Injectable()
export class SchedulesService {
  private readonly qrKey: Buffer;

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(ENV) env: Env,
    private readonly notifications: NotificationsService,
  ) {
    this.qrKey = qrKey(env.BLIND_INDEX_KEY);
  }

  // ---------- Jadwal rutin ----------

  async schedules(userId: string, communityId: string) {
    await communityAccess(this.pool, communityId, userId);
    const { rows } = await this.pool.query<ScheduleRow>(
      `SELECT id, community_id, title, weekday, to_char(start_time, 'HH24:MI') AS start_time, timezone, location_name, lat, lng,
              distance_m, pace_target_s_per_km, notes, remind, active
         FROM community_schedules WHERE community_id = $1 AND active ORDER BY weekday, start_time`,
      [communityId],
    );
    return { items: rows.map(scheduleJson) };
  }

  async createSchedule(userId: string, communityId: string, input: SessionFields & { weekday: number; startTime: string }) {
    const id = await withTx(this.pool, async (db) => {
      requireStaff(await communityAccess(db, communityId, userId, true));
      // FOR SHARE di communityAccess tidak saling menghalangi: kunci per komunitas agar hitungan batas tidak bisa didahului.
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`schedules:${communityId}`]);
      const { rows: n } = await db.query<{ n: string }>('SELECT count(*) AS n FROM community_schedules WHERE community_id = $1 AND active', [communityId]);
      if (Number(n[0]!.n) >= MAX_ACTIVE_SCHEDULES) {
        throw new ApiError(409, 'too_many_schedules', `Maksimal ${MAX_ACTIVE_SCHEDULES} jadwal rutin aktif per komunitas`);
      }
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO community_schedules (community_id, title, weekday, start_time, timezone, location_name, lat, lng, distance_m,
                                          pace_target_s_per_km, notes, remind, created_by)
         VALUES ($1, $2, $3, $4::time, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
        [
          communityId,
          input.title,
          input.weekday,
          input.startTime,
          input.timezone ?? 'Asia/Jakarta',
          input.locationName,
          input.point?.lat ?? null,
          input.point?.lng ?? null,
          input.distanceM ?? null,
          input.paceTargetSPerKm ?? null,
          input.notes ?? '',
          input.remind ?? true,
          userId,
        ],
      );
      const sid = rows[0]!.id;
      await db.query(MATERIALIZE_SQL('sc.id = $1'), [sid]);
      return sid;
    });
    await this.notifyMembers(userId, communityId, { type: 'session_new', data: { scheduleId: id } }, 'Jadwal lari baru');
    return this.schedule(communityId, id);
  }

  async updateSchedule(userId: string, communityId: string, scheduleId: string, patch: Partial<SessionFields & { weekday: number; startTime: string }>) {
    await withTx(this.pool, async (db) => {
      requireStaff(await communityAccess(db, communityId, userId, true));
      const { rows } = await db.query<ScheduleRow>(
        `SELECT id, weekday, to_char(start_time, 'HH24:MI') AS start_time, timezone FROM community_schedules
          WHERE id = $1 AND community_id = $2 AND active FOR UPDATE`,
        [scheduleId, communityId],
      );
      const cur = rows[0];
      if (!cur) throw scheduleNotFound();
      const sets: string[] = [];
      const values: unknown[] = [scheduleId];
      const add = (col: string, v: unknown, cast = '') => {
        values.push(v);
        sets.push(`${col} = $${values.length}${cast}`);
      };
      if (patch.title !== undefined) add('title', patch.title);
      if (patch.weekday !== undefined) add('weekday', patch.weekday);
      if (patch.startTime !== undefined) add('start_time', patch.startTime, '::time');
      if (patch.timezone !== undefined) add('timezone', patch.timezone);
      if (patch.locationName !== undefined) add('location_name', patch.locationName);
      if (patch.point !== undefined) {
        add('lat', patch.point?.lat ?? null);
        add('lng', patch.point?.lng ?? null);
      }
      if (patch.distanceM !== undefined) add('distance_m', patch.distanceM);
      if (patch.paceTargetSPerKm !== undefined) add('pace_target_s_per_km', patch.paceTargetSPerKm);
      if (patch.notes !== undefined) add('notes', patch.notes);
      if (patch.remind !== undefined) add('remind', patch.remind);
      if (!sets.length) return;
      await db.query(`UPDATE community_schedules SET ${sets.join(', ')} WHERE id = $1`, values);
      const timingChanged =
        (patch.weekday !== undefined && patch.weekday !== cur.weekday) ||
        (patch.startTime !== undefined && patch.startTime !== cur.start_time) ||
        (patch.timezone !== undefined && patch.timezone !== cur.timezone);
      if (timingChanged) {
        // Waktu berubah: sesi mendatang (beserta RSVP-nya) dibentuk ulang.
        await db.query('DELETE FROM community_sessions WHERE schedule_id = $1 AND starts_at > now()', [scheduleId]);
      } else {
        // Detail lain diterapkan ke sesi mendatang yang belum dibatalkan.
        await db.query(
          `UPDATE community_sessions s SET title = sc.title, location_name = sc.location_name, lat = sc.lat, lng = sc.lng,
                  distance_m = sc.distance_m, pace_target_s_per_km = sc.pace_target_s_per_km, notes = sc.notes, remind = sc.remind
             FROM community_schedules sc WHERE sc.id = s.schedule_id AND s.schedule_id = $1 AND s.starts_at > now() AND s.cancelled_at IS NULL`,
          [scheduleId],
        );
      }
      await db.query(MATERIALIZE_SQL('sc.id = $1'), [scheduleId]);
    });
    return this.schedule(communityId, scheduleId);
  }

  /** Hentikan jadwal: sesi mendatang dihapus; sesi yang sudah lewat (beserta absensinya) tetap. */
  async deleteSchedule(userId: string, communityId: string, scheduleId: string): Promise<void> {
    await withTx(this.pool, async (db) => {
      requireStaff(await communityAccess(db, communityId, userId, true));
      const { rowCount } = await db.query('SELECT 1 FROM community_schedules WHERE id = $1 AND community_id = $2 FOR UPDATE', [scheduleId, communityId]);
      if (!rowCount) throw scheduleNotFound();
      await db.query('DELETE FROM community_sessions WHERE schedule_id = $1 AND starts_at > now()', [scheduleId]);
      await db.query('DELETE FROM community_schedules WHERE id = $1', [scheduleId]);
    });
  }

  private async schedule(communityId: string, scheduleId: string) {
    const { rows } = await this.pool.query<ScheduleRow>(
      `SELECT id, community_id, title, weekday, to_char(start_time, 'HH24:MI') AS start_time, timezone, location_name, lat, lng,
              distance_m, pace_target_s_per_km, notes, remind, active
         FROM community_schedules WHERE id = $1 AND community_id = $2`,
      [scheduleId, communityId],
    );
    if (!rows[0]) throw scheduleNotFound();
    return scheduleJson(rows[0]);
  }

  // ---------- Sesi ----------

  async sessions(userId: string, communityId: string, scope: 'upcoming' | 'past') {
    const access = await communityAccess(this.pool, communityId, userId);
    if (scope === 'upcoming') await this.pool.query(MATERIALIZE_SQL('sc.community_id = $1'), [communityId]);
    // Sesi "mendatang" tetap tampil sampai jendela check-in ditutup (3 jam setelah mulai).
    const { rows } = await this.pool.query<SessionRow>(
      `SELECT ${SESSION_COLS} FROM community_sessions s
        WHERE s.community_id = $1 AND ${scope === 'upcoming' ? `s.starts_at > now() - interval '3 hours'` : `s.starts_at <= now() - interval '3 hours'`}
        ORDER BY s.starts_at ${scope === 'upcoming' ? 'ASC' : 'DESC'} LIMIT 60`,
      [communityId],
    );
    return { items: await this.sessionJson(userId, access, rows), attendanceEnabled: hasProFeature(access.plan, 'attendance') };
  }

  async createSession(userId: string, communityId: string, input: SessionFields & { startsAt: Date }) {
    if (input.startsAt.getTime() <= Date.now()) throw new ApiError(400, 'session_in_past', 'Waktu sesi harus di masa depan');
    if (input.startsAt.getTime() > Date.now() + 366 * 86_400_000) throw new ApiError(400, 'session_too_far', 'Sesi maksimal setahun ke depan');
    const id = await withTx(this.pool, async (db) => {
      requireStaff(await communityAccess(db, communityId, userId, true));
      // FOR SHARE di communityAccess tidak saling menghalangi: kunci per komunitas agar hitungan batas tidak bisa didahului.
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`sessions:${communityId}`]);
      const { rows: n } = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM community_sessions WHERE community_id = $1 AND schedule_id IS NULL AND starts_at > now() AND cancelled_at IS NULL`,
        [communityId],
      );
      if (Number(n[0]!.n) >= MAX_UPCOMING_ONE_OFF) throw new ApiError(409, 'too_many_sessions', `Maksimal ${MAX_UPCOMING_ONE_OFF} sesi sekali jalan yang akan datang`);
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO community_sessions (community_id, title, starts_at, timezone, location_name, lat, lng, distance_m, pace_target_s_per_km,
                                         notes, remind, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [
          communityId,
          input.title,
          input.startsAt,
          input.timezone ?? 'Asia/Jakarta',
          input.locationName,
          input.point?.lat ?? null,
          input.point?.lng ?? null,
          input.distanceM ?? null,
          input.paceTargetSPerKm ?? null,
          input.notes ?? '',
          input.remind ?? true,
          userId,
        ],
      );
      return rows[0]!.id;
    });
    await this.notifyMembers(userId, communityId, { type: 'session_new', data: { sessionId: id } }, 'Sesi lari baru');
    return this.session(userId, id);
  }

  async session(userId: string, sessionId: string) {
    const { row, access } = await this.sessionAccess(this.pool, userId, sessionId);
    const [json] = await this.sessionJson(userId, access, [row]);
    const { rows: going } = await this.pool.query<{ user_id: string; display_name: string; avatar_key: string | null; avatar_updated_at: Date | null }>(
      `SELECT r.user_id, u.display_name, u.avatar_key, u.avatar_updated_at
         FROM session_rsvps r JOIN users u ON u.id = r.user_id AND u.status = 'active'
         JOIN community_members m ON m.community_id = $2 AND m.user_id = r.user_id AND m.status = 'active'
        WHERE r.session_id = $1 AND r.going ORDER BY r.updated_at LIMIT 200`,
      [sessionId, row.community_id],
    );
    return {
      ...json!,
      community: { id: access.communityId, name: access.name },
      goingMembers: going.map((g) => ({ userId: g.user_id, displayName: g.display_name, avatarUrl: avatarPath({ id: g.user_id, avatar_key: g.avatar_key, avatar_updated_at: g.avatar_updated_at }) })),
      attendanceEnabled: hasProFeature(access.plan, 'attendance'),
      myRole: access.role,
    };
  }

  async cancelSession(userId: string, sessionId: string): Promise<void> {
    const outcome = await withTx(this.pool, async (db) => {
      const { row, access } = await this.sessionAccess(db, userId, sessionId, true);
      requireStaff(access);
      if (row.cancelled_at) return null;
      if (row.starts_at.getTime() <= Date.now()) throw new ApiError(409, 'session_started', 'Sesi sudah dimulai');
      await db.query('UPDATE community_sessions SET cancelled_at = now() WHERE id = $1', [sessionId]);
      const { rows } = await db.query<{ user_id: string }>('SELECT user_id FROM session_rsvps WHERE session_id = $1 AND going', [sessionId]);
      return { communityId: row.community_id, going: rows.map((r) => r.user_id) };
    });
    if (!outcome) return;
    const l = await this.notifications.labels(userId, outcome.communityId);
    await this.notifications.notify(outcome.going, {
      category: 'schedule',
      actorId: userId,
      communityId: outcome.communityId,
      inbox: { type: 'session_cancelled', data: { sessionId } },
      push: { title: 'Sesi lari dibatalkan', body: `Sesi lari ${l.community} dibatalkan`, data: { type: 'session_cancelled', sessionId, communityId: outcome.communityId } },
    });
  }

  /** RSVP ikut / tidak ikut. Hanya anggota aktif, sebelum sesi dimulai, sesi tidak dibatalkan. */
  async rsvp(userId: string, sessionId: string, going: boolean) {
    await withTx(this.pool, async (db) => {
      const { row } = await this.sessionAccess(db, userId, sessionId);
      if (row.cancelled_at) throw new ApiError(409, 'session_cancelled', 'Sesi sudah dibatalkan');
      if (row.starts_at.getTime() <= Date.now()) throw new ApiError(409, 'session_started', 'Sesi sudah dimulai');
      await db.query(
        `INSERT INTO session_rsvps (session_id, user_id, going) VALUES ($1, $2, $3)
         ON CONFLICT (session_id, user_id) DO UPDATE SET going = EXCLUDED.going, updated_at = now()`,
        [sessionId, userId, going],
      );
    });
    return this.session(userId, sessionId);
  }

  async clearRsvp(userId: string, sessionId: string): Promise<void> {
    await this.sessionAccess(this.pool, userId, sessionId);
    await this.pool.query('DELETE FROM session_rsvps WHERE session_id = $1 AND user_id = $2', [sessionId, userId]);
  }

  // ---------- Absensi (Komunitas Pro) ----------

  /** Token QR yang ditampilkan admin; berganti tiap QR_STEP_S detik. */
  async qr(userId: string, sessionId: string) {
    const { row, access } = await this.sessionAccess(this.pool, userId, sessionId);
    requirePro(requireStaff(access), 'attendance');
    this.assertCheckInOpen(row);
    const { token, expiresAt } = makeQrToken(this.qrKey, sessionId);
    return { token, expiresAt: expiresAt.toISOString(), refreshAfterS: QR_STEP_S };
  }

  async checkInQr(userId: string, sessionId: string, token: string) {
    return withTx(this.pool, async (db) => {
      const { row, access } = await this.sessionAccess(db, userId, sessionId, true);
      requirePro(access, 'attendance');
      this.assertCheckInOpen(row);
      const check = verifyQrToken(this.qrKey, sessionId, token);
      if (check === 'expired') throw new ApiError(409, 'qr_expired', 'Kode QR sudah kedaluwarsa. Pindai kode terbaru di HP admin');
      if (check !== 'ok') throw new ApiError(400, 'qr_invalid', 'Kode QR tidak valid untuk sesi ini');
      return this.recordAttendance(db, sessionId, userId, 'qr', null);
    });
  }

  /**
   * Check-in GPS: posisi dikirim di body, dibandingkan dengan titik kumpul, lalu DIBUANG (tidak disimpan, tidak di-log).
   * Hanya hasilnya yang dicatat. Lokasi bisa dipalsukan (aplikasi mock location); aplikasi menolak posisi yang ditandai
   * mock oleh Android dan server menolak `mocked: true`, tetapi ini bukan jaminan (lihat KEPUTUSAN). QR lebih kuat.
   */
  async checkInGps(userId: string, sessionId: string, pos: { lat: number; lng: number; accuracyM: number; mocked?: boolean }) {
    return withTx(this.pool, async (db) => {
      const { row, access } = await this.sessionAccess(db, userId, sessionId, true);
      requirePro(access, 'attendance');
      this.assertCheckInOpen(row);
      if (row.lat === null || row.lng === null) throw new ApiError(409, 'no_meeting_point', 'Sesi ini tidak punya titik kumpul untuk check-in GPS. Gunakan QR');
      if (pos.mocked) throw new ApiError(400, 'mock_location', 'Lokasi palsu terdeteksi. Matikan aplikasi lokasi palsu atau gunakan QR');
      if (pos.accuracyM > CHECKIN_MAX_ACCURACY_M) {
        throw new ApiError(400, 'gps_inaccurate', `Sinyal GPS kurang akurat (lebih dari ${CHECKIN_MAX_ACCURACY_M} m). Coba di tempat terbuka atau gunakan QR`);
      }
      const d = distanceM(pos, { lat: row.lat, lng: row.lng });
      if (d > CHECKIN_RADIUS_M) {
        throw new ApiError(403, 'too_far', `Kamu berada di luar radius ${CHECKIN_RADIUS_M} m dari titik kumpul`, { radiusM: CHECKIN_RADIUS_M });
      }
      return this.recordAttendance(db, sessionId, userId, 'gps', null);
    });
  }

  /** Admin menandai hadir/tidak hadir secara manual (mis. HP anggota mati). */
  async markAttendance(adminId: string, sessionId: string, targetId: string, present: boolean) {
    await withTx(this.pool, async (db) => {
      const { row, access } = await this.sessionAccess(db, adminId, sessionId, true);
      requirePro(requireStaff(access), 'attendance');
      if (row.starts_at.getTime() - Date.now() > CHECKIN_OPENS_BEFORE_MS) throw new ApiError(409, 'checkin_not_open', 'Absensi belum dibuka');
      // Koreksi manual diberi waktu lebih panjang dari jendela QR/GPS (anggota lupa absen), tetapi tetap ditutup
      // agar rekap kehadiran dan statistik lama tidak bisa diubah kapan saja.
      if (Date.now() - row.starts_at.getTime() > MANUAL_ATTENDANCE_DAYS * 86_400_000) {
        throw new ApiError(409, 'checkin_closed', `Absensi manual hanya bisa diubah sampai ${MANUAL_ATTENDANCE_DAYS} hari setelah sesi`);
      }
      if (!present) {
        await db.query('DELETE FROM session_attendance WHERE session_id = $1 AND user_id = $2', [sessionId, targetId]);
        return;
      }
      const { rowCount } = await db.query(
        `SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2 AND status = 'active'`,
        [row.community_id, targetId],
      );
      if (!rowCount) throw new ApiError(404, 'member_not_found', 'Anggota tidak ditemukan');
      await this.recordAttendance(db, sessionId, targetId, 'manual', adminId);
    });
    return this.attendance(adminId, sessionId);
  }

  /** Rekap satu sesi (admin). Tetap bisa dibaca setelah Pro berakhir (data tidak dihapus). */
  async attendance(userId: string, sessionId: string) {
    const { row, access } = await this.sessionAccess(this.pool, userId, sessionId);
    requireStaff(access);
    const { rows } = await this.pool.query<{
      user_id: string;
      display_name: string;
      avatar_key: string | null;
      avatar_updated_at: Date | null;
      going: boolean | null;
      method: string | null;
      checked_at: Date | null;
    }>(
      `SELECT m.user_id, u.display_name, u.avatar_key, u.avatar_updated_at, r.going, a.method, a.checked_at
         FROM community_members m JOIN users u ON u.id = m.user_id
         LEFT JOIN session_rsvps r ON r.session_id = $1 AND r.user_id = m.user_id
         LEFT JOIN session_attendance a ON a.session_id = $1 AND a.user_id = m.user_id
        WHERE m.community_id = $2 AND m.status = 'active'
        ORDER BY (a.checked_at IS NULL), a.checked_at, u.display_name`,
      [sessionId, row.community_id],
    );
    return {
      sessionId,
      startsAt: row.starts_at.toISOString(),
      attendanceEnabled: hasProFeature(access.plan, 'attendance'),
      present: rows.filter((r) => r.method).length,
      going: rows.filter((r) => r.going).length,
      members: rows.map((r) => ({
        userId: r.user_id,
        displayName: r.display_name,
        avatarUrl: avatarPath({ id: r.user_id, avatar_key: r.avatar_key, avatar_updated_at: r.avatar_updated_at }),
        rsvp: r.going === null ? null : r.going ? 'going' : 'not_going',
        present: Boolean(r.method),
        method: r.method,
        checkedAt: r.checked_at?.toISOString() ?? null,
      })),
    };
  }

  /** Rekap kehadiran per anggota untuk N hari terakhir (admin). */
  async attendanceSummary(userId: string, communityId: string, days: number) {
    const access = requireStaff(await communityAccess(this.pool, communityId, userId));
    const { rows: s } = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM community_sessions WHERE community_id = $1 AND cancelled_at IS NULL
          AND starts_at <= now() AND starts_at > now() - make_interval(days => $2)`,
      [communityId, days],
    );
    const { rows } = await this.pool.query<{ user_id: string; display_name: string; attended: string; rsvp_going: string }>(
      `SELECT m.user_id, u.display_name,
              (SELECT count(*) FROM session_attendance a JOIN community_sessions s ON s.id = a.session_id
                WHERE a.user_id = m.user_id AND s.community_id = $1 AND s.starts_at > now() - make_interval(days => $2)) AS attended,
              (SELECT count(*) FROM session_rsvps r JOIN community_sessions s ON s.id = r.session_id
                WHERE r.user_id = m.user_id AND r.going AND s.community_id = $1 AND s.starts_at <= now()
                  AND s.starts_at > now() - make_interval(days => $2)) AS rsvp_going
         FROM community_members m JOIN users u ON u.id = m.user_id
        WHERE m.community_id = $1 AND m.status = 'active'
        ORDER BY 3 DESC, u.display_name`,
      [communityId, days],
    );
    return {
      days,
      sessions: Number(s[0]!.n),
      attendanceEnabled: hasProFeature(access.plan, 'attendance'),
      members: rows.map((r) => ({ userId: r.user_id, displayName: r.display_name, attended: Number(r.attended), rsvpGoing: Number(r.rsvp_going) })),
    };
  }

  // ---------- Job worker ----------

  /** Bentuk sesi dari semua jadwal aktif dan kirim pengingat. Dipanggil worker tiap 15 menit. */
  async runJobs(now = new Date()): Promise<{ created: number; reminded: number }> {
    const created = (await this.pool.query(MATERIALIZE_SQL('true'))).rowCount ?? 0;
    const { rows } = await this.pool.query<{ id: string; community_id: string; starts_at: Date; timezone: Timezone; community: string }>(
      `UPDATE community_sessions s SET reminder_sent_at = now()
         FROM communities c
        WHERE c.id = s.community_id AND c.removed_at IS NULL
          AND s.reminder_sent_at IS NULL AND s.cancelled_at IS NULL AND s.remind
          AND s.starts_at > $1 AND s.starts_at <= $1::timestamptz + make_interval(secs => $2)
        RETURNING s.id, s.community_id, s.starts_at, s.timezone, c.name AS community`,
      [now, REMINDER_BEFORE_MS / 1000],
    );
    for (const s of rows) {
      const { rows: going } = await this.pool.query<{ user_id: string }>(
        `SELECT r.user_id FROM session_rsvps r JOIN community_members m ON m.community_id = $2 AND m.user_id = r.user_id AND m.status = 'active'
          WHERE r.session_id = $1 AND r.going`,
        [s.id, s.community_id],
      );
      // Teks push tanpa judul/lokasi (bisa berisi detail tempat kumpul, #114): hanya nama komunitas dan jam.
      await this.notifications.notify(
        going.map((g) => g.user_id),
        {
          category: 'schedule',
          communityId: s.community_id,
          push: {
            title: 'Pengingat lari bareng',
            body: `Sesi lari ${s.community} mulai pukul ${clock(s.starts_at, s.timezone)}`,
            data: { type: 'session_reminder', sessionId: s.id, communityId: s.community_id },
            tag: `session:${s.id}`,
          },
        },
      );
    }
    return { created, reminded: rows.length };
  }

  // ---------- Hapus akun ----------

  async onAccountDeletion(db: Queryable, userId: string): Promise<void> {
    await db.query('DELETE FROM session_rsvps WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM session_attendance WHERE user_id = $1', [userId]);
    await db.query('UPDATE session_attendance SET marked_by = NULL WHERE marked_by = $1', [userId]);
    await db.query('UPDATE community_schedules SET created_by = NULL WHERE created_by = $1', [userId]);
    await db.query('UPDATE community_sessions SET created_by = NULL WHERE created_by = $1', [userId]);
  }

  // ---------- Bantuan ----------

  private async recordAttendance(db: Queryable, sessionId: string, userId: string, method: 'qr' | 'gps' | 'manual', markedBy: string | null) {
    const { rows } = await db.query<{ method: string; checked_at: Date; inserted: boolean }>(
      `INSERT INTO session_attendance (session_id, user_id, method, marked_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, user_id) DO UPDATE SET session_id = EXCLUDED.session_id
       RETURNING method, checked_at, (xmax = 0) AS inserted`,
      [sessionId, userId, method, markedBy],
    );
    const r = rows[0]!;
    return { present: true, method: r.method, checkedAt: r.checked_at.toISOString(), alreadyCheckedIn: !r.inserted };
  }

  private assertCheckInOpen(row: SessionRow) {
    if (row.cancelled_at) throw new ApiError(409, 'session_cancelled', 'Sesi sudah dibatalkan');
    if (!isCheckInOpen(row.starts_at)) {
      const w = checkInWindow(row.starts_at);
      throw new ApiError(409, 'checkin_closed', 'Absensi hanya dibuka 30 menit sebelum sampai 3 jam setelah sesi dimulai', {
        opensAt: w.opensAt.toISOString(),
        closesAt: w.closesAt.toISOString(),
      });
    }
  }

  private async sessionAccess(db: Queryable, userId: string, sessionId: string, lock = false): Promise<{ row: SessionRow; access: CommunityAccess }> {
    const { rows } = await db.query<SessionRow>(`SELECT ${SESSION_COLS} FROM community_sessions s WHERE s.id = $1`, [sessionId]);
    const row = rows[0];
    if (!row) throw sessionNotFound();
    let access: CommunityAccess;
    try {
      access = await communityAccess(db, row.community_id, userId, lock);
    } catch {
      throw sessionNotFound();
    }
    return { row, access };
  }

  private async sessionJson(userId: string, access: CommunityAccess, rows: SessionRow[]) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const { rows: counts } = await this.pool.query<{ session_id: string; going: string; not_going: string; mine: boolean | null; attended: boolean }>(
      `SELECT s.id AS session_id,
              (SELECT count(*) FROM session_rsvps r JOIN community_members m ON m.community_id = s.community_id AND m.user_id = r.user_id AND m.status = 'active'
                WHERE r.session_id = s.id AND r.going) AS going,
              (SELECT count(*) FROM session_rsvps r JOIN community_members m ON m.community_id = s.community_id AND m.user_id = r.user_id AND m.status = 'active'
                WHERE r.session_id = s.id AND NOT r.going) AS not_going,
              (SELECT going FROM session_rsvps r WHERE r.session_id = s.id AND r.user_id = $2) AS mine,
              EXISTS (SELECT 1 FROM session_attendance a WHERE a.session_id = s.id AND a.user_id = $2) AS attended
         FROM community_sessions s WHERE s.id = ANY($1::uuid[])`,
      [ids, userId],
    );
    const byId = new Map(counts.map((c) => [c.session_id, c]));
    const pro = hasProFeature(access.plan, 'attendance');
    return rows.map((r) => {
      const c = byId.get(r.id);
      const w = checkInWindow(r.starts_at);
      return {
        id: r.id,
        communityId: r.community_id,
        scheduleId: r.schedule_id,
        title: r.title,
        startsAt: r.starts_at.toISOString(),
        timezone: r.timezone,
        locationName: r.location_name,
        point: r.lat !== null && r.lng !== null ? { lat: r.lat, lng: r.lng } : null,
        distanceM: r.distance_m,
        paceTargetSPerKm: r.pace_target_s_per_km,
        notes: r.notes,
        remind: r.remind,
        cancelled: Boolean(r.cancelled_at),
        rsvp: { going: Number(c?.going ?? 0), notGoing: Number(c?.not_going ?? 0), mine: c?.mine === null || c?.mine === undefined ? null : c.mine ? 'going' : 'not_going' },
        attended: Boolean(c?.attended),
        checkIn: { open: pro && !r.cancelled_at && isCheckInOpen(r.starts_at), opensAt: w.opensAt.toISOString(), closesAt: w.closesAt.toISOString(), gps: r.lat !== null },
      };
    });
  }

  private async notifyMembers(actorId: string, communityId: string, inbox: { type: 'session_new'; data: Record<string, string> }, title: string) {
    const { rows } = await this.pool.query<{ user_id: string }>(
      `SELECT user_id FROM community_members WHERE community_id = $1 AND status = 'active'`,
      [communityId],
    );
    const l = await this.notifications.labels(actorId, communityId);
    await this.notifications.notify(
      rows.map((r) => r.user_id),
      {
        category: 'schedule',
        actorId,
        communityId,
        inbox,
        push: { title, body: `${l.community} punya jadwal lari baru. Ketuk untuk RSVP`, data: { type: inbox.type, communityId, ...inbox.data } },
      },
    );
  }
}

function scheduleJson(r: ScheduleRow) {
  return {
    id: r.id,
    communityId: r.community_id,
    title: r.title,
    weekday: r.weekday,
    startTime: r.start_time,
    timezone: r.timezone,
    locationName: r.location_name,
    point: r.lat !== null && r.lng !== null ? { lat: r.lat, lng: r.lng } : null,
    distanceM: r.distance_m,
    paceTargetSPerKm: r.pace_target_s_per_km,
    notes: r.notes,
    remind: r.remind,
  };
}

/** Jam setempat HH.MM di zona sesi (untuk teks push). */
export function clock(d: Date, tz: Timezone): string {
  return new Intl.DateTimeFormat('id-ID', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

function scheduleNotFound() {
  return new ApiError(404, 'schedule_not_found', 'Jadwal tidak ditemukan');
}

function sessionNotFound() {
  return new ApiError(404, 'session_not_found', 'Sesi tidak ditemukan');
}
