import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { type Queryable, withTx } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { ENV, type Env } from '../config/env.js';
import { PG_POOL, REDIS } from '../core.module.js';
import { FieldCrypto } from '../crypto/field-crypto.js';
import { BadgesService } from '../passport/badges.service.js';
import { deleteRuns } from '../runs/dedup.js';
import type { Point } from '../runs/geo.js';
import type { RunVisibility } from '../runs/runs.service.js';
import { StorageService } from '../storage/storage.service.js';
import { garminEnabled, redirectUri, stravaEnabled } from './config.js';
import { GarminClient, garminToImported, type OAuthTokens, validGarminCallbackUrl } from './garmin.js';
import { ImportQueue } from './import-queue.js';
import { ImportWriter } from './import-writer.js';
import { ProviderHttp, ProviderHttpError } from './provider-http.js';
import { StravaClient, stravaToImported, validStravaId } from './strava.js';
import type { ImportJob, ImportResult, ImportSource, OAuthProvider } from './types.js';

const STATE_TTL_S = 600;
const SYNC_COOLDOWN_S = 300;
/** Sinkron Strava menarik paling jauh 30 hari ke belakang, maks. 30 aktivitas per putaran (batas laju API Strava). */
const STRAVA_SYNC_DAYS = 30;
const MAX_WEBHOOK_ITEMS = 500;
const OWN_PACKAGE = 'tech.bimacreative.pacetara';
const STRAVA_PACKAGE = 'com.strava';

const stateKey = (s: string) => `oauth:state:${s}`;
const tokenAad = (userId: string, provider: OAuthProvider, kind: 'access' | 'refresh') => `import_connections.${kind}:${userId}:${provider}`;
const jobAad = (userId: string) => `imports.job:${userId}`;
const sha = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 40);

export const PROVIDER_PATHS = { garmin: 'garmin', strava: 'strava', 'health-connect': 'health_connect' } as const;
export type ProviderPath = keyof typeof PROVIDER_PATHS;

export interface HealthConnectSession {
  externalId: string;
  originPackage: string;
  title: string;
  visibility: RunVisibility;
  startedAt: Date;
  endedAt: Date;
  distanceM: number | null;
  /** [lat, lng, detik sejak mulai, ketinggian | null] */
  route: Point[];
}

interface ConnectionRow {
  user_id: string;
  access_token_enc: Buffer;
  refresh_token_enc: Buffer | null;
  token_expires_at: Date | null;
}

export interface CallbackOutcome {
  ok: boolean;
  title: string;
  message: string;
}

/**
 * Impor data lari (modul 2.3): koneksi OAuth Garmin/Strava, webhook, impor Health Connect dari HP,
 * dan pengolahan job di worker. Token penyedia disimpan terenkripsi FieldCrypto dan tidak pernah di-log.
 */
