import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { audit } from '../admin/admin-auth.service.js';
import { type Queryable, withTx } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { PG_POOL } from '../core.module.js';
import { FieldCrypto } from '../crypto/field-crypto.js';
import { type EventCategory, type EventInput, EventsService } from '../events/events.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { ScrapedEvent } from './jsonld.js';
import { duplicateReason, type DupReason } from './normalize.js';
import type { EventSource } from './sources.js';

/** Batas kiriman event per pengguna per 24 jam (selain throttler per menit). */
export const SUBMISSION_DAILY_LIMIT = 5;
const ADMIN_PAGE = 200;

export type SubmissionStatus = 'pending' | 'approved' | 'rejected' | 'merged';

export interface UserSubmissionInput {
  name: string;
  date: string;
  startTime: string | null;
  city: string;
  venue: string;
  description: string;
  categories: EventCategory[];
  registrationUrl: string;
  /** Halaman resmi event (bawaan: tautan pendaftaran). */
  officialUrl: string | null;
  /** Nama penyelenggara, tampil sebagai sumber. */
  organizer: string;
  /** Email/HP penyelenggara untuk konfirmasi admin. Dienkripsi, tidak pernah di-log. */
  contact: string | null;
}

interface SubmissionRow {
  id: string;
  origin: 'scrape' | 'user';
  source_id: string | null;
  status: SubmissionStatus;
  name: string;
  date: string;
  start_time: string | null;
  city: string;
  venue: string;
  description: string;
  categories: EventCategory[];
  registration_url: string;
  source_name: string;
  source_url: string;
  has_contact: boolean;
  event_id: string | null;
  reject_reason: string | null;
  submitted_by: string | null;
  submitted_by_name: string | null;
  reviewed_by_name: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLS = `s.id, s.origin, s.source_id, s.status, s.name, to_char(s.event_date, 'YYYY-MM-DD') AS date, to_char(s.start_time, 'HH24:MI') AS start_time,
  s.city, s.venue, s.description, s.categories, s.registration_url, s.source_name, s.source_url,
  s.organizer_contact_enc IS NOT NULL AS has_contact, s.event_id, s.reject_reason, s.submitted_by, s.reviewed_at, s.created_at, s.updated_at`;

const contactAad = (id: string) => `event_submissions.contact:${id}`;

/**
 * Antrean event (PRD 2.4): hasil scraping dan kiriman penyelenggara menunggu di `event_submissions` dan
 * baru tayang (baris `events`) setelah disetujui super admin. Duplikat ditandai dan bisa digabung.
 */
@Injectable()
export class EventSubmissionsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly crypto: FieldCrypto,
    private readonly events: EventsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------- Scraping ----------

  /**
   * Simpan satu event hasil scraping. Idempoten per (sumber, kunci eksternal): kiriman yang masih menunggu
   * diperbarui bila datanya berubah; yang sudah disetujui/ditolak/digabung tidak disentuh.
   */
  async upsertScraped(source: Pick<EventSource, 'id' | 'name'>, e: ScrapedEvent): Promise<'created' | 'updated' | 'unchanged'> {
    const { rows } = await this.pool.query<{ inserted: boolean }>(
      `INSERT INTO event_submissions (origin, source_id, external_key, name, event_date, start_time, city, venue, description, categories,
                                      registration_url, source_name, source_url)
       VALUES ('scrape', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (source_id, external_key) WHERE origin = 'scrape' DO UPDATE SET
         name = EXCLUDED.name, event_date = EXCLUDED.event_date, start_time = EXCLUDED.start_time, city = EXCLUDED.city,
         venue = EXCLUDED.venue, description = EXCLUDED.description, categories = EXCLUDED.categories,
         registration_url = EXCLUDED.registration_url, source_name = EXCLUDED.source_name, source_url = EXCLUDED.source_url, updated_at = now()
       WHERE event_submissions.status = 'pending'
         AND (event_submissions.name, event_submissions.event_date, event_submissions.start_time, event_submissions.city, event_submissions.venue,
              event_submissions.description, event_submissions.categories, event_submissions.registration_url, event_submissions.source_name,
              event_submissions.source_url)
             IS DISTINCT FROM
             (EXCLUDED.name, EXCLUDED.event_date, EXCLUDED.start_time, EXCLUDED.city, EXCLUDED.venue, EXCLUDED.description,
              EXCLUDED.categories, EXCLUDED.registration_url, EXCLUDED.source_name, EXCLUDED.source_url)
       RETURNING (xmax = 0) AS inserted`,
      [source.id, e.externalKey, e.name, e.date, e.startTime, e.city, e.venue, e.description, e.categories, e.registrationUrl, source.name, e.sourceUrl],
    );
    if (!rows[0]) return 'unchanged';
    return rows[0].inserted ? 'created' : 'updated';
  }

