import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import type { Queryable } from '../common/db.js';
import { PG_POOL } from '../core.module.js';
import { FieldCrypto } from '../crypto/field-crypto.js';

export interface UserRow {
  id: string;
  email_enc: Buffer | null;
  email_verified_at: Date | null;
  phone_enc: Buffer | null;
  phone_verified_at: Date | null;
  password_hash: string | null;
  google_sub: string | null;
  display_name: string;
  avatar_key: string | null;
  avatar_updated_at: Date | null;
  city: string | null;
  avg_pace_sec_per_km: number | null;
  verification_level: number;
  role: 'user' | 'super_admin';
  plan: 'free' | 'premium';
  privacy_radius_m: number;
  status: 'active' | 'suspended' | 'banned' | 'deleted';
  suspended_until: Date | null;
  created_at: Date;
}

/** Profil milik sendiri (GET /v1/me). Email dan HP didekripsi hanya untuk pemiliknya. */
export interface MyProfile {
  id: string;
  displayName: string;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
  hasPassword: boolean;
  googleLinked: boolean;
  avatarUrl: string | null;
  city: string | null;
  avgPaceSecPerKm: number | null;
  verificationLevel: number;
  plan: 'free' | 'premium';
  /** Radius zona privasi rute lari (meter). */
  privacyRadiusM: number;
  badges: string[];
  createdAt: string;
}

const COLUMNS = `id, email_enc, email_verified_at, phone_enc, phone_verified_at, password_hash, google_sub,
  display_name, avatar_key, avatar_updated_at, city, avg_pace_sec_per_km, verification_level, role, plan, privacy_radius_m, status, suspended_until, created_at`;

export const emailAad = (id: string) => `users.email:${id}`;
export const phoneAad = (id: string) => `users.phone:${id}`;

@Injectable()
export class UsersRepository {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly crypto: FieldCrypto,
  ) {}

  async findById(id: string, db: Queryable = this.pool, lock = false): Promise<UserRow | undefined> {
    const { rows } = await db.query<UserRow>(
      `SELECT ${COLUMNS} FROM users WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0];
  }

  async findByEmail(email: string, db: Queryable = this.pool): Promise<UserRow | undefined> {
    const { rows } = await db.query<UserRow>(`SELECT ${COLUMNS} FROM users WHERE email_bidx = $1`, [
      this.crypto.blindIndex('email', email),
    ]);
    return rows[0];
  }

  async findByGoogleSub(sub: string, db: Queryable = this.pool): Promise<UserRow | undefined> {
    const { rows } = await db.query<UserRow>(`SELECT ${COLUMNS} FROM users WHERE google_sub = $1`, [sub]);
    return rows[0];
  }

  async phoneTakenByOther(phone: string, userId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM users WHERE phone_bidx = $1 AND id <> $2', [
      this.crypto.blindIndex('phone', phone),
      userId,
    ]);
    return (rowCount ?? 0) > 0;
  }

  async create(
    db: Queryable,
    input: {
      id: string;
      email: string;
      emailVerified: boolean;
      passwordHash?: string;
      googleSub?: string;
      displayName: string;
      privacyVersion: string;
    },
  ): Promise<UserRow> {
    const { rows } = await db.query<UserRow>(
      `INSERT INTO users (id, email_enc, email_bidx, email_verified_at, password_hash, google_sub, display_name,
                          privacy_accepted_at, privacy_version)
       VALUES ($1, $2, $3, CASE WHEN $4 THEN now() END, $5, $6, $7, now(), $8)
       RETURNING ${COLUMNS}`,
      [
        input.id,
        this.crypto.encrypt(input.email.trim(), emailAad(input.id)),
        this.crypto.blindIndex('email', input.email),
        input.emailVerified,
        input.passwordHash ?? null,
        input.googleSub ?? null,
        input.displayName,
        input.privacyVersion,
      ],
    );
    return rows[0]!;
  }

  decryptEmail(row: Pick<UserRow, 'id' | 'email_enc'>): string | null {
    return row.email_enc ? this.crypto.decryptString(row.email_enc, emailAad(row.id)) : null;
  }

  decryptPhone(row: Pick<UserRow, 'id' | 'phone_enc'>): string | null {
    return row.phone_enc ? this.crypto.decryptString(row.phone_enc, phoneAad(row.id)) : null;
  }

  toMyProfile(row: UserRow): MyProfile {
    return {
      id: row.id,
      displayName: row.display_name,
      email: this.decryptEmail(row),
      emailVerified: row.email_verified_at !== null,
      phone: this.decryptPhone(row),
      phoneVerified: row.phone_verified_at !== null,
      hasPassword: row.password_hash !== null,
      googleLinked: row.google_sub !== null,
      avatarUrl: avatarPath(row),
      city: row.city,
      avgPaceSecPerKm: row.avg_pace_sec_per_km,
      verificationLevel: row.verification_level,
      plan: row.plan,
      privacyRadiusM: row.privacy_radius_m,
      // Terverifikasi = Level 2 (modul 3.1). Paket diubah hanya oleh server (modul 2.5).
      badges: [...(row.plan === 'premium' ? ['premium'] : []), ...(row.verification_level >= 2 ? ['verified'] : [])],
      createdAt: row.created_at.toISOString(),
    };
  }
}

/** Path relatif ke API (bukan URL S3). `v` mencegah cache lama setelah foto diganti. */
export function avatarPath(row: Pick<UserRow, 'id' | 'avatar_key' | 'avatar_updated_at'>): string | null {
  if (!row.avatar_key) return null;
  return `/v1/users/${row.id}/avatar?v=${row.avatar_updated_at?.getTime() ?? 0}`;
}
