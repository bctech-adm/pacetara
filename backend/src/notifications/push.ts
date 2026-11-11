import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { JWT } from 'google-auth-library';
import type pg from 'pg';
import { ENV, type Env } from '../config/env.js';
import type { FieldCrypto } from '../crypto/field-crypto.js';
import { PUSH_JOB, QUEUES } from '../worker/queues.js';

/** Satu kiriman push ke beberapa pengguna. Isi hanya judul/teks singkat dan id; tidak pernah isi chat. */
export interface PushJob {
  userIds: string[];
  title: string;
  body: string;
  /** Untuk navigasi saat notifikasi diketuk (mis. type, conversationId). Hanya id, tanpa data pribadi. */
  data: Record<string, string>;
  /** Notifikasi dengan tag sama saling menggantikan (mis. satu per percakapan). */
  tag?: string;
}

export const pushTokenAad = (id: string) => `push_tokens.token:${id}`;
export const hashPushToken = (token: string) => createHash('sha256').update(token).digest();

/** Antrean push di sisi API. Pengiriman ke FCM dilakukan worker (`sendPushJob`). */
@Injectable()
export class PushQueue implements OnModuleDestroy {
  private queue?: Queue;

  constructor(@Inject(ENV) private readonly env: Env) {}

  async enqueue(job: PushJob): Promise<void> {
    if (job.userIds.length === 0) return;
    this.queue ??= new Queue(QUEUES.notifications, { connection: { url: this.env.REDIS_URL, maxRetriesPerRequest: null } });
    await this.queue.add(PUSH_JOB, job, { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 100, removeOnFail: 200 });
  }

  async onModuleDestroy() {
    await this.queue?.close();
  }
}

export interface PushSender {
  readonly enabled: boolean;
  /** @returns 'ok' | 'invalid_token' (token harus dihapus) | 'error' (coba lagi nanti) */
  send(token: string, job: PushJob): Promise<'ok' | 'invalid_token' | 'error'>;
}

/**
 * Firebase Cloud Messaging HTTP v1. Kredensial: akun layanan Firebase (JSON, base64) di
 * FCM_SERVICE_ACCOUNT_B64. Kosong = push mati (notifikasi di aplikasi tetap berjalan).
 */
export class FcmSender implements PushSender {
  private readonly logger = new Logger('FCM');
  private readonly client?: JWT;
  private readonly projectId?: string;

  constructor(serviceAccountB64: string, private readonly fetchFn: typeof fetch = fetch) {
    if (!serviceAccountB64) return;
    try {
      const sa = JSON.parse(Buffer.from(serviceAccountB64, 'base64').toString('utf8')) as {
        project_id?: string;
        client_email?: string;
        private_key?: string;
      };
      if (!sa.project_id || !sa.client_email || !sa.private_key) throw new Error('field kurang');
      this.projectId = sa.project_id;
      this.client = new JWT({ email: sa.client_email, key: sa.private_key, scopes: ['https://www.googleapis.com/auth/firebase.messaging'] });
    } catch {
      this.logger.error('FCM_SERVICE_ACCOUNT_B64 tidak valid; push dimatikan');
    }
  }

  get enabled(): boolean {
    return Boolean(this.client);
  }

  async send(token: string, job: PushJob): Promise<'ok' | 'invalid_token' | 'error'> {
    if (!this.client || !this.projectId) return 'error';
    const { token: accessToken } = await this.client.getAccessToken();
    const res = await this.fetchFn(`https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(fcmMessage(token, job)),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return 'ok';
    const body = (await res.json().catch(() => ({}))) as { error?: { status?: string } };
    if (res.status === 404 || body.error?.status === 'UNREGISTERED' || (res.status === 400 && body.error?.status === 'INVALID_ARGUMENT')) {
      return 'invalid_token';
    }
    // Status saja; token dan isi tidak pernah di-log.
    this.logger.warn(`FCM menjawab ${res.status} ${body.error?.status ?? ''}`);
    return 'error';
  }
}

export function fcmMessage(token: string, job: PushJob) {
  return {
    message: {
      token,
      notification: { title: job.title, body: job.body },
      data: job.data,
      android: { priority: 'HIGH', ...(job.tag ? { notification: { tag: job.tag } } : {}) },
    },
  };
}

/**
 * Prosesor worker: kirim satu job ke semua perangkat penerima. Token yang ditolak FCM (aplikasi
 * dihapus, token kedaluwarsa) dihapus. Melempar galat jika ada kegagalan sementara agar BullMQ mencoba lagi
 * (hanya untuk token yang gagal).
 */
export async function sendPushJob(pool: Pick<pg.Pool, 'query'>, crypto: FieldCrypto, sender: PushSender, job: PushJob) {
  if (!sender.enabled) return { sent: 0, skipped: true };
  const { rows } = await pool.query<{ id: string; token_enc: Buffer }>('SELECT id, token_enc FROM push_tokens WHERE user_id = ANY($1::uuid[])', [
    job.userIds,
  ]);
  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    const token = crypto.decryptString(r.token_enc, pushTokenAad(r.id));
    const outcome = await sender.send(token, job).catch(() => 'error' as const);
    if (outcome === 'ok') sent++;
    else if (outcome === 'invalid_token') await pool.query('DELETE FROM push_tokens WHERE id = $1', [r.id]);
    else failed++;
  }
  if (failed > 0 && sent === 0) throw new Error(`Push gagal ke ${failed} perangkat`);
  return { sent, failed };
}
