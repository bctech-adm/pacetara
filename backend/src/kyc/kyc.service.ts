import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import sharp from 'sharp';
import { audit } from '../admin/admin-auth.service.js';
import { type Queryable, withTx } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { ENV, type Env } from '../config/env.js';
import { PG_POOL } from '../core.module.js';
import { FieldCrypto } from '../crypto/field-crypto.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { MAX_UPLOAD_BYTES } from '../storage/image.js';
import { KycEngine } from './kyc-engine.js';
import { ageFromNik, decide, type KycThresholds, parseNik, REASON_TEXT } from './ktp.js';

/** Percobaan verifikasi per pengguna per 24 jam (semua hasil dihitung; dihitung di database di bawah advisory lock). */
export const KYC_ATTEMPTS_PER_DAY = 5;
export const MIN_AGE = 17;
const IMAGE_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif']);

interface AttemptRow {
  id: string;
  status: 'approved' | 'review' | 'rejected' | 'retry' | 'expired' | 'revoked';
  auto: boolean;
  reasons: string[];
  review_note: string | null;
  created_at: Date;
  reviewed_at: Date | null;
}

/**
 * Verifikasi Level 2 (modul 3.1): KTP + selfie → OCR NIK/nama + pencocokan wajah di memori (KycEngine), lalu
 * lolos otomatis, ulangi (kualitas foto), atau masuk antrean tinjauan manual super admin. Foto tidak pernah
 * disimpan atau di-log; yang disimpan hanya status, NIK sebagai HMAC berkunci, dan skor tanpa data pribadi.
 */
