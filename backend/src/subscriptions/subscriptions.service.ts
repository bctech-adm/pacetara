import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { z } from 'zod';
import { audit } from '../admin/admin-auth.service.js';
import { type Queryable, withTx } from '../common/db.js';
import { ApiError } from '../common/http.js';
import { ENV, type Env } from '../config/env.js';
import { PG_POOL, REDIS } from '../core.module.js';
import { FieldCrypto } from '../crypto/field-crypto.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { COMMUNITY_MEMBER_LIMIT, type CommunityPlan, limitInfo, type UserPlan } from '../plans/plans.js';
import {
  isEntitled,
  kindOfProduct,
  playEnabled,
  productIds,
  PURCHASE_TOKEN_RE,
  rtdnEnabled,
  shortState,
  type SubscriptionKind,
} from './config.js';
import { PubSubOidcVerifier } from './oidc.js';
import { PlayApi, PlayApiError, type SubscriptionPurchaseV2 } from './play-api.js';
import { type SubscriptionJob, SubscriptionQueue } from './subscription-queue.js';

const tokenAad = (id: string) => `play_subscriptions.token:${id}`;
const JOB_AAD = 'play_job';
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Notifikasi langganan Google (subscriptionNotification.notificationType). */
const SUBSCRIPTION_REVOKED = 12;

interface SubRow {
  id: string;
  token_enc: Buffer | null;
  product_id: string;
  kind: SubscriptionKind;
  user_id: string | null;
  community_id: string | null;
  state: string;
  expires_at: Date | null;
  auto_renewing: boolean;
  acknowledged: boolean;
  test_purchase: boolean;
  order_id: string | null;
  revoked_at: Date | null;
  replaced_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const SUB_COLS = `id, token_enc, product_id, kind, user_id, community_id, state, expires_at, auto_renewing, acknowledged,
  test_purchase, order_id, revoked_at, replaced_by, created_at, updated_at`;

const RtdnBody = z.object({
  message: z.object({
    data: z.string().max(65_536).regex(/^[A-Za-z0-9+/=_-]*$/),
    messageId: z.string().min(1).max(200),
    message_id: z.string().optional(),
    publishTime: z.string().optional(),
    attributes: z.record(z.string(), z.string()).optional(),
  }),
  subscription: z.string().max(500).optional(),
});

const Notification = z.object({
  packageName: z.string(),
  subscriptionNotification: z.object({ notificationType: z.number().int(), purchaseToken: z.string() }).optional(),
  voidedPurchaseNotification: z.object({ purchaseToken: z.string(), productType: z.number().int().optional() }).optional(),
  testNotification: z.unknown().optional(),
});

type PlanChange = { kind: 'user' | 'community'; id: string; from: string; to: string };

export type RtdnOutcome = 'queued' | 'duplicate' | 'ignored';

/**
 * Langganan Google Play (PRD 2.5). Aturan inti:
 * - Status (users.plan / communities.plan) hanya diubah server, dihitung ulang dari play_subscriptions + plan_grants
 *   (fungsi SQL compute_*_plan), setelah status pembelian diambil langsung dari Google Play Developer API.
 * - Satu purchaseToken terikat ke satu akun (dan satu komunitas untuk Pro); obfuscatedExternalAccountId yang diset
 *   aplikasi saat membeli wajib cocok dengan HMAC (akun[, komunitas]) yang dihitung server.
 * - Isi RTDN tidak dipercaya: hanya dipakai untuk tahu token mana yang perlu disinkronkan ulang.
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger('Subscriptions');

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly crypto: FieldCrypto,
    private readonly play: PlayApi,
    private readonly oidc: PubSubOidcVerifier,
    private readonly queue: SubscriptionQueue,
    private readonly notifications: NotificationsService,
  ) {}

  /** Pengumpul perubahan paket dari recompute() di dalam planTx(). */
  private readonly planChanges = new AsyncLocalStorage<PlanChange[]>();