@Injectable()
export class ImportsService {
  private readonly logger = new Logger('Imports');
  readonly garmin: GarminClient;
  readonly strava: StravaClient;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly crypto: FieldCrypto,
    http: ProviderHttp,
    private readonly writer: ImportWriter,
    private readonly queue: ImportQueue,
    private readonly storage: StorageService,
    private readonly badges: BadgesService,
  ) {
    this.garmin = new GarminClient(http, env.GARMIN_CLIENT_ID, env.GARMIN_CLIENT_SECRET);
    this.strava = new StravaClient(http, env.STRAVA_CLIENT_ID, env.STRAVA_CLIENT_SECRET);
  }

  enabled(provider: OAuthProvider): boolean {
    return provider === 'garmin' ? garminEnabled(this.env) : stravaEnabled(this.env);
  }

  private requireEnabled(provider: OAuthProvider) {
    if (!this.enabled(provider)) throw new ApiError(503, 'not_configured', `Impor dari ${provider === 'garmin' ? 'Garmin' : 'Strava'} belum tersedia`);
  }

  // ---------- Status dan koneksi ----------

  async status(userId: string) {
    const { rows } = await this.pool.query<{ provider: OAuthProvider; connected_at: Date; last_sync_at: Date | null }>(
      'SELECT provider, connected_at, last_sync_at FROM import_connections WHERE user_id = $1',
      [userId],
    );
    const { rows: counts } = await this.pool.query<{ source: string; n: string }>(
      `SELECT source, count(*) AS n FROM runs WHERE user_id = $1 AND source <> 'app' GROUP BY source`,
      [userId],
    );
    const runs = (s: string) => Number(counts.find((c) => c.source === s)?.n ?? 0);
    const conn = (p: OAuthProvider) => {
      const r = rows.find((x) => x.provider === p);
      return {
        enabled: this.enabled(p),
        connected: Boolean(r),
        connectedAt: r?.connected_at.toISOString() ?? null,
        lastSyncAt: r?.last_sync_at?.toISOString() ?? null,
        runs: runs(p),
      };
    };
    return {
      healthConnect: { enabled: true, runs: runs('health_connect') },
      garmin: conn('garmin'),
      strava: { ...conn('strava'), webhook: Boolean(this.env.STRAVA_WEBHOOK_VERIFY_TOKEN) },
    };
  }

  /** Mulai OAuth: `state` acak terikat pengguna (Redis, 10 menit, sekali pakai). URL dibuka aplikasi di browser luar. */
  async connect(userId: string, provider: OAuthProvider): Promise<{ url: string }> {
    this.requireEnabled(provider);
    if (provider === 'garmin') {
      const { rows } = await this.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM import_connections WHERE provider = 'garmin' AND user_id <> $1`,
        [userId],
      );
      if (Number(rows[0]!.n) >= this.env.GARMIN_MAX_USERS) {
        throw new ApiError(409, 'provider_full', 'Kuota pengguna Garmin PaceTara sedang penuh. Coba lagi nanti atau pakai Health Connect');
      }
    }
    const state = randomBytes(32).toString('base64url');
    const verifier = provider === 'garmin' ? randomBytes(48).toString('base64url') : undefined;
    await this.redis.set(stateKey(state), JSON.stringify({ u: userId, p: provider, v: verifier }), 'EX', STATE_TTL_S);
    const redirect = redirectUri(this.env, provider);
    const url =
      provider === 'garmin'
        ? this.garmin.authorizeUrl({ state, codeChallenge: createHash('sha256').update(verifier!).digest('base64url'), redirectUri: redirect })
        : this.strava.authorizeUrl({ state, redirectUri: redirect });
    return { url };
  }

  /** Callback OAuth dari browser. Tidak pernah melempar: hasilnya halaman HTML sederhana. */
  async callback(provider: OAuthProvider, q: Record<string, unknown>): Promise<CallbackOutcome> {
    const fail = (message: string): CallbackOutcome => ({ ok: false, title: 'Gagal menghubungkan', message });
    if (!this.enabled(provider)) return fail('Fitur ini belum tersedia.');
    const state = typeof q.state === 'string' && q.state.length <= 100 ? q.state : '';
    if (!state) return fail('Tautan tidak valid. Ulangi dari aplikasi PaceTara.');
    // GETDEL: state hanya bisa dipakai sekali.
    const raw = await this.redis.getdel(stateKey(state));
    if (!raw) return fail('Tautan sudah kedaluwarsa atau sudah dipakai. Ulangi dari aplikasi PaceTara.');
    const saved = JSON.parse(raw) as { u: string; p: OAuthProvider; v?: string };
    if (saved.p !== provider) return fail('Tautan tidak valid. Ulangi dari aplikasi PaceTara.');
    if (typeof q.error === 'string') return { ok: false, title: 'Dibatalkan', message: 'Izin tidak diberikan. Kamu bisa mencoba lagi kapan saja dari aplikasi.' };
    const code = typeof q.code === 'string' && q.code.length <= 1024 ? q.code : '';
    if (!code) return fail('Kode otorisasi tidak ada. Ulangi dari aplikasi PaceTara.');
    const { rows: u } = await this.pool.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [saved.u]);
    if (u[0]?.status !== 'active') return fail('Akun tidak aktif.');

    let tokens: OAuthTokens;
    let externalId: string;
    try {
      if (provider === 'garmin') {
        tokens = await this.garmin.exchangeCode({ code, codeVerifier: saved.v ?? '', redirectUri: redirectUri(this.env, 'garmin') });
        externalId = await this.garmin.userId(tokens.accessToken);
      } else {
        const scope = typeof q.scope === 'string' ? q.scope.split(/[ ,]/) : [];
        if (!scope.includes('activity:read_all') && !scope.includes('activity:read')) {
          return fail('Izin membaca aktivitas tidak diberikan. Ulangi dan centang izin aktivitas.');
        }
        const t = await this.strava.exchangeCode(code);
        tokens = t;
        externalId = t.athleteId;
      }
    } catch (err) {
      this.logger.warn(`OAuth ${provider} gagal: ${err instanceof Error ? err.message : 'unknown'}`);
      return fail('Penyedia menolak permintaan. Coba lagi beberapa saat lagi.');
    }
    await this.saveConnection(saved.u, provider, externalId, tokens);
    if (provider === 'strava') await this.queue.enqueue({ kind: 'strava-sync', userId: saved.u }).catch(() => undefined);
    return {
      ok: true,
      title: 'Berhasil terhubung',
      message:
        provider === 'garmin'
          ? 'Akun Garmin terhubung. Lari baru dari Garmin akan masuk otomatis ke PaceTara. Silakan kembali ke aplikasi.'
          : 'Akun Strava terhubung. Lari 30 hari terakhir sedang diimpor sebagai riwayat pribadi. Silakan kembali ke aplikasi.',
    };
  }

  private async saveConnection(userId: string, provider: OAuthProvider, externalId: string, t: OAuthTokens) {
    const hmac = this.crypto.blindIndex(provider === 'garmin' ? 'garmin_user' : 'strava_athlete', externalId);
    await withTx(this.pool, async (db) => {
      // Akun penyedia yang sama hanya terhubung ke satu akun PaceTara: koneksi lama dipindahkan.
      await db.query('DELETE FROM import_connections WHERE provider = $1 AND external_user_hmac = $2 AND user_id <> $3', [provider, hmac, userId]);
      await db.query(
        `INSERT INTO import_connections (user_id, provider, external_user_hmac, access_token_enc, refresh_token_enc, token_expires_at, scope)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, provider) DO UPDATE SET external_user_hmac = EXCLUDED.external_user_hmac,
           access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc,
           token_expires_at = EXCLUDED.token_expires_at, scope = EXCLUDED.scope, connected_at = now(), last_sync_at = NULL`,
        [
          userId,
          provider,
          hmac,
          this.crypto.encrypt(t.accessToken, tokenAad(userId, provider, 'access')),
          t.refreshToken ? this.crypto.encrypt(t.refreshToken, tokenAad(userId, provider, 'refresh')) : null,
          t.expiresAt,
          t.scope,
        ],
      );
    });
  }

  /** Token akses yang masih berlaku (diperbarui otomatis). null = tidak terhubung atau izin sudah dicabut. */
  async accessToken(userId: string, provider: OAuthProvider): Promise<string | null> {
    return withTx(this.pool, async (db) => {
      const { rows } = await db.query<ConnectionRow>(
        `SELECT user_id, access_token_enc, refresh_token_enc, token_expires_at FROM import_connections
          WHERE user_id = $1 AND provider = $2 FOR UPDATE`,
        [userId, provider],
      );
      const r = rows[0];
      if (!r) return null;
      if (!r.token_expires_at || r.token_expires_at.getTime() > Date.now() + 5 * 60_000) {
        return this.crypto.decryptString(r.access_token_enc, tokenAad(userId, provider, 'access'));
      }
      if (!r.refresh_token_enc) return null;
      const refresh = this.crypto.decryptString(r.refresh_token_enc, tokenAad(userId, provider, 'refresh'));
      let t: OAuthTokens;
      try {
        t = provider === 'garmin' ? await this.garmin.refresh(refresh) : await this.strava.refresh(refresh);
      } catch (err) {
        if (err instanceof ProviderHttpError && (err.status === 400 || err.status === 401)) {
          // Izin dicabut di sisi penyedia: koneksi dihapus.
          await db.query('DELETE FROM import_connections WHERE user_id = $1 AND provider = $2', [userId, provider]);
          this.logger.log(`Koneksi ${provider} dihapus karena token penyegar ditolak`);
          return null;
        }
        throw err;
      }
      await db.query(
        `UPDATE import_connections SET access_token_enc = $3, refresh_token_enc = COALESCE($4, refresh_token_enc), token_expires_at = $5
          WHERE user_id = $1 AND provider = $2`,
        [
          userId,
          provider,
          this.crypto.encrypt(t.accessToken, tokenAad(userId, provider, 'access')),
          t.refreshToken ? this.crypto.encrypt(t.refreshToken, tokenAad(userId, provider, 'refresh')) : null,
          t.expiresAt,
        ],
      );
      return t.accessToken;
    });
  }

  /** Putuskan sambungan: token dihapus dan izin dicabut di penyedia. Opsional: hapus semua lari dari sumber itu. */
  async disconnect(userId: string, path: ProviderPath, opts: { deleteRuns: boolean }) {
    const source = PROVIDER_PATHS[path];
    if (source === 'garmin' || source === 'strava') {
      const { rows } = await this.pool.query<ConnectionRow>(
        'DELETE FROM import_connections WHERE user_id = $1 AND provider = $2 RETURNING user_id, access_token_enc, refresh_token_enc, token_expires_at',
        [userId, source],
      );
      if (rows[0]) await this.revoke(source, this.crypto.decryptString(rows[0].access_token_enc, tokenAad(userId, source, 'access')));
    }
    let deletedRuns = 0;
    if (opts.deleteRuns) {
      const keys = await withTx(this.pool, async (db) => {
        const { rows } = await db.query<{ id: string }>('SELECT id FROM runs WHERE user_id = $1 AND source = $2', [userId, source]);
        deletedRuns = rows.length;
        const k = await deleteRuns(
          db,
          rows.map((r) => r.id),
        );
        await db.query('DELETE FROM import_records WHERE user_id = $1 AND source = $2', [userId, source]);
        return k;
      });
      for (const k of keys) await this.storage.delete(k).catch(() => undefined);
    }
    return { deletedRuns };
  }

  private async revoke(provider: OAuthProvider, accessToken: string) {
    try {
      if (provider === 'garmin') await this.garmin.deregister(accessToken);
      else await this.strava.deauthorize(accessToken);
    } catch (err) {
      // Token bisa sudah kedaluwarsa; koneksi di sisi kita tetap terhapus.
      this.logger.warn(`Gagal mencabut izin ${provider}: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  async requestStravaSync(userId: string): Promise<void> {
    this.requireEnabled('strava');
    const { rows } = await this.pool.query('SELECT 1 FROM import_connections WHERE user_id = $1 AND provider = $2', [userId, 'strava']);
    if (!rows[0]) throw new ApiError(404, 'not_connected', 'Strava belum terhubung');
    const ok = await this.redis.set(`imports:sync:${userId}`, '1', 'EX', SYNC_COOLDOWN_S, 'NX');
    if (!ok) throw new ApiError(429, 'sync_rate_limited', 'Sinkronisasi baru saja dijalankan. Coba lagi beberapa menit lagi');
    await this.queue.enqueue({ kind: 'strava-sync', userId });
  }

  // ---------- Health Connect (dibaca di HP, dikirim satu sesi per permintaan) ----------

  async importHealthConnect(userId: string, s: HealthConnectSession): Promise<ImportResult> {
    if (s.originPackage === OWN_PACKAGE) return { status: 'skipped', runId: null, reason: 'own_app' };
    // Lari Strava yang masuk Health Connect diperlakukan sebagai lari Strava: hanya riwayat pribadi (PRD 2.3).
    const fromStrava = s.originPackage === STRAVA_PACKAGE;
    const source: ImportSource = fromStrava ? 'strava' : 'health_connect';
    return this.writer.importRun(
      userId,
      {
        source,
        externalId: fromStrava ? `hc:${s.externalId}` : s.externalId,
        title: s.title || (fromStrava ? 'Lari dari Strava' : 'Lari dari Health Connect'),
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        segments: s.route.length >= 2 ? [s.route] : [],
        reported: { distanceM: s.distanceM, movingTimeS: null, elevationGainM: null },
        visibility: fromStrava ? 'private' : s.visibility,
      },
      { allowReimport: true },
    );
  }

  /** Sesi Health Connect yang sudah tersimpan (atau sudah dikenali sebagai duplikat), agar tidak ditawarkan lagi. */
  async knownHealthConnect(userId: string, ids: string[]): Promise<{ known: string[] }> {
    const keys = [...ids, ...ids.map((i) => `hc:${i}`)];
    const { rows } = await this.pool.query<{ external_id: string }>(
      `SELECT ir.external_id FROM import_records ir
        WHERE ir.user_id = $1 AND ir.source IN ('health_connect', 'strava') AND ir.external_id = ANY($2::text[])
          AND (ir.status IN ('duplicate', 'skipped') OR ir.run_id IS NOT NULL)`,
      [userId, keys],
    );
    return { known: [...new Set(rows.map((r) => r.external_id.replace(/^hc:/, '')))] };
  }

  // ---------- Webhook Garmin ----------

  /**
   * Notifikasi Garmin. Keaslian: (1) kunci acak di alamat endpoint (GARMIN_PUSH_KEY, dicek di controller),
   * (2) hanya userId milik koneksi terdaftar yang diproses, (3) notifikasi ping tidak membawa data:
   * datanya ditarik dari callbackURL yang wajib https://apis.garmin.com/wellness-api/rest/... dengan token pengguna.
   * Respons selalu cepat; pengolahan di worker.
   */
  async garminPush(body: unknown): Promise<{ accepted: number; ignored: number; rejected: number }> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_input', 'Format notifikasi tidak dikenal');
    const out = { accepted: 0, ignored: 0, rejected: 0 };
    const inline = new Map<string, unknown[]>();
    const lookups = new Map<string, string | null>();
    const owner = async (garminUserId: unknown) => {
      if (typeof garminUserId !== 'string' || !garminUserId || garminUserId.length > 128) return null;
      if (!lookups.has(garminUserId)) lookups.set(garminUserId, await this.ownerOf('garmin', garminUserId));
      return lookups.get(garminUserId)!;
    };
    const b = body as Record<string, unknown>;
    for (const key of ['activities', 'activityDetails', 'manuallyUpdatedActivities']) {
      const items = b[key];
      if (items === undefined) continue;
      if (!Array.isArray(items) || items.length > MAX_WEBHOOK_ITEMS) throw new ApiError(400, 'invalid_input', 'Format notifikasi tidak dikenal');
      for (const item of items as Record<string, unknown>[]) {
        const userId = await owner(item?.userId);
        if (!userId) {
          out.ignored++;
          continue;
        }
        if (item.callbackURL !== undefined) {
          const url = validGarminCallbackUrl(item.callbackURL);
          if (!url) {
            out.rejected++;
            continue;
          }
          await this.queue.enqueue({ kind: 'garmin-pull', userId, callbackUrl: url }, `garmin-pull-${sha(url)}`);
        } else {
          const list = inline.get(userId) ?? [];
          list.push(item);
          inline.set(userId, list);
        }
        out.accepted++;
      }
    }
    for (const [userId, items] of inline) {
      const payload = this.crypto.encrypt(JSON.stringify(items), jobAad(userId)).toString('base64');
      await this.queue.enqueue({ kind: 'garmin-push', userId, payload });
    }
    const dereg = b.deregistrations;
    if (Array.isArray(dereg) && dereg.length <= MAX_WEBHOOK_ITEMS) {
      for (const item of dereg as Record<string, unknown>[]) {
        const userId = await owner(item?.userId);
        if (userId) await this.queue.enqueue({ kind: 'garmin-deregister', userId });
      }
    }
    return out;
  }

  garminKeyMatches(key: string): boolean {
    const expected = Buffer.from(this.env.GARMIN_PUSH_KEY);
    const given = Buffer.from(key);
    return expected.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
  }

  // ---------- Webhook Strava ----------

  /** Validasi langganan webhook (GET dari Strava saat langganan dibuat). */
  stravaVerify(q: Record<string, unknown>): { 'hub.challenge': string } {
    if (!this.enabled('strava') || !this.env.STRAVA_WEBHOOK_VERIFY_TOKEN) throw new ApiError(503, 'not_configured', 'Webhook Strava belum aktif');
    const token = typeof q['hub.verify_token'] === 'string' ? q['hub.verify_token'] : '';
    const challenge = typeof q['hub.challenge'] === 'string' ? q['hub.challenge'] : '';
    const expected = Buffer.from(this.env.STRAVA_WEBHOOK_VERIFY_TOKEN);
    const given = Buffer.from(token);
    const ok = q['hub.mode'] === 'subscribe' && given.length === expected.length && timingSafeEqual(given, expected);
    if (!ok || !challenge || challenge.length > 200) throw new ApiError(403, 'forbidden', 'Verifikasi ditolak');
    return { 'hub.challenge': challenge };
  }

  /**
   * Event webhook Strava. Strava tidak menandatangani event, jadi isi event tidak dipercaya:
   * hanya id-nya yang dipakai, untuk koneksi terdaftar dan langganan yang benar; datanya selalu ditarik
   * ulang dari API Strava dengan token pengguna (di worker).
   */
  async stravaEvent(body: {
    object_type: 'activity' | 'athlete';
    object_id: number;
    aspect_type: 'create' | 'update' | 'delete';
    owner_id: number;
    subscription_id: number;
    updates?: Record<string, unknown>;
  }): Promise<{ accepted: boolean }> {
    if (!this.enabled('strava') || !this.env.STRAVA_WEBHOOK_VERIFY_TOKEN) throw new ApiError(503, 'not_configured', 'Webhook Strava belum aktif');
    if (this.env.STRAVA_WEBHOOK_SUBSCRIPTION_ID && String(body.subscription_id) !== this.env.STRAVA_WEBHOOK_SUBSCRIPTION_ID) {
      throw new ApiError(403, 'forbidden', 'Langganan tidak dikenal');
    }
    const athlete = validStravaId(body.owner_id);
    const objectId = validStravaId(body.object_id);
    if (!athlete || !objectId) return { accepted: false };
    const userId = await this.ownerOf('strava', athlete);
    if (!userId) return { accepted: false };
    if (body.object_type === 'activity') {
      await this.queue.enqueue({ kind: 'strava-activity', userId, activityId: objectId, aspect: body.aspect_type }, `strava-${body.aspect_type}-${objectId}`);
      return { accepted: true };
    }
    if (body.object_type === 'athlete' && String(body.updates?.authorized) === 'false') {
      await this.queue.enqueue({ kind: 'strava-deauth', userId });
      return { accepted: true };
    }
    return { accepted: false };
  }

  private async ownerOf(provider: OAuthProvider, externalId: string): Promise<string | null> {
    const hmac = this.crypto.blindIndex(provider === 'garmin' ? 'garmin_user' : 'strava_athlete', externalId);
    const { rows } = await this.pool.query<{ user_id: string }>(
      `SELECT c.user_id FROM import_connections c JOIN users u ON u.id = c.user_id
        WHERE c.provider = $1 AND c.external_user_hmac = $2 AND u.status = 'active'`,
      [provider, hmac],
    );
    return rows[0]?.user_id ?? null;
  }

  // ---------- Worker ----------

  async process(job: ImportJob): Promise<Record<string, unknown>> {
    switch (job.kind) {
      case 'garmin-pull': {
        const token = await this.accessToken(job.userId, 'garmin');
        if (!token) return { skipped: 'not_connected' };
        return this.importGarminItems(job.userId, await this.garmin.pull(job.callbackUrl, token));
      }
      case 'garmin-push': {
        const items = JSON.parse(this.crypto.decryptString(Buffer.from(job.payload, 'base64'), jobAad(job.userId))) as unknown[];
        const { rows } = await this.pool.query('SELECT 1 FROM import_connections WHERE user_id = $1 AND provider = $2', [job.userId, 'garmin']);
        if (!rows[0]) return { skipped: 'not_connected' };
        return this.importGarminItems(job.userId, items);
      }
      case 'garmin-deregister':
        // Pengguna mencabut izin dari Garmin Connect: hapus token (tanpa memanggil Garmin lagi).
        await this.pool.query('DELETE FROM import_connections WHERE user_id = $1 AND provider = $2', [job.userId, 'garmin']);
        return { deregistered: true };
      case 'strava-activity':
        return this.stravaActivity(job.userId, job.activityId, job.aspect);
      case 'strava-deauth': {
        const token = await this.accessToken(job.userId, 'strava');
        if (!token) return { disconnected: true };
        try {
          await this.strava.athlete(token);
          // Token masih diterima Strava: event palsu atau sudah tersambung ulang. Abaikan.
          return { disconnected: false };
        } catch (err) {
          if (err instanceof ProviderHttpError && err.status === 401) {
            await this.pool.query('DELETE FROM import_connections WHERE user_id = $1 AND provider = $2', [job.userId, 'strava']);
            return { disconnected: true };
          }
          throw err;
        }
      }
      case 'strava-sync':
        return this.stravaSync(job.userId);
    }
  }

  private async importGarminItems(userId: string, items: unknown[]) {
    const counts: Record<string, number> = {};
    for (const item of items.slice(0, MAX_WEBHOOK_ITEMS)) {
      const run = garminToImported(item);
      if (!run) {
        counts.not_run = (counts.not_run ?? 0) + 1;
        continue;
      }
      const r = await this.writer.importRun(userId, run);
      counts[r.status] = (counts[r.status] ?? 0) + 1;
    }
    await this.pool.query('UPDATE import_connections SET last_sync_at = now() WHERE user_id = $1 AND provider = $2', [userId, 'garmin']);
    return counts;
  }

  private async stravaActivity(userId: string, activityId: string, aspect: 'create' | 'update' | 'delete') {
    if (aspect === 'delete') {
      // Pemilik menghapus aktivitas di Strava: salinannya di PaceTara ikut dihapus.
      const keys = await withTx(this.pool, async (db) => {
        const { rows } = await db.query<{ run_id: string | null; status: string }>(
          `DELETE FROM import_records WHERE user_id = $1 AND source = 'strava' AND external_id = $2 RETURNING run_id, status`,
          [userId, activityId],
        );
        const own = rows.filter((r) => r.status === 'imported' && r.run_id).map((r) => r.run_id!);
        return deleteRuns(db, own);
      });
      for (const k of keys) await this.storage.delete(k).catch(() => undefined);
      return { deleted: true };
    }
    const token = await this.accessToken(userId, 'strava');
    if (!token) return { skipped: 'not_connected' };
    const activity = await this.strava.activity(token, activityId);
    const preview = stravaToImported(activity);
    if (!preview) return { skipped: 'not_run' };
    const run = stravaToImported(activity, await this.strava.streams(token, activityId));
    const r = await this.writer.importRun(userId, run!);
    await this.pool.query('UPDATE import_connections SET last_sync_at = now() WHERE user_id = $1 AND provider = $2', [userId, 'strava']);
    return { status: r.status };
  }

  private async stravaSync(userId: string) {
    const token = await this.accessToken(userId, 'strava');
    if (!token) return { skipped: 'not_connected' };
    const { rows } = await this.pool.query<{ last_sync_at: Date | null }>(
      'SELECT last_sync_at FROM import_connections WHERE user_id = $1 AND provider = $2',
      [userId, 'strava'],
    );
    const floor = Date.now() - STRAVA_SYNC_DAYS * 86_400_000;
    const last = rows[0]?.last_sync_at?.getTime() ?? 0;
    const after = Math.max(floor, last - 86_400_000) / 1000;
    const counts: Record<string, number> = {};
    for (const a of await this.strava.listActivities(token, after)) {
      const preview = stravaToImported(a);
      if (!preview) continue;
      const run = stravaToImported(a, await this.strava.streams(token, preview.externalId));
      const r = await this.writer.importRun(userId, run!, { skipBadges: true });
      counts[r.status] = (counts[r.status] ?? 0) + 1;
    }
    await this.pool.query('UPDATE import_connections SET last_sync_at = now() WHERE user_id = $1 AND provider = $2', [userId, 'strava']);
    if (counts.imported) await this.badges.evaluate(userId, { notify: true });
    return counts;
  }

  // ---------- Hapus akun ----------

  /** Dalam transaksi hapus akun: koneksi dan catatan impor dihapus. Mengembalikan token untuk dicabut setelah commit. */
  async onAccountDeletion(db: Queryable, userId: string): Promise<{ provider: OAuthProvider; token: string }[]> {
    const { rows } = await db.query<{ provider: OAuthProvider; access_token_enc: Buffer }>(
      'DELETE FROM import_connections WHERE user_id = $1 RETURNING provider, access_token_enc',
      [userId],
    );
    await db.query('DELETE FROM import_records WHERE user_id = $1', [userId]);
    return rows.map((r) => ({ provider: r.provider, token: this.crypto.decryptString(r.access_token_enc, tokenAad(userId, r.provider, 'access')) }));
  }

  async revokeAll(tokens: { provider: OAuthProvider; token: string }[]): Promise<void> {
    for (const t of tokens) await this.revoke(t.provider, t.token);
  }
}