@Injectable()
export class KycService {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(ENV) private readonly env: Env,
    private readonly crypto: FieldCrypto,
    private readonly engine: KycEngine,
    private readonly notifications: NotificationsService,
  ) {}

  private get thresholds(): KycThresholds {
    return { facePass: this.env.KYC_FACE_PASS, faceReject: this.env.KYC_FACE_REJECT, livenessMin: this.env.KYC_LIVENESS_MIN, nameMin: 0.85, ocrMin: 55 };
  }

  async status(userId: string) {
    const { rows: u } = await this.pool.query<{ verification_level: number; kyc_verified_at: Date | null }>(
      'SELECT verification_level, kyc_verified_at FROM users WHERE id = $1',
      [userId],
    );
    const { rows } = await this.pool.query<AttemptRow>(
      `SELECT id, status, auto, reasons, review_note, created_at, reviewed_at FROM kyc_attempts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    const used = await this.attemptsToday(this.pool, userId);
    const last = rows[0];
    return {
      enabled: this.engine.enabled,
      level: u[0]?.verification_level ?? 0,
      verified: (u[0]?.verification_level ?? 0) >= 2,
      verifiedAt: u[0]?.kyc_verified_at?.toISOString() ?? null,
      consentVersion: this.env.KYC_CONSENT_VERSION,
      attemptsLeft: Math.max(0, KYC_ATTEMPTS_PER_DAY - used),
      last: last ? attemptJson(last) : null,
    };
  }

  /**
   * Satu percobaan verifikasi. [ktp] dan [selfie] hanya dipegang di memori dan diisi nol setelah dianalisis.
   */
  async submit(userId: string, input: { nik: string; name: string; consentVersion: string }, ktp: Buffer, selfie: Buffer) {
    try {
      if (!this.engine.enabled) throw new ApiError(503, 'not_configured', 'Verifikasi KTP belum tersedia');
      if (input.consentVersion !== this.env.KYC_CONSENT_VERSION) {
        throw new ApiError(428, 'consent_outdated', 'Naskah persetujuan verifikasi sudah diperbarui. Baca dan setujui lagi');
      }
      const nikInfo = parseNik(input.nik);
      if (!nikInfo) throw new ApiError(400, 'invalid_nik', 'NIK tidak valid. Periksa 16 digit NIK di KTP-mu');
      if (ageFromNik(nikInfo) < MIN_AGE) throw new ApiError(403, 'underage', REASON_TEXT.underage);
      await this.assertImage(ktp);
      await this.assertImage(selfie);

      // Prasyarat dicek sebelum mesin dijalankan (CPU berat): Level 1, belum Level 2, tidak ada tinjauan, kuota.
      await withTx(this.pool, async (db) => this.precheck(db, userId));

      const analysis = await this.engine.analyze(ktp, selfie);
      const d = decide({ nik: input.nik, name: input.name }, analysis, this.thresholds);
      const scores = {
        face: analysis.faceSimilarity,
        real: analysis.selfieReal,
        live: analysis.selfieLive,
        ocr: analysis.ocr.confidence,
        name: d.nameScore,
      };
      const nikHmac = this.crypto.blindIndex('nik', input.nik);

      const result = await withTx(this.pool, async (db) => {
        await this.precheck(db, userId);
        if (d.outcome === 'retry') {
          await this.insertAttempt(db, userId, 'retry', d.reasons, scores);
          return { status: 'retry' as const, reasons: d.reasons, messages: d.reasons.map((r) => REASON_TEXT[r]) };
        }
        // NIK yang sudah dipakai akun lain: tidak masuk antrean (unik per orang), pengguna menghubungi tim.
        const { rows: taken } = await db.query('SELECT 1 FROM users WHERE nik_hmac = $1 AND id <> $2', [nikHmac, userId]);
        if (taken[0]) {
          await this.insertAttempt(db, userId, 'retry', ['nik_in_use'], scores);
          return { status: 'nik_in_use' as const };
        }
        if (d.outcome === 'approved') {
          await db.query('UPDATE users SET verification_level = 2, nik_hmac = $2, kyc_verified_at = now() WHERE id = $1', [userId, nikHmac]);
          await this.insertAttempt(db, userId, 'approved', [], scores);
          return { status: 'approved' as const, reasons: [], messages: [] };
        }
        const id = await this.insertAttempt(db, userId, 'review', d.reasons, scores, nikHmac);
        const reviewData = JSON.stringify({ ocrName: analysis.ocr.name ?? '', enteredName: input.name });
        await db.query('UPDATE kyc_attempts SET review_data_enc = $2 WHERE id = $1', [id, this.crypto.encrypt(reviewData, `kyc_attempts.review:${id}`)]);
        return { status: 'review' as const, reasons: d.reasons, messages: d.reasons.map((r) => REASON_TEXT[r]) };
      }).catch((err: unknown) => {
        // Dua akun menyetujui NIK yang sama bersamaan: indeks unik users.nik_hmac menolak yang kedua.
        if ((err as { code?: string }).code === '23505') return { status: 'nik_in_use' as const };
        throw err;
      });
      if (result.status === 'nik_in_use') throw new ApiError(409, 'nik_in_use', REASON_TEXT.nik_in_use);
      return result;
    } finally {
      ktp.fill(0);
      selfie.fill(0);
    }
  }

  // ---------- Panel super admin ----------

  async adminList(status: 'review' | 'approved' | 'rejected' | 'retry' | 'expired' | 'revoked') {
    const { rows } = await this.pool.query<
      AttemptRow & { user_id: string; display_name: string; face_score: number | null; selfie_real: number | null; selfie_live: number | null; ocr_confidence: number | null; name_score: number | null; reviewer: string | null }
    >(
      `SELECT a.id, a.status, a.auto, a.reasons, a.review_note, a.created_at, a.reviewed_at, a.user_id, u.display_name,
              a.face_score, a.selfie_real, a.selfie_live, a.ocr_confidence, a.name_score, r.display_name AS reviewer
         FROM kyc_attempts a JOIN users u ON u.id = a.user_id LEFT JOIN users r ON r.id = a.reviewed_by
        WHERE a.status = $1 ORDER BY a.created_at ${status === 'review' ? 'ASC' : 'DESC'} LIMIT 200`,
      [status],
    );
    return {
      items: rows.map((r) => ({
        ...attemptJson(r),
        userId: r.user_id,
        user: r.display_name,
        reviewer: r.reviewer,
        scores: { face: r.face_score, selfieReal: r.selfie_real, selfieLive: r.selfie_live, ocr: r.ocr_confidence, name: r.name_score },
      })),
      thresholds: this.thresholds,
    };
  }

  /** Detail tinjauan: nama hasil OCR vs ketikan. Setiap pembukaan tercatat (kyc.view). */
  async adminDetail(adminId: string, attemptId: string) {
    const { rows } = await this.pool.query<{ status: string; review_data_enc: Buffer | null; user_id: string }>(
      'SELECT status, review_data_enc, user_id FROM kyc_attempts WHERE id = $1',
      [attemptId],
    );
    const r = rows[0];
    if (!r) throw attemptNotFound();
    await audit(this.pool, adminId, 'kyc.view', { type: 'kyc', id: attemptId }, { userId: r.user_id });
    const data = r.review_data_enc
      ? (JSON.parse(this.crypto.decryptString(r.review_data_enc, `kyc_attempts.review:${attemptId}`)) as { ocrName: string; enteredName: string })
      : null;
    return { id: attemptId, status: r.status, names: data };
  }

  async approve(adminId: string, attemptId: string, note: string | undefined) {
    const userId = await withTx(this.pool, async (db) => {
      const a = await this.reviewForUpdate(db, attemptId);
      const { rows: taken } = await db.query('SELECT 1 FROM users WHERE nik_hmac = $1 AND id <> $2', [a.nik_hmac, a.user_id]);
      if (taken[0]) throw new ApiError(409, 'nik_in_use', 'NIK ini sudah dipakai akun lain; tolak tinjauan ini');
      const { rows: u } = await db.query<{ status: string; verification_level: number }>(
        'SELECT status, verification_level FROM users WHERE id = $1 FOR UPDATE',
        [a.user_id],
      );
      if (!u[0] || u[0].status !== 'active' || u[0].verification_level < 1) throw new ApiError(409, 'user_not_eligible', 'Akun tidak aktif atau belum Level 1');
      await db.query('UPDATE users SET verification_level = 2, nik_hmac = $2, kyc_verified_at = now() WHERE id = $1', [a.user_id, a.nik_hmac]);
      await db.query(
        `UPDATE kyc_attempts SET status = 'approved', auto = false, nik_hmac = NULL, review_data_enc = NULL, review_note = $3,
                reviewed_by = $2, reviewed_at = now() WHERE id = $1`,
        [attemptId, adminId, note ?? null],
      );
      await audit(db, adminId, 'kyc.approve', { type: 'user', id: a.user_id }, { attemptId, reasons: a.reasons, note: note ?? null });
      return a.user_id;
    });
    await this.notifications.notify([userId], {
      category: 'account',
      inbox: { type: 'kyc_approved', data: {} },
      push: { title: 'Verifikasi KTP disetujui', body: 'Akunmu sekarang Terverifikasi (Level 2)', data: { type: 'kyc_approved' } },
    });
    return { id: attemptId, status: 'approved' };
  }

  async reject(adminId: string, attemptId: string, reason: string): Promise<void> {
    const userId = await withTx(this.pool, async (db) => {
      const a = await this.reviewForUpdate(db, attemptId);
      await db.query(
        `UPDATE kyc_attempts SET status = 'rejected', auto = false, nik_hmac = NULL, review_data_enc = NULL, review_note = $3,
                reviewed_by = $2, reviewed_at = now() WHERE id = $1`,
        [attemptId, adminId, reason],
      );
      await audit(db, adminId, 'kyc.reject', { type: 'user', id: a.user_id }, { attemptId, reasons: a.reasons, reason });
      return a.user_id;
    });
    await this.notifications.notify([userId], {
      category: 'account',
      inbox: { type: 'kyc_rejected', data: {} },
      push: { title: 'Verifikasi KTP belum disetujui', body: 'Lihat alasannya dan coba lagi di aplikasi', data: { type: 'kyc_rejected' } },
    });
  }

  /** Cabut Level 2 (mis. terbukti memakai KTP orang lain). NIK HMAC dihapus dari akun. */
  async revoke(adminId: string, userId: string, reason: string): Promise<void> {
    await withTx(this.pool, async (db) => {
      const { rows } = await db.query<{ verification_level: number; role: string }>(
        'SELECT verification_level, role FROM users WHERE id = $1 FOR UPDATE',
        [userId],
      );
      if (!rows[0] || rows[0].verification_level < 2) throw new ApiError(409, 'not_verified', 'Akun ini bukan Level 2');
      // Trigger users_compute_level menghitung ulang Level 0/1 dari email + HP saat level diturunkan.
      await db.query('UPDATE users SET verification_level = 1, nik_hmac = NULL, kyc_verified_at = NULL WHERE id = $1', [userId]);
      await db.query(
        `UPDATE kyc_attempts SET status = 'revoked', review_note = $3, reviewed_by = $2, reviewed_at = now()
          WHERE id = (SELECT id FROM kyc_attempts WHERE user_id = $1 AND status = 'approved' ORDER BY created_at DESC LIMIT 1)`,
        [userId, adminId, reason],
      );
      await audit(db, adminId, 'kyc.revoke', { type: 'user', id: userId }, { reason });
    });
    await this.notifications.notify([userId], {
      category: 'account',
      inbox: { type: 'kyc_revoked', data: {} },
      push: { title: 'Status Terverifikasi dicabut', body: 'Lihat keterangannya di aplikasi', data: { type: 'kyc_revoked' } },
    });
  }

  /** Hapus akun: semua catatan percobaan dihapus (nik_hmac di users dikosongkan oleh UsersService). */
  async onAccountDeletion(db: Queryable, userId: string): Promise<void> {
    await db.query('DELETE FROM kyc_attempts WHERE user_id = $1', [userId]);
    await db.query('UPDATE kyc_attempts SET reviewed_by = NULL WHERE reviewed_by = $1', [userId]);
  }

  private async precheck(db: Queryable, userId: string) {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`kyc:${userId}`]);
    const { rows } = await db.query<{ verification_level: number; status: string }>('SELECT verification_level, status FROM users WHERE id = $1', [userId]);
    const u = rows[0];
    if (!u || u.status !== 'active') throw new ApiError(401, 'unauthorized', 'Perlu login');
    if (u.verification_level >= 2) throw new ApiError(409, 'already_verified', 'Akunmu sudah Terverifikasi');
    if (u.verification_level < 1) {
      throw new ApiError(403, 'verification_required', 'Verifikasi email dan nomor HP dulu sebelum verifikasi KTP', { requiredLevel: 1 });
    }
    const { rows: pending } = await db.query(`SELECT 1 FROM kyc_attempts WHERE user_id = $1 AND status = 'review'`, [userId]);
    if (pending[0]) throw new ApiError(409, 'kyc_in_review', 'Verifikasimu sedang ditinjau tim PaceTara');
    if ((await this.attemptsToday(db, userId)) >= KYC_ATTEMPTS_PER_DAY) {
      throw new ApiError(429, 'kyc_limit', `Maksimal ${KYC_ATTEMPTS_PER_DAY} percobaan verifikasi per hari. Coba lagi besok`);
    }
  }

  private async attemptsToday(db: Queryable, userId: string): Promise<number> {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM kyc_attempts WHERE user_id = $1 AND created_at > now() - interval '24 hours'`,
      [userId],
    );
    return Number(rows[0]!.n);
  }

  private async insertAttempt(
    db: Queryable,
    userId: string,
    status: 'approved' | 'review' | 'retry',
    reasons: string[],
    s: { face: number | null; real: number | null; live: number | null; ocr: number; name: number | null },
    nikHmac: Buffer | null = null,
  ): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO kyc_attempts (user_id, status, reasons, face_score, selfie_real, selfie_live, ocr_confidence, name_score, consent_version, nik_hmac)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [userId, status, reasons, s.face, s.real, s.live, s.ocr, s.name, this.env.KYC_CONSENT_VERSION, nikHmac],
    );
    return rows[0]!.id;
  }

  private async reviewForUpdate(db: Queryable, attemptId: string) {
    const { rows } = await db.query<{ status: string; user_id: string; nik_hmac: Buffer | null; reasons: string[] }>(
      'SELECT status, user_id, nik_hmac, reasons FROM kyc_attempts WHERE id = $1 FOR UPDATE',
      [attemptId],
    );
    const a = rows[0];
    if (!a) throw attemptNotFound();
    if (a.status !== 'review') throw new ApiError(409, 'kyc_reviewed', 'Tinjauan ini sudah diputuskan');
    return a;
  }

  /** Jenis dari isi berkas (magic bytes lewat sharp), ukuran, dan dimensi; tanpa menulis ke disk. */
  private async assertImage(buf: Buffer) {
    if (buf.length === 0 || buf.length > MAX_UPLOAD_BYTES) throw new ApiError(413, 'file_too_large', 'Ukuran foto maksimal 8 MB');
    let format: string | undefined;
    let pixels = 0;
    try {
      const meta = await sharp(buf, { limitInputPixels: 50_000_000 }).metadata();
      format = meta.format;
      pixels = (meta.width ?? 0) * (meta.height ?? 0);
    } catch {
      format = undefined;
    }
    if (!format || !IMAGE_FORMATS.has(format)) throw new ApiError(415, 'unsupported_image', 'Berkas bukan gambar yang didukung (JPG, PNG, WebP, HEIC)');
    if (pixels < 300 * 300) throw new ApiError(422, 'image_too_small', 'Resolusi foto terlalu kecil. Pakai kamera belakang/depan biasa');
  }
}

function attemptJson(r: AttemptRow) {
  return {
    id: r.id,
    status: r.status,
    auto: r.auto,
    reasons: r.reasons,
    messages: r.reasons.map((x) => REASON_TEXT[x as keyof typeof REASON_TEXT] ?? x),
    note: r.review_note,
    createdAt: r.created_at.toISOString(),
    reviewedAt: r.reviewed_at?.toISOString() ?? null,
  };
}

function attemptNotFound() {
  return new ApiError(404, 'kyc_not_found', 'Data verifikasi tidak ditemukan');
}
