import { Inject, Injectable, Logger } from '@nestjs/common';
import type pg from 'pg';
import { WhatsAppOtp } from '../auth/channels.js';
import { type Queryable, withTx } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { PG_POOL } from '../core.module.js';
import { FieldCrypto } from '../crypto/field-crypto.js';

export const MAX_EMERGENCY_CONTACTS = 3;
/** Batas SOS: cegah penyalahgunaan nomor WhatsApp pengirim, tetapi tetap longgar untuk keadaan darurat sungguhan. */
export const SOS_PER_10_MIN = 3;
export const SOS_PER_DAY = 10;

const nameAad = (id: string) => `emergency_contacts.name:${id}`;
const phoneAad = (id: string) => `emergency_contacts.phone:${id}`;

export interface SosInput {
  lat: number;
  lng: number;
  accuracyM?: number;
}

/**
 * Mode aman (PRD 1.10): kontak darurat dan tombol SOS. Server mengirim lokasi ke kontak lewat WhatsApp;
 * aplikasi selalu menawarkan SMS dari HP sebagai cadangan (tanpa server, tanpa internet).
 * Lokasi tidak disimpan dan tidak di-log; hanya jumlah kontak dan yang terkirim.
 */
@Injectable()
export class SafetyService {
  private readonly logger = new Logger('Safety');

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly crypto: FieldCrypto,
    private readonly whatsapp: WhatsAppOtp,
  ) {}

  async contacts(userId: string) {
    const { rows } = await this.pool.query<{ id: string; name_enc: Buffer; phone_enc: Buffer }>(
      'SELECT id, name_enc, phone_enc FROM emergency_contacts WHERE user_id = $1 ORDER BY created_at',
      [userId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: this.crypto.decryptString(r.name_enc, nameAad(r.id)),
      phone: this.crypto.decryptString(r.phone_enc, phoneAad(r.id)),
    }));
  }

  /** [phone] sudah dinormalisasi E.164 (+62…). */
  async addContact(userId: string, name: string, phone: string) {
    const bidx = this.crypto.blindIndex('phone', phone);
    const id = await withTx(this.pool, async (db) => {
      await db.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const { rows: count } = await db.query<{ n: string }>('SELECT count(*) AS n FROM emergency_contacts WHERE user_id = $1', [userId]);
      if (Number(count[0]!.n) >= MAX_EMERGENCY_CONTACTS) {
        throw new ApiError(409, 'contacts_full', `Maksimal ${MAX_EMERGENCY_CONTACTS} kontak darurat`);
      }
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO emergency_contacts (user_id, name_enc, phone_enc, phone_bidx) VALUES ($1, '\\x00', '\\x00', $2)
         ON CONFLICT (user_id, phone_bidx) DO NOTHING RETURNING id`,
        [userId, bidx],
      );
      if (!rows[0]) throw new ApiError(409, 'contact_exists', 'Nomor ini sudah ada di kontak daruratmu');
      const newId = rows[0].id;
      await db.query('UPDATE emergency_contacts SET name_enc = $2, phone_enc = $3 WHERE id = $1', [
        newId,
        this.crypto.encrypt(name, nameAad(newId)),
        this.crypto.encrypt(phone, phoneAad(newId)),
      ]);
      return newId;
    });
    return { id, name, phone };
  }

  async removeContact(userId: string, id: string): Promise<void> {
    await this.pool.query('DELETE FROM emergency_contacts WHERE id = $1 AND user_id = $2', [id, userId]);
  }

  /** Kirim SOS ke semua kontak darurat lewat WhatsApp. Mengembalikan status per kontak. */
  async trigger(userId: string, input: SosInput) {
    const contacts = await this.contacts(userId);
    if (contacts.length === 0) throw new ApiError(409, 'no_contacts', 'Tambahkan kontak darurat dulu');
    const { rows } = await this.pool.query<{ recent: string; today: string; name: string }>(
      `SELECT (SELECT count(*) FROM sos_alerts WHERE user_id = $1 AND created_at > now() - interval '10 minutes') AS recent,
              (SELECT count(*) FROM sos_alerts WHERE user_id = $1 AND created_at > now() - interval '1 day') AS today,
              (SELECT display_name FROM users WHERE id = $1) AS name`,
      [userId],
    );
    const r = rows[0]!;
    if (Number(r.recent) >= SOS_PER_10_MIN || Number(r.today) >= SOS_PER_DAY) {
      // Tetap jawab dengan daftar kontak agar aplikasi bisa memakai SMS.
      throw new ApiError(429, 'sos_rate_limited', 'SOS baru saja dikirim. Gunakan SMS atau telepon langsung', { contacts });
    }

    const at = new Date();
    const results = await Promise.all(
      contacts.map(async (c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        delivered: await this.whatsapp.sendSos(c.phone, { name: r.name, lat: input.lat, lng: input.lng, accuracyM: input.accuracyM, at }),
      })),
    );
    const delivered = results.filter((x) => x.delivered).length;
    await this.pool.query('INSERT INTO sos_alerts (user_id, contacts, delivered) VALUES ($1, $2, $3)', [userId, contacts.length, delivered]);
    // Tanpa lokasi, nama, atau nomor.
    this.logger.warn(`SOS dipicu: ${delivered}/${contacts.length} terkirim lewat WhatsApp`);
    return { delivered, results };
  }

  /** Hapus akun: kontak darurat dan catatan SOS dihapus. */
  async onAccountDeletion(db: Queryable, userId: string): Promise<void> {
    await db.query('DELETE FROM emergency_contacts WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM sos_alerts WHERE user_id = $1', [userId]);
  }
}