  // ---------- Pengguna ----------

  /** Kirim event (pengguna Level 1). Maks. 5 per 24 jam. Tidak tayang sebelum disetujui. */
  async submit(userId: string, input: UserSubmissionInput): Promise<{ id: string; status: SubmissionStatus }> {
    return withTx(this.pool, async (db) => {
      // Kunci per pengguna agar dua kiriman bersamaan tidak sama-sama lolos batas harian.
      await db.query(`SELECT pg_advisory_xact_lock(hashtext('event_submission:' || $1::text))`, [userId]);
      const { rows: cnt } = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM event_submissions WHERE submitted_by = $1 AND created_at > now() - interval '24 hours'`,
        [userId],
      );
      if (Number(cnt[0]!.n) >= SUBMISSION_DAILY_LIMIT) {
        throw new ApiError(429, 'submission_limit', `Maksimal ${SUBMISSION_DAILY_LIMIT} kiriman event per hari. Coba lagi besok.`);
      }
      const id = randomUUID();
      await db.query(
        `INSERT INTO event_submissions (id, origin, submitted_by, name, event_date, start_time, city, venue, description, categories,
                                        registration_url, source_name, source_url, organizer_contact_enc)
         VALUES ($1, 'user', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          id,
          userId,
          input.name,
          input.date,
          input.startTime,
          input.city,
          input.venue,
          input.description,
          input.categories,
          input.registrationUrl,
          input.organizer,
          input.officialUrl ?? input.registrationUrl,
          input.contact ? this.crypto.encrypt(input.contact, contactAad(id)) : null,
        ],
      );
      return { id, status: 'pending' as const };
    });
  }

  /** "Kiriman saya": status, alasan penolakan, dan event yang tayang. Tanpa kontak. */
  async mine(userId: string) {
    const { rows } = await this.pool.query<SubmissionRow>(
      `SELECT ${COLS}, NULL AS submitted_by_name, NULL AS reviewed_by_name FROM event_submissions s
        WHERE s.submitted_by = $1 ORDER BY s.created_at DESC LIMIT 50`,
      [userId],
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        status: r.status,
        name: r.name,
        date: r.date,
        city: r.city,
        rejectReason: r.reject_reason,
        eventId: r.status === 'approved' || r.status === 'merged' ? r.event_id : null,
        createdAt: r.created_at.toISOString(),
      })),
      dailyLimit: SUBMISSION_DAILY_LIMIT,
    };
  }

  // ---------- Super admin ----------

  async adminList(status: SubmissionStatus) {
    const { rows } = await this.pool.query<SubmissionRow>(
      `SELECT ${COLS}, su.display_name AS submitted_by_name, ru.display_name AS reviewed_by_name
         FROM event_submissions s
         LEFT JOIN users su ON su.id = s.submitted_by
         LEFT JOIN users ru ON ru.id = s.reviewed_by
        WHERE s.status = $1
        ORDER BY ${status === 'pending' ? 's.event_date ASC, s.created_at ASC' : 's.reviewed_at DESC NULLS LAST'}, s.id
        LIMIT ${ADMIN_PAGE}`,
      [status],
    );
    const dups = status === 'pending' ? await this.duplicates(rows) : new Map<string, DupCandidate[]>();
    return rows.map((r) => ({ ...this.view(r), duplicates: dups.get(r.id) ?? [] }));
  }

  /** Buka kontak penyelenggara (dicatat di log tindakan, seperti membuka detail profil, #102). */
  async contact(adminId: string, id: string): Promise<{ contact: string | null }> {
    const { rows } = await this.pool.query<{ organizer_contact_enc: Buffer | null }>('SELECT organizer_contact_enc FROM event_submissions WHERE id = $1', [id]);
    if (!rows[0]) throw notFound();
    await audit(this.pool, adminId, 'event_submission.view_contact', { type: 'event_submission', id });
    const enc = rows[0].organizer_contact_enc;
    return { contact: enc ? this.crypto.decryptString(enc, contactAad(id)) : null };
  }

  /**
   * Setujui: buat event yang tayang dari kiriman (dengan koreksi super admin di [input]). Sumber dan
   * halaman resmi ikut. 409 event_exists jika nama+tanggal sudah ada (gunakan "gabung").
   */
  async approve(adminId: string, id: string, input: EventInput): Promise<{ eventId: string }> {
    const res = await withTx(this.pool, async (db) => {
      const sub = await this.lockPending(db, id);
      const eventId = await this.events.insertEvent(db, adminId, input, sub.origin);
      await db.query(
        `UPDATE event_submissions SET status = 'approved', event_id = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now() WHERE id = $1`,
        [id, eventId, adminId],
      );
      await audit(db, adminId, 'event_submission.approve', { type: 'event_submission', id }, { eventId, name: input.name, date: input.date, origin: sub.origin, source: input.sourceName });
      return { eventId, submittedBy: sub.submitted_by, name: input.name };
    });
    await this.notifyResult(res.submittedBy, 'approved', id, res.name, res.eventId);
    return { eventId: res.eventId };
  }

  async reject(adminId: string, id: string, reason: string): Promise<void> {
    const res = await withTx(this.pool, async (db) => {
      const sub = await this.lockPending(db, id);
      await db.query(
        `UPDATE event_submissions SET status = 'rejected', reject_reason = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now() WHERE id = $1`,
        [id, reason, adminId],
      );
      await audit(db, adminId, 'event_submission.reject', { type: 'event_submission', id }, { name: sub.name, origin: sub.origin, reason });
      return sub;
    });
    await this.notifyResult(res.submitted_by, 'rejected', id, res.name);
  }

  /**
   * Gabung ke event yang sudah tayang (duplikat). Kiriman ditandai `merged`; event tujuan mendapat sumber
   * dan halaman resmi dari kiriman bila belum punya. Scraping ulang tidak membuat kiriman baru.
   */
  async merge(adminId: string, id: string, eventId: string): Promise<void> {
    const res = await withTx(this.pool, async (db) => {
      const sub = await this.lockPending(db, id);
      const { rows } = await db.query<{ name: string }>(
        `UPDATE events SET source_name = COALESCE(source_name, $2), source_url = COALESCE(source_url, $3), updated_at = now()
          WHERE id = $1 AND removed_at IS NULL RETURNING name`,
        [eventId, sub.source_name, sub.source_url],
      );
      if (!rows[0]) throw new ApiError(404, 'event_not_found', 'Event tujuan tidak ditemukan');
      await db.query(
        `UPDATE event_submissions SET status = 'merged', event_id = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now() WHERE id = $1`,
        [id, eventId, adminId],
      );
      await audit(db, adminId, 'event_submission.merge', { type: 'event_submission', id }, { eventId, name: sub.name, into: rows[0].name, origin: sub.origin });
      return { submittedBy: sub.submitted_by, name: rows[0].name };
    });
    await this.notifyResult(res.submittedBy, 'approved', id, res.name, eventId);
  }

  /** Data kiriman menunggu untuk formulir setujui (dipadukan dengan koreksi admin). */
  async pendingInput(id: string): Promise<EventInput> {
    const { rows } = await this.pool.query<SubmissionRow>(
      `SELECT ${COLS}, NULL AS submitted_by_name, NULL AS reviewed_by_name FROM event_submissions s WHERE s.id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r) throw notFound();
    if (r.status !== 'pending') throw reviewed();
    return {
      name: r.name,
      date: r.date,
      startTime: r.start_time,
      city: r.city,
      venue: r.venue,
      description: r.description,
      categories: r.categories,
      registrationUrl: r.registration_url,
      sourceName: r.source_name,
      sourceUrl: r.source_url,
    };
  }

  // ---------- Bantuan ----------

  private async lockPending(db: Queryable, id: string) {
    const { rows } = await db.query<{ status: SubmissionStatus; origin: 'scrape' | 'user'; submitted_by: string | null; name: string; source_name: string; source_url: string }>(
      'SELECT status, origin, submitted_by, name, source_name, source_url FROM event_submissions WHERE id = $1 FOR UPDATE',
      [id],
    );
    const r = rows[0];
    if (!r) throw notFound();
    if (r.status !== 'pending') throw reviewed();
    return r;
  }

  /** Kandidat duplikat per kiriman: event tayang (tidak diturunkan) dan kiriman menunggu lain. */
  private async duplicates(rows: SubmissionRow[]): Promise<Map<string, DupCandidate[]>> {
    const out = new Map<string, DupCandidate[]>();
    if (!rows.length) return out;
    const dates = rows.map((r) => r.date).sort();
    const { rows: evs } = await this.pool.query<{ id: string; name: string; date: string; city: string; registration_url: string; source_url: string | null }>(
      `SELECT id, name, to_char(event_date, 'YYYY-MM-DD') AS date, city, registration_url, source_url FROM events
        WHERE removed_at IS NULL AND event_date BETWEEN $1::date - 31 AND $2::date + 31 LIMIT 5000`,
      [dates[0], dates.at(-1)],
    );
    for (const r of rows) {
      const me = { name: r.name, date: r.date, city: r.city, registrationUrl: r.registration_url, sourceUrl: r.source_url };
      const found: DupCandidate[] = [];
      for (const e of evs) {
        const reason = duplicateReason(me, { name: e.name, date: e.date, city: e.city, registrationUrl: e.registration_url, sourceUrl: e.source_url });
        if (reason) found.push({ kind: 'event', id: e.id, name: e.name, date: e.date, city: e.city, reason });
      }
      for (const o of rows) {
        if (o.id === r.id) continue;
        const reason = duplicateReason(me, { name: o.name, date: o.date, city: o.city, registrationUrl: o.registration_url, sourceUrl: o.source_url });
        if (reason) found.push({ kind: 'submission', id: o.id, name: o.name, date: o.date, city: o.city, reason });
      }
      if (found.length) out.set(r.id, found.slice(0, 10));
    }
    return out;
  }

  private view(r: SubmissionRow) {
    return {
      id: r.id,
      origin: r.origin,
      sourceId: r.source_id,
      status: r.status,
      name: r.name,
      date: r.date,
      startTime: r.start_time,
      city: r.city,
      venue: r.venue,
      description: r.description,
      categories: r.categories,
      registrationUrl: r.registration_url,
      sourceName: r.source_name,
      sourceUrl: r.source_url,
      hasContact: r.has_contact,
      eventId: r.event_id,
      rejectReason: r.reject_reason,
      submittedBy: r.submitted_by ? { id: r.submitted_by, displayName: r.submitted_by_name } : null,
      reviewedBy: r.reviewed_by_name,
      reviewedAt: r.reviewed_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  }

  /** Notifikasi ke pengirim (kiriman pengguna saja). Isi hanya nama event dan id. */
  private async notifyResult(userId: string | null, result: 'approved' | 'rejected', submissionId: string, name: string, eventId?: string) {
    if (!userId) return;
    const approved = result === 'approved';
    const data: Record<string, string> = { submissionId, ...(eventId ? { eventId } : {}) };
    await this.notifications.notify([userId], {
      category: 'event',
      inbox: { type: approved ? 'event_submission_approved' : 'event_submission_rejected', data },
      push: {
        title: approved ? 'Event kirimanmu tayang' : 'Kiriman event ditolak',
        body: approved ? `${name} sudah ada di kalender event` : `${name}: lihat alasannya di Kiriman saya`,
        data: { type: approved ? 'event_submission_approved' : 'event_submission_rejected', ...data },
      },
    });
  }
}

export interface DupCandidate {
  kind: 'event' | 'submission';
  id: string;
  name: string;
  date: string;
  city: string;
  reason: DupReason;
}

function notFound() {
  return new ApiError(404, 'submission_not_found', 'Kiriman event tidak ditemukan');
}

function reviewed() {
  return new ApiError(409, 'submission_reviewed', 'Kiriman ini sudah ditinjau');
}