  /**
   * Transaksi yang bisa mengubah paket: perubahan dicatat oleh recompute() lalu diberitahukan SETELAH commit
   * (transaksi yang batal tidak memicu notifikasi).
   */
  private async planTx<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
    const changes: PlanChange[] = [];
    const result = await this.planChanges.run(changes, () => withTx(this.pool, fn));
    await this.notifyPlanChanges(changes);
    return result;
  }

  get enabled(): boolean {
    return playEnabled(this.env);
  }

  /**
   * obfuscatedExternalAccountId: HMAC berkunci (opaque, 43 karakter, tanpa data pribadi). Premium terikat ke akun;
   * Pro dan Pro Unlimited terikat ke akun + komunitas (lingkup sama agar upgrade Pro → Unlimited tetap cocok).
   */
  accountRef(kind: SubscriptionKind, userId: string, communityId?: string | null): string {
    const scope = kind === 'premium' ? `premium:${userId}` : `pro:${userId}:${communityId ?? ''}`;
    return this.crypto.blindIndex('play_account', scope).toString('base64url');
  }

  // ---------- Pengguna ----------

  async status(userId: string) {
    const { rows: me } = await this.pool.query<{ plan: UserPlan }>('SELECT plan FROM users WHERE id = $1', [userId]);
    const subs = await this.pool.query<SubRow>(
      `SELECT ${SUB_COLS} FROM play_subscriptions WHERE user_id = $1 AND replaced_by IS NULL ORDER BY created_at DESC`,
      [userId],
    );
    const { rows: grants } = await this.pool.query<{ user_id: string | null; community_id: string | null; plan: string; expires_at: Date }>(
      `SELECT user_id, community_id, plan, expires_at FROM plan_grants
        WHERE revoked_at IS NULL AND expires_at > now()
          AND (user_id = $1 OR community_id IN (SELECT id FROM communities WHERE owner_id = $1))`,
      [userId],
    );
    // Komunitas yang saya miliki, plus komunitas yang langganannya saya bayar (mis. setelah menyerahkan kepemilikan).
    const { rows: comms } = await this.pool.query<{ id: string; name: string; plan: CommunityPlan; member_count: number; owner_id: string }>(
      `SELECT c.id, c.name, c.plan, c.member_count, c.owner_id FROM communities c
        WHERE c.removed_at IS NULL
          AND (c.owner_id = $1 OR c.id IN (SELECT community_id FROM play_subscriptions WHERE user_id = $1 AND community_id IS NOT NULL AND replaced_by IS NULL))
        ORDER BY c.name`,
      [userId],
    );
    const premiumSub = subs.rows.find((s) => s.kind === 'premium' && this.relevant(s));
    const premiumGrant = grants.find((g) => g.user_id === userId);
    return {
      enabled: this.enabled,
      products: { premium: this.env.PLAY_PRODUCT_PREMIUM, pro: this.env.PLAY_PRODUCT_PRO, proUnlimited: this.env.PLAY_PRODUCT_PRO_UNLIMITED },
      premium: {
        plan: me[0]?.plan ?? 'free',
        subscription: premiumSub ? this.subView(premiumSub, userId) : null,
        grantExpiresAt: premiumGrant?.expires_at.toISOString() ?? null,
      },
      communities: comms.map((c) => {
        const sub = subs.rows.filter((s) => s.community_id === c.id && this.relevant(s)).sort((a, b) => rank(b) - rank(a))[0];
        const grant = grants.filter((g) => g.community_id === c.id).sort((a, b) => b.expires_at.getTime() - a.expires_at.getTime())[0];
        return {
          id: c.id,
          name: c.name,
          plan: c.plan,
          isOwner: c.owner_id === userId,
          memberLimit: limitInfo(COMMUNITY_MEMBER_LIMIT[c.plan], c.member_count),
          subscription: sub ? this.subView(sub, userId) : null,
          grantExpiresAt: grant?.expires_at.toISOString() ?? null,
        };
      }),
    };
  }

  /**
   * Persiapan membeli: memeriksa hak (pemilik komunitas untuk Pro, belum berlangganan) dan memberi productId +
   * obfuscatedExternalAccountId yang wajib diset aplikasi di alur pembelian Play.
   */
  async intent(userId: string, kind: SubscriptionKind, communityId?: string) {
    this.requireEnabled();
    if (kind === 'premium') {
      if (communityId) throw new ApiError(400, 'invalid_input', 'Premium tidak terkait komunitas');
      const active = await this.activeSubs(this.pool, { userId, kinds: ['premium'] });
      if (active.length) throw new ApiError(409, 'already_subscribed', 'Kamu sudah berlangganan Premium');
      return { productId: this.env.PLAY_PRODUCT_PREMIUM, obfuscatedAccountId: this.accountRef('premium', userId), upgradeFrom: null };
    }
    if (!communityId) throw new ApiError(400, 'invalid_input', 'Pilih komunitas');
    await this.requireOwner(this.pool, userId, communityId, false);
    const active = await this.activeSubs(this.pool, { communityId, kinds: ['pro', 'pro_unlimited'] });
    if (active.some((s) => rank(s) >= rankOf(kind))) throw new ApiError(409, 'already_subscribed', 'Komunitas ini sudah berlangganan paket ini');
    // Upgrade Pro → Pro Unlimited: aplikasi mengganti langganan lama (linkedPurchaseToken) jika dibeli akun ini.
    const upgradeFrom = active.find((s) => s.kind === 'pro' && s.user_id === userId)?.product_id ?? null;
    return { productId: productIds(this.env)[kind], obfuscatedAccountId: this.accountRef(kind, userId, communityId), upgradeFrom };
  }

  /** Verifikasi pembelian dari aplikasi ke Google Play, lalu (baru) mengubah paket dan meng-acknowledge. */
  async verify(userId: string, input: { productId: string; purchaseToken: string; communityId?: string }) {
    this.requireEnabled();
    const kind = kindOfProduct(this.env, input.productId);
    if (!kind) throw new ApiError(400, 'unknown_product', 'Produk langganan tidak dikenal');
    if (kind === 'premium' && input.communityId) throw new ApiError(400, 'invalid_input', 'Premium tidak terkait komunitas');
    if (kind !== 'premium' && input.communityId) await this.requireOwner(this.pool, userId, input.communityId, false);

    const purchase = await this.fetchPurchase(input.purchaseToken);
    if (!purchase.lineItems?.some((li) => li.productId === input.productId)) {
      throw new ApiError(400, 'invalid_purchase', 'Pembelian tidak cocok dengan produk');
    }
    const ref = purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId;
    let communityId = input.communityId ?? null;
    if (kind === 'premium') {
      if (ref !== this.accountRef('premium', userId)) throw purchaseMismatch();
    } else {
      // Pembelian yang dikirim ulang aplikasi tanpa communityId (mis. setelah aplikasi dimulai ulang): cari komunitas
      // milik pengguna yang HMAC-nya cocok.
      if (!communityId) {
        const { rows } = await this.pool.query<{ id: string }>('SELECT id FROM communities WHERE owner_id = $1 AND removed_at IS NULL', [userId]);
        communityId = rows.find((c) => this.accountRef(kind, userId, c.id) === ref)?.id ?? null;
      }
      if (!communityId || ref !== this.accountRef(kind, userId, communityId)) throw purchaseMismatch();
    }

    const id = await this.planTx(async (db) => {
      // Urutan kunci: pengguna → komunitas → langganan (#43).
      await db.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (communityId) await this.requireOwner(db, userId, communityId, true);
      const hash = sha(input.purchaseToken);
      const { rows: ex } = await db.query<{ id: string; user_id: string | null; community_id: string | null }>(
        'SELECT id, user_id, community_id FROM play_subscriptions WHERE token_hash = $1 FOR UPDATE',
        [hash],
      );
      const existing = ex[0];
      if (existing && (existing.user_id !== userId || existing.community_id !== communityId)) {
        throw new ApiError(409, 'purchase_already_linked', 'Pembelian ini sudah terhubung ke akun atau komunitas lain');
      }
      const subId = existing?.id ?? randomUUID();
      if (!existing) {
        await db.query(
          `INSERT INTO play_subscriptions (id, token_hash, token_enc, product_id, kind, user_id, community_id, state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'UNSPECIFIED')`,
          [subId, hash, this.crypto.encrypt(input.purchaseToken, tokenAad(subId)), input.productId, kind, userId, communityId],
        );
      }
      const affected = await this.applyPurchase(db, subId, kind, purchase, false);
      await this.recompute(db, affected);
      return subId;
    });
    await this.ackIfNeeded(id);
    const row = (await this.pool.query<SubRow>(`SELECT ${SUB_COLS} FROM play_subscriptions WHERE id = $1`, [id])).rows[0]!;
    return { subscription: this.subView(row, userId), ...(await this.plans(userId, communityId)) };
  }

  // ---------- Real-time Developer Notifications ----------

  /**
   * Pub/Sub push. Token OIDC diverifikasi lebih dulu; isi notifikasi tidak dipercaya (hanya penunjuk token yang perlu
   * disinkronkan ulang ke Google di worker). Idempoten per messageId. Galat sementara = 503 agar Pub/Sub mengulang.
   */
  async handleRtdn(authorization: string | undefined, body: unknown): Promise<RtdnOutcome> {
    if (!rtdnEnabled(this.env)) throw new ApiError(503, 'not_configured', 'Notifikasi langganan belum dikonfigurasi');
    await this.oidc.verify(authorization);
    const parsed = RtdnBody.safeParse(body);
    // Pesan rusak tidak akan membaik bila diulang: di-ack (2xx) dan diabaikan.
    if (!parsed.success) return 'ignored';
    let n: z.infer<typeof Notification>;
    try {
      const decoded = Notification.safeParse(JSON.parse(Buffer.from(parsed.data.message.data, 'base64').toString('utf8')));
      if (!decoded.success) return 'ignored';
      n = decoded.data;
    } catch {
      return 'ignored';
    }
    if (n.packageName !== this.env.GOOGLE_PLAY_PACKAGE_NAME) return 'ignored';
    let token: string | undefined;
    let revoke = false;
    let kind = 'test';
    if (n.subscriptionNotification) {
      token = n.subscriptionNotification.purchaseToken;
      revoke = n.subscriptionNotification.notificationType === SUBSCRIPTION_REVOKED;
      kind = `subscription:${n.subscriptionNotification.notificationType}`;
    } else if (n.voidedPurchaseNotification) {
      // productType 1 = langganan; produk sekali beli belum ada.
      if (n.voidedPurchaseNotification.productType !== undefined && n.voidedPurchaseNotification.productType !== 1) return 'ignored';
      token = n.voidedPurchaseNotification.purchaseToken;
      revoke = true;
      kind = 'voided';
    }
    if (!token) return 'ignored';
    if (!PURCHASE_TOKEN_RE.test(token)) return 'ignored';

    const messageId = parsed.data.message.messageId;
    const { rowCount } = await this.pool.query('INSERT INTO play_rtdn_messages (message_id, kind) VALUES ($1, $2) ON CONFLICT DO NOTHING', [messageId, kind]);
    if (!rowCount) return 'duplicate';
    try {
      await this.queue.enqueue({ tokenEnc: this.crypto.encrypt(token, JOB_AAD).toString('base64'), revoke });
    } catch {
      await this.pool.query('DELETE FROM play_rtdn_messages WHERE message_id = $1', [messageId]).catch(() => undefined);
      throw new ApiError(503, 'unavailable', 'Coba lagi');
    }
    return 'queued';
  }

  /** Prosesor worker untuk job dari RTDN. */
  async processJob(job: SubscriptionJob) {
    const token = this.crypto.decryptString(Buffer.from(job.tokenEnc, 'base64'), JOB_AAD);
    return this.syncToken(token, { revoke: job.revoke });
  }

  /**
   * Ambil status terbaru satu token dari Google dan terapkan. Token yang belum dikenal hanya diterima jika
   * linkedPurchaseToken-nya dikenal (upgrade/downgrade/berlangganan ulang) dan obfuscatedExternalAccountId cocok
   * dengan akun (+ komunitas) langganan lama; pembelian baru lainnya baru terikat lewat verifikasi dari aplikasi.
   */
  async syncToken(token: string, opts: { revoke?: boolean } = {}): Promise<'updated' | 'linked' | 'unknown' | 'mismatch'> {
    const hash = sha(token);
    const known = (await this.pool.query<SubRow>(`SELECT ${SUB_COLS} FROM play_subscriptions WHERE token_hash = $1`, [hash])).rows[0];
    let purchase: SubscriptionPurchaseV2 | undefined;
    try {
      purchase = await this.play.getSubscription(token);
    } catch (err) {
      // Token yang sudah sangat lama kedaluwarsa (Google menjawab 410/404) = tanpa hak.
      if (!(err instanceof PlayApiError && err.invalidToken) || !known) throw err;
    }

    if (!known) {
      if (!purchase) return 'unknown';
      const old = purchase.linkedPurchaseToken
        ? (await this.pool.query<SubRow>(`SELECT ${SUB_COLS} FROM play_subscriptions WHERE token_hash = $1`, [sha(purchase.linkedPurchaseToken)])).rows[0]
        : undefined;
      const productId = purchase.lineItems?.[0]?.productId ?? '';
      const kind = kindOfProduct(this.env, productId);
      if (!old?.user_id || !kind || (kind === 'premium') !== (old.kind === 'premium')) return 'unknown';
      if (purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId !== this.accountRef(kind, old.user_id, old.community_id)) return 'mismatch';
      const subId = randomUUID();
      const linked = await this.planTx(async (db) => {
        await db.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [old.user_id]);
        if (old.community_id) await db.query('SELECT 1 FROM communities WHERE id = $1 FOR UPDATE', [old.community_id]);
        const { rowCount } = await db.query(
          `INSERT INTO play_subscriptions (id, token_hash, token_enc, product_id, kind, user_id, community_id, state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'UNSPECIFIED') ON CONFLICT (token_hash) DO NOTHING`,
          [subId, hash, this.crypto.encrypt(token, tokenAad(subId)), productId, kind, old.user_id, old.community_id],
        );
        if (!rowCount) return false; // sudah dibuat oleh verifikasi aplikasi pada saat yang sama
        await this.recompute(db, await this.applyPurchase(db, subId, kind, purchase, Boolean(opts.revoke)));
        return true;
      });
      if (!linked) return this.syncToken(token, opts);
      await this.ackIfNeeded(subId);
      return 'linked';
    }

    await this.planTx(async (db) => {
      if (known.user_id) await db.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [known.user_id]);
      if (known.community_id) await db.query('SELECT 1 FROM communities WHERE id = $1 FOR UPDATE', [known.community_id]);
      await db.query('SELECT 1 FROM play_subscriptions WHERE id = $1 FOR UPDATE', [known.id]);
      const affected = purchase
        ? await this.applyPurchase(db, known.id, known.kind, purchase, Boolean(opts.revoke))
        : await this.markGone(db, known, Boolean(opts.revoke));
      await this.recompute(db, affected);
    });
    if (purchase) await this.ackIfNeeded(known.id);
    return 'updated';
  }

  // ---------- Rekonsiliasi berkala (worker) ----------

  /**
   * Dijalankan worker tiap 30 menit:
   * 1. Hitung ulang paket yang menyimpang (langganan/pemberian manual yang lewat masa berlaku tanpa notifikasi).
   * 2. Sinkron ke Google langganan yang mendekati/lewat masa berlaku, bermasalah, belum di-acknowledge, atau lama
   *    tidak dicek.
   * 3. voidedPurchases.list (maks. tiap 6 jam) untuk refund yang notifikasinya terlewat.
   * 4. Bersihkan catatan idempotensi RTDN > 30 hari.
   */
  async reconcile() {
    const drift = await this.sweep();
    let synced = 0;
    let failed = 0;
    let voided = 0;
    if (this.enabled) {
      const { rows } = await this.pool.query<{ id: string; token_enc: Buffer }>(
        `SELECT id, token_enc FROM play_subscriptions
          WHERE token_enc IS NOT NULL AND revoked_at IS NULL AND replaced_by IS NULL
            AND last_checked_at < now() - interval '20 minutes'
            AND (
              (acknowledged = false AND state NOT IN ('EXPIRED', 'PENDING_PURCHASE_CANCELED'))
              OR state IN ('IN_GRACE_PERIOD', 'ON_HOLD', 'PAUSED', 'PENDING', 'UNSPECIFIED')
              OR (expires_at < now() + interval '6 hours' AND expires_at > now() - interval '3 days')
              OR (last_checked_at < now() - interval '7 days' AND state <> 'EXPIRED')
            )
          ORDER BY last_checked_at LIMIT 100`,
      );
      for (const r of rows) {
        try {
          await this.syncToken(this.crypto.decryptString(r.token_enc, tokenAad(r.id)));
          synced++;
        } catch (err) {
          failed++;
          this.logger.warn(`Sinkron langganan gagal: ${err instanceof Error ? err.message : 'galat'}`);
        }
      }
      voided = await this.reconcileVoided().catch((err: unknown) => {
        this.logger.warn(`voidedPurchases gagal: ${err instanceof Error ? err.message : 'galat'}`);
        return 0;
      });
    }
    await this.pool.query(`DELETE FROM play_rtdn_messages WHERE received_at < now() - interval '30 days'`);
    return { ...drift, synced, failed, voided };
  }

  /** Paket yang tidak sesuai hak terkini (hanya entitas yang punya catatan langganan/pemberian; paket lama di luar 2.5 tidak disentuh). */
  async sweep() {
    const users = await this.pool.query<{ id: string; old: string; plan: string }>(
      `UPDATE users u SET plan = compute_user_plan(u.id)
         FROM (SELECT id, plan AS old FROM users) o
        WHERE u.id = o.id
          AND u.id IN (SELECT user_id FROM play_subscriptions WHERE user_id IS NOT NULL
                       UNION SELECT user_id FROM plan_grants WHERE user_id IS NOT NULL)
          AND u.status <> 'deleted' AND u.plan <> compute_user_plan(u.id)
        RETURNING u.id, o.old, u.plan`,
    );
    const communities = await this.pool.query<{ id: string; old: string; plan: string }>(
      `UPDATE communities c SET plan = compute_community_plan(c.id)
         FROM (SELECT id, plan AS old FROM communities) o
        WHERE c.id = o.id
          AND c.id IN (SELECT community_id FROM play_subscriptions WHERE community_id IS NOT NULL
                       UNION SELECT community_id FROM plan_grants WHERE community_id IS NOT NULL)
          AND c.plan <> compute_community_plan(c.id)
        RETURNING c.id, o.old, c.plan`,
    );
    await this.notifyPlanChanges([
      ...users.rows.map((r) => ({ kind: 'user' as const, id: r.id, from: r.old, to: r.plan })),
      ...communities.rows.map((r) => ({ kind: 'community' as const, id: r.id, from: r.old, to: r.plan })),
    ]);
    return { users: users.rowCount ?? 0, communities: communities.rowCount ?? 0 };
  }

  private async reconcileVoided(): Promise<number> {
    const key = 'play:voided:last';
    const last = Number((await this.redis.get(key)) ?? 0);
    const now = Date.now();
    if (last && now - last < 6 * 3_600_000) return 0;
    // Google menyimpan voided purchases 30 hari; mulai 1 jam sebelum putaran terakhir agar tidak ada celah.
    const start = last ? last - 3_600_000 : now - 30 * 86_400_000;
    const list = await this.play.listVoided(start);
    let n = 0;
    for (const v of list) {
      const { rows } = await this.pool.query<SubRow>(`SELECT ${SUB_COLS} FROM play_subscriptions WHERE token_hash = $1 AND revoked_at IS NULL`, [sha(v.purchaseToken)]);
      const row = rows[0];
      if (!row) continue;
      await this.planTx(async (db) => {
        if (row.user_id) await db.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [row.user_id]);
        if (row.community_id) await db.query('SELECT 1 FROM communities WHERE id = $1 FOR UPDATE', [row.community_id]);
        await db.query('UPDATE play_subscriptions SET revoked_at = now(), updated_at = now() WHERE id = $1 AND revoked_at IS NULL', [row.id]);
        await this.recompute(db, { userIds: row.user_id ? [row.user_id] : [], communityIds: row.community_id ? [row.community_id] : [] });
      });
      n++;
    }
    await this.redis.set(key, String(now));
    return n;
  }

  // ---------- Hapus akun ----------

  /**
   * Catatan langganan dipertahankan untuk akuntansi/refund (produk, status, tanggal, id pesanan) tanpa tautan ke akun:
   * user_id dan token dikosongkan. Pemberian manual dihapus. Mengembalikan token yang masih diperpanjang otomatis agar
   * perpanjangannya dihentikan (cancel) setelah commit.
   */
  async onAccountDeletion(db: Queryable, userId: string): Promise<{ productId: string; token: string }[]> {
    const { rows } = await db.query<SubRow>(`SELECT ${SUB_COLS} FROM play_subscriptions WHERE user_id = $1`, [userId]);
    const toCancel = rows
      .filter((r) => r.token_enc && r.auto_renewing && !r.revoked_at && !r.replaced_by && r.state !== 'EXPIRED')
      .map((r) => ({ productId: r.product_id, token: this.crypto.decryptString(r.token_enc!, tokenAad(r.id)) }));
    const communityIds = [...new Set(rows.map((r) => r.community_id).filter((c): c is string => Boolean(c)))];
    await db.query('UPDATE play_subscriptions SET user_id = NULL, token_enc = NULL, updated_at = now() WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM plan_grants WHERE user_id = $1', [userId]);
    await db.query(`UPDATE users SET plan = 'free' WHERE id = $1`, [userId]);
    // Komunitas Pro yang dibayar akun ini tetap Pro sampai masa berlakunya habis (perpanjangan dihentikan).
    if (communityIds.length) await this.recompute(db, { userIds: [], communityIds });
    return toCancel;
  }

  /** Hentikan perpanjangan otomatis di Google Play (best effort, setelah commit). Tanpa refund otomatis. */
  async cancelAll(list: { productId: string; token: string }[]) {
    if (!this.enabled) return;
    for (const s of list) {
      await this.play.cancel(s.productId, s.token).catch((err: unknown) => {
        this.logger.warn(`Gagal menghentikan perpanjangan langganan akun terhapus: ${err instanceof Error ? err.message : 'galat'}`);
      });
    }
  }

  // ---------- Panel super admin ----------

  async adminUser(adminId: string, userId: string) {
    const { rows } = await this.pool.query<{ id: string; display_name: string; plan: UserPlan; status: string }>(
      'SELECT id, display_name, plan, status FROM users WHERE id = $1',
      [userId],
    );
    if (!rows[0]) throw new ApiError(404, 'user_not_found', 'Pengguna tidak ditemukan');
    await audit(this.pool, adminId, 'subscription.view', { type: 'user', id: userId });
    const subs = await this.pool.query<SubRow>(`SELECT ${SUB_COLS} FROM play_subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [userId]);
    return {
      user: { id: rows[0].id, displayName: rows[0].display_name, plan: rows[0].plan, status: rows[0].status },
      subscriptions: subs.rows.map((s) => this.adminSubView(s)),
      grants: await this.grantsOf('user_id', userId),
    };
  }

  async adminCommunity(adminId: string, communityId: string) {
    const { rows } = await this.pool.query<{ id: string; name: string; plan: CommunityPlan; member_count: number; owner_id: string }>(
      'SELECT id, name, plan, member_count, owner_id FROM communities WHERE id = $1',
      [communityId],
    );
    if (!rows[0]) throw new ApiError(404, 'community_not_found', 'Komunitas tidak ditemukan');
    await audit(this.pool, adminId, 'subscription.view', { type: 'community', id: communityId });
    const subs = await this.pool.query<SubRow>(`SELECT ${SUB_COLS} FROM play_subscriptions WHERE community_id = $1 ORDER BY created_at DESC LIMIT 50`, [communityId]);
    const c = rows[0];
    return {
      community: { id: c.id, name: c.name, plan: c.plan, memberCount: c.member_count, ownerId: c.owner_id },
      subscriptions: subs.rows.map((s) => this.adminSubView(s)),
      grants: await this.grantsOf('community_id', communityId),
    };
  }

  /** Nama komunitas adalah informasi publik (direktori). Maks. 10 hasil. */
  async searchCommunities(q: string) {
    const { rows } = await this.pool.query<{ id: string; name: string; city: string; plan: CommunityPlan; member_count: number }>(
      `SELECT id, name, city, plan, member_count FROM communities WHERE name ILIKE $1 ORDER BY name LIMIT 10`,
      [`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`],
    );
    return { items: rows.map((r) => ({ id: r.id, name: r.name, city: r.city, plan: r.plan, memberCount: r.member_count })) };
  }

  /** Pemberian paket manual (uji tanpa Play / kompensasi): berbatas waktu dan tercatat di admin_audit_log. */
  async grant(adminId: string, input: { userId?: string; communityId?: string; plan: SubscriptionKind; days: number; reason: string }) {
    if ((input.plan === 'premium') !== Boolean(input.userId) || Boolean(input.userId) === Boolean(input.communityId)) {
      throw new ApiError(400, 'invalid_input', 'Premium untuk pengguna; Pro/Pro Unlimited untuk komunitas');
    }
    const expiresAt = new Date(Date.now() + input.days * 86_400_000);
    const id = await this.planTx(async (db) => {
      if (input.userId) {
        const { rows } = await db.query<{ status: string }>('SELECT status FROM users WHERE id = $1 FOR UPDATE', [input.userId]);
        if (!rows[0] || rows[0].status === 'deleted') throw new ApiError(404, 'user_not_found', 'Pengguna tidak ditemukan');
      } else {
        const { rowCount } = await db.query('SELECT 1 FROM communities WHERE id = $1 FOR UPDATE', [input.communityId]);
        if (!rowCount) throw new ApiError(404, 'community_not_found', 'Komunitas tidak ditemukan');
      }
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO plan_grants (user_id, community_id, plan, expires_at, reason, granted_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [input.userId ?? null, input.communityId ?? null, input.plan, expiresAt, input.reason, adminId],
      );
      await this.recompute(db, { userIds: input.userId ? [input.userId] : [], communityIds: input.communityId ? [input.communityId] : [] });
      await audit(db, adminId, 'plan.grant', input.userId ? { type: 'user', id: input.userId } : { type: 'community', id: input.communityId! }, {
        plan: input.plan,
        days: input.days,
        expiresAt: expiresAt.toISOString(),
        reason: input.reason,
      });
      return rows[0]!.id;
    });
    return { id, expiresAt: expiresAt.toISOString() };
  }

  async revokeGrant(adminId: string, grantId: string, reason: string) {
    await this.planTx(async (db) => {
      const { rows } = await db.query<{ user_id: string | null; community_id: string | null; plan: string; revoked_at: Date | null }>(
        'SELECT user_id, community_id, plan, revoked_at FROM plan_grants WHERE id = $1',
        [grantId],
      );
      const g = rows[0];
      if (!g) throw new ApiError(404, 'grant_not_found', 'Pemberian paket tidak ditemukan');
      if (g.revoked_at) throw new ApiError(409, 'grant_revoked', 'Sudah dicabut');
      if (g.user_id) await db.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [g.user_id]);
      if (g.community_id) await db.query('SELECT 1 FROM communities WHERE id = $1 FOR UPDATE', [g.community_id]);
      await db.query('UPDATE plan_grants SET revoked_at = now(), revoked_by = $2 WHERE id = $1', [grantId, adminId]);
      await this.recompute(db, { userIds: g.user_id ? [g.user_id] : [], communityIds: g.community_id ? [g.community_id] : [] });
      await audit(db, adminId, 'plan.revoke_grant', { type: 'plan_grant', id: grantId }, { plan: g.plan, reason });
    });
  }

  // ---------- Bantuan ----------

  private requireEnabled() {
    if (!this.enabled) throw new ApiError(503, 'not_configured', 'Langganan belum tersedia');
  }

  private async fetchPurchase(token: string): Promise<SubscriptionPurchaseV2> {
    try {
      return await this.play.getSubscription(token);
    } catch (err) {
      if (err instanceof PlayApiError && err.invalidToken) throw new ApiError(400, 'invalid_purchase', 'Pembelian tidak ditemukan di Google Play');
      this.logger.warn(`Verifikasi Google Play gagal: ${err instanceof Error ? err.message : 'galat'}`);
      throw new ApiError(502, 'play_unavailable', 'Google Play sedang tidak bisa dihubungi. Coba lagi nanti');
    }
  }

  private async requireOwner(db: Queryable, userId: string, communityId: string, lock: boolean) {
    const { rows } = await db.query<{ owner_id: string }>(
      `SELECT owner_id FROM communities WHERE id = $1 AND removed_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
      [communityId],
    );
    if (!rows[0]) throw new ApiError(404, 'community_not_found', 'Komunitas tidak ditemukan');
    if (rows[0].owner_id !== userId) throw new ApiError(403, 'not_owner', 'Hanya pemilik komunitas yang bisa berlangganan Komunitas Pro');
  }

  /** Terapkan status Google ke satu baris. Mengembalikan entitas yang paketnya perlu dihitung ulang. */
  private async applyPurchase(db: Queryable, subId: string, kind: SubscriptionKind, p: SubscriptionPurchaseV2, revoke: boolean) {
    const state = shortState(p.subscriptionState);
    const items = p.lineItems ?? [];
    const expiries = items.map((li) => (li.expiryTime ? Date.parse(li.expiryTime) : NaN)).filter((t) => Number.isFinite(t));
    const expiresAt = expiries.length ? new Date(Math.max(...expiries)) : null;
    const autoRenewing = items.some((li) => li.autoRenewingPlan?.autoRenewEnabled === true);
    const acknowledged = p.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
    const orderId = (p.latestOrderId ?? items.find((li) => li.latestSuccessfulOrderId)?.latestSuccessfulOrderId ?? null)?.slice(0, 100) ?? null;
    // Ganti produk dalam lingkup yang sama (Pro ↔ Pro Unlimited) lewat ITEMS_CHANGED.
    const productId = items.find((li) => li.productId && kindOfProduct(this.env, li.productId))?.productId;
    const newKind = productId ? kindOfProduct(this.env, productId) : undefined;
    const keepKind = !newKind || (newKind === 'premium') !== (kind === 'premium');
    const { rows } = await db.query<{ user_id: string | null; community_id: string | null }>(
      `UPDATE play_subscriptions SET state = $2, expires_at = $3, auto_renewing = $4, acknowledged = acknowledged OR $5,
              test_purchase = $6, order_id = COALESCE($7, order_id), product_id = COALESCE($8, product_id), kind = $9,
              revoked_at = CASE WHEN $10 THEN COALESCE(revoked_at, now()) ELSE revoked_at END,
              last_checked_at = now(), updated_at = now()
        WHERE id = $1 RETURNING user_id, community_id`,
      [subId, state, expiresAt, autoRenewing, acknowledged, Boolean(p.testPurchase), orderId, keepKind ? null : productId, keepKind ? kind : newKind, revoke],
    );
    const affected = { userIds: [] as string[], communityIds: [] as string[] };
    const add = (r?: { user_id: string | null; community_id: string | null }) => {
      if (r?.user_id) affected.userIds.push(r.user_id);
      if (r?.community_id) affected.communityIds.push(r.community_id);
    };
    add(rows[0]);
    // Token lama yang digantikan (upgrade/downgrade/berlangganan ulang) berhenti memberi hak. Hanya milik pembeli yang sama.
    if (p.linkedPurchaseToken && rows[0]?.user_id) {
      const { rows: old } = await db.query<{ user_id: string | null; community_id: string | null }>(
        `UPDATE play_subscriptions SET replaced_by = $2, updated_at = now()
          WHERE token_hash = $1 AND id <> $2 AND user_id = $3 AND replaced_by IS NULL RETURNING user_id, community_id`,
        [sha(p.linkedPurchaseToken), subId, rows[0].user_id],
      );
      old.forEach(add);
    }
    return affected;
  }

  /** Google tidak lagi mengenal token (lama kedaluwarsa): tanpa hak. */
  private async markGone(db: Queryable, row: SubRow, revoke: boolean) {
    await db.query(
      `UPDATE play_subscriptions SET state = 'EXPIRED', auto_renewing = false, last_checked_at = now(), updated_at = now(),
              revoked_at = CASE WHEN $2 THEN COALESCE(revoked_at, now()) ELSE revoked_at END WHERE id = $1`,
      [row.id, revoke],
    );
    return { userIds: row.user_id ? [row.user_id] : [], communityIds: row.community_id ? [row.community_id] : [] };
  }

  /** Hitung ulang users.plan / communities.plan dari hak terkini (urutan: pengguna → komunitas). */
  async recompute(db: Queryable, a: { userIds: string[]; communityIds: string[] }) {
    const changes = this.planChanges.getStore();
    if (a.userIds.length) {
      const { rows } = await db.query<{ id: string; old: string; plan: string }>(
        `UPDATE users u SET plan = compute_user_plan(u.id)
           FROM (SELECT id, plan AS old FROM users WHERE id = ANY($1::uuid[])) o
          WHERE u.id = o.id AND u.status <> 'deleted' AND u.plan <> compute_user_plan(u.id)
          RETURNING u.id, o.old, u.plan`,
        [[...new Set(a.userIds)]],
      );
      for (const r of rows) changes?.push({ kind: 'user', id: r.id, from: r.old, to: r.plan });
    }
    if (a.communityIds.length) {
      const { rows } = await db.query<{ id: string; old: string; plan: string }>(
        `UPDATE communities c SET plan = compute_community_plan(c.id)
           FROM (SELECT id, plan AS old FROM communities WHERE id = ANY($1::uuid[])) o
          WHERE c.id = o.id AND c.plan <> compute_community_plan(c.id)
          RETURNING c.id, o.old, c.plan`,
        [[...new Set(a.communityIds)]],
      );
      for (const r of rows) changes?.push({ kind: 'community', id: r.id, from: r.old, to: r.plan });
    }
  }

  /**
   * Beri tahu perubahan paket: pengguna untuk Premium, pemilik komunitas untuk Pro. Saat berakhir, ditegaskan bahwa
   * tidak ada data yang dihapus (#201). Tidak pernah melempar galat.
   */
  private async notifyPlanChanges(changes: PlanChange[]) {
    for (const c of changes) {
      try {
        if (c.kind === 'user') {
          const up = c.to !== 'free';
          await this.notifications.notify([c.id], {
            category: 'account',
            inbox: { type: up ? 'plan_activated' : 'plan_ended', data: { plan: c.to, from: c.from } },
            push: {
              title: up ? 'Premium aktif' : 'Premium berakhir',
              body: up ? 'Semua fitur Premium sudah bisa dipakai' : 'Akunmu kembali ke paket gratis. Data dan riwayatmu tetap tersimpan',
              data: { type: up ? 'plan_activated' : 'plan_ended' },
            },
          });
        } else {
          const { rows } = await this.pool.query<{ owner_id: string; name: string }>('SELECT owner_id, name FROM communities WHERE id = $1', [c.id]);
          if (!rows[0]) continue;
          const up = c.to !== 'free';
          const label = c.to === 'pro_unlimited' ? 'Pro Unlimited' : 'Pro';
          await this.notifications.notify([rows[0].owner_id], {
            category: 'account',
            communityId: c.id,
            inbox: { type: up ? 'community_plan_activated' : 'community_plan_ended', data: { communityId: c.id, plan: c.to, from: c.from } },
            push: {
              title: up ? `${rows[0].name} sekarang ${label}` : `Paket ${rows[0].name} berakhir`,
              body: up ? 'Fitur komunitas Pro sudah bisa dipakai' : 'Komunitas kembali ke paket gratis. Anggota dan data tetap ada',
              data: { type: up ? 'community_plan_activated' : 'community_plan_ended', communityId: c.id },
            },
          });
        }
      } catch (err) {
        this.logger.warn(`Gagal memberi tahu perubahan paket: ${err instanceof Error ? err.message : 'galat'}`);
      }
    }
  }

  /** Acknowledge di server (wajib dalam 3 hari, selain itu Google me-refund otomatis). Gagal = dicoba lagi oleh rekonsiliasi. */
  private async ackIfNeeded(subId: string) {
    const { rows } = await this.pool.query<SubRow>(`SELECT ${SUB_COLS} FROM play_subscriptions WHERE id = $1`, [subId]);
    const r = rows[0];
    if (!r?.token_enc || r.acknowledged || r.revoked_at || !['ACTIVE', 'IN_GRACE_PERIOD'].includes(r.state)) return;
    try {
      await this.play.acknowledge(r.product_id, this.crypto.decryptString(r.token_enc, tokenAad(r.id)));
      await this.pool.query('UPDATE play_subscriptions SET acknowledged = true, updated_at = now() WHERE id = $1', [r.id]);
    } catch (err) {
      this.logger.warn(`Acknowledge langganan gagal: ${err instanceof Error ? err.message : 'galat'}`);
    }
  }

  private async activeSubs(db: Queryable, where: { userId?: string; communityId?: string; kinds: SubscriptionKind[] }) {
    const { rows } = await db.query<SubRow>(
      `SELECT ${SUB_COLS} FROM play_subscriptions s
        WHERE s.kind = ANY($1::text[]) AND play_subscription_entitled(s)
          AND ($2::uuid IS NULL OR s.user_id = $2) AND ($3::uuid IS NULL OR s.community_id = $3)`,
      [where.kinds, where.userId ?? null, where.communityId ?? null],
    );
    return rows;
  }

  private async plans(userId: string, communityId: string | null) {
    const u = await this.pool.query<{ plan: UserPlan }>('SELECT plan FROM users WHERE id = $1', [userId]);
    const c = communityId ? await this.pool.query<{ plan: CommunityPlan }>('SELECT plan FROM communities WHERE id = $1', [communityId]) : undefined;
    return { userPlan: u.rows[0]?.plan ?? 'free', ...(c ? { communityId, communityPlan: c.rows[0]?.plan ?? 'free' } : {}) };
  }

  /** Langganan yang layak ditampilkan: masih berhak, bermasalah (bisa dipulihkan), atau menunggu pembayaran. */
  private relevant(s: SubRow): boolean {
    if (s.revoked_at || s.replaced_by) return false;
    return this.entitled(s) || ['ON_HOLD', 'PAUSED', 'PENDING'].includes(s.state);
  }

  private entitled(s: SubRow) {
    return isEntitled({ state: s.state, expiresAt: s.expires_at, revoked: Boolean(s.revoked_at), replaced: Boolean(s.replaced_by) });
  }

  private subView(s: SubRow, viewerId: string) {
    return {
      productId: s.product_id,
      kind: s.kind,
      state: s.state,
      active: this.entitled(s),
      expiresAt: s.expires_at?.toISOString() ?? null,
      autoRenewing: s.auto_renewing,
      purchasedByMe: s.user_id === viewerId,
      // Masa tenggang / ditangguhkan: pengguna perlu memperbarui pembayaran di Google Play.
      paymentIssue: s.state === 'IN_GRACE_PERIOD' || s.state === 'ON_HOLD',
      pending: s.state === 'PENDING',
    };
  }

  /** Tampilan panel: tanpa token dan tanpa data pribadi. */
  private adminSubView(s: SubRow) {
    return {
      id: s.id,
      productId: s.product_id,
      kind: s.kind,
      state: s.state,
      active: this.entitled(s),
      expiresAt: s.expires_at?.toISOString() ?? null,
      autoRenewing: s.auto_renewing,
      acknowledged: s.acknowledged,
      testPurchase: s.test_purchase,
      orderId: s.order_id,
      revokedAt: s.revoked_at?.toISOString() ?? null,
      replaced: Boolean(s.replaced_by),
      userId: s.user_id,
      communityId: s.community_id,
      createdAt: s.created_at.toISOString(),
      updatedAt: s.updated_at.toISOString(),
    };
  }

  private async grantsOf(col: 'user_id' | 'community_id', id: string) {
    const { rows } = await this.pool.query<{ id: string; plan: string; expires_at: Date; reason: string; revoked_at: Date | null; created_at: Date; granted_by_name: string | null }>(
      `SELECT g.id, g.plan, g.expires_at, g.reason, g.revoked_at, g.created_at, u.display_name AS granted_by_name
         FROM plan_grants g LEFT JOIN users u ON u.id = g.granted_by WHERE g.${col} = $1 ORDER BY g.created_at DESC LIMIT 50`,
      [id],
    );
    return rows.map((g) => ({
      id: g.id,
      plan: g.plan,
      expiresAt: g.expires_at.toISOString(),
      active: !g.revoked_at && g.expires_at > new Date(),
      reason: g.reason,
      revokedAt: g.revoked_at?.toISOString() ?? null,
      createdAt: g.created_at.toISOString(),
      grantedBy: g.granted_by_name,
    }));
  }
}

const purchaseMismatch = () => new ApiError(403, 'purchase_mismatch', 'Pembelian ini bukan milik akun atau komunitas ini');

function rankOf(kind: SubscriptionKind) {
  return kind === 'pro_unlimited' ? 2 : kind === 'pro' ? 1 : 0;
}
const rank = (s: { kind: SubscriptionKind }) => rankOf(s.kind);
