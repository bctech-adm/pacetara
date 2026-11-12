import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { AdminGuard } from '../admin/admin-auth.service.js';
import { LevelGuard, RequireLevel } from '../auth/level.guard.js';
import { ApiError, type AuthUser, CurrentUser, Public, ZodPipe } from '../common/http.js';
import { MAX_UPLOAD_BYTES } from '../storage/image.js';
import { MarketService } from './market.service.js';
import { CATEGORIES, CONDITIONS } from './rules.js';
import { XENDIT } from './xendit.js';

const uuid = new ParseUUIDPipe();
const MAX_PHOTOS = 6;
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const ListingBody = z
  .object({
    model: z.enum(['listing_fee', 'affiliate', 'split']),
    title: text(3, 80),
    description: z.string().trim().max(2000).default(''),
    category: z.enum(CATEGORIES),
    condition: z.enum(CONDITIONS),
    price: z.number().int().min(1000, 'Harga minimal Rp1.000').max(1_000_000_000),
    city: text(2, 60),
    affiliateUrl: z.string().max(1000).optional(),
    stock: z.number().int().min(1).max(999).optional(),
  })
  .strict();
const ListingPatch = z
  .object({
    title: text(3, 80),
    description: z.string().trim().max(2000),
    price: z.number().int().min(1000).max(1_000_000_000),
    city: text(2, 60),
    stock: z.number().int().min(0).max(999),
    status: z.enum(['sold', 'closed']),
  })
  .partial()
  .strict();
// Kata kunci dan filter di body (POST), bukan query string.
const SearchBody = z
  .object({
    q: z.string().trim().max(80).optional(),
    category: z.enum(CATEGORIES).optional(),
    city: z.string().trim().max(60).optional(),
    model: z.enum(['listing_fee', 'affiliate', 'split']).optional(),
    offset: z.number().int().min(0).max(500).default(0),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
const PolicyBody = z.object({ version: z.string().min(1).max(40) }).strict();
const OrderBody = z.object({ qty: z.number().int().min(1).max(10).default(1) }).strict();
const ShipBody = z.object({ trackingNote: z.string().trim().max(200).optional() }).strict().default({});
const DisputeBody = z.object({ reason: text(10, 1000) }).strict();
const PayBody = z.object({ purpose: z.enum(['listing_fee', 'listing_boost']) }).strict();
const OrdersQuery = z.object({ role: z.enum(['buyer', 'seller']).default('buyer') });
const AdminOrdersQuery = z.object({ status: z.enum(['open', 'pending', 'paid', 'shipped', 'completed', 'cancelled', 'expired', 'disputed', 'refunded']).default('open') });
const ResolveBody = z.object({ outcome: z.enum(['completed', 'refunded']), note: text(3, 500) }).strict();
const ReasonBody = z.object({ reason: text(3, 300) }).strict();

function parseListing(raw: unknown) {
  const data = (raw as { data?: unknown } | undefined)?.data;
  let json: unknown;
  try {
    json = typeof data === 'string' ? JSON.parse(data) : data;
  } catch {
    throw new ApiError(400, 'invalid_input', 'Data listing tidak valid');
  }
  return new ZodPipe(ListingBody).transform(json, { type: 'body' });
}

/** Marketplace di aplikasi (dan dasbor web untuk listing berbayar). Semua endpoint wajib Level 1. */
@Controller('market')
@UseGuards(LevelGuard)
@RequireLevel(1)
export class MarketController {
  constructor(private readonly market: MarketService) {}

  @Get('config')
  config(@CurrentUser() u: AuthUser) {
    return this.market.config(u.id);
  }

  @Post('policy')
  @HttpCode(200)
  acceptPolicy(@CurrentUser() u: AuthUser, @Body(new ZodPipe(PolicyBody)) b: z.infer<typeof PolicyBody>) {
    return this.market.acceptPolicy(u.id, b.version);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('listings/search')
  @HttpCode(200)
  search(@Body(new ZodPipe(SearchBody)) b: z.infer<typeof SearchBody>) {
    return this.market.search(b);
  }

  @Get('listings/mine')
  mine(@CurrentUser() u: AuthUser) {
    return this.market.mine(u.id);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('listings')
  @HttpCode(201)
  @UseInterceptors(
    FilesInterceptor('photos', MAX_PHOTOS, { limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_PHOTOS, fields: 1, fieldSize: 8 * 1024, parts: MAX_PHOTOS + 1 } }),
  )
  create(@CurrentUser() u: AuthUser, @Body() raw: unknown, @UploadedFiles() files?: { buffer?: Buffer }[]) {
    const input = parseListing(raw);
    const photos = (files ?? []).map((f) => f.buffer).filter((x): x is Buffer => Boolean(x));
    return this.market.create(u.id, input, photos);
  }

  @Get('listings/:id')
  detail(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.market.detail(u.id, id);
  }

  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Get('listings/:id/photos/:photoId')
  async photo(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Param('photoId', uuid) photoId: string, @Res() res: Response) {
    const file = await this.market.photo(u.id, id, photoId);
    if (!file) throw new ApiError(404, 'not_found', 'Foto tidak ditemukan');
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (file.length) res.setHeader('Content-Length', String(file.length));
    file.stream.pipe(res);
  }

  @Patch('listings/:id')
  update(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(ListingPatch)) b: z.infer<typeof ListingPatch>) {
    return this.market.update(u.id, id, b);
  }

  @Post('listings/:id/renew')
  @HttpCode(200)
  renew(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.market.renew(u.id, id);
  }

  @Delete('listings/:id')
  @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.market.remove(u.id, id);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('listings/:id/contact')
  @HttpCode(200)
  contact(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.market.contact(u.id, id);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('listings/:id/go')
  @HttpCode(200)
  go(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.market.go(u.id, id);
  }

  /** Dasbor web: bayar biaya pasang atau boost (Midtrans). Aplikasi Android tidak memanggil ini (REVIEW-PRD C1). */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('listings/:id/pay')
  @HttpCode(200)
  pay(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(PayBody)) b: z.infer<typeof PayBody>) {
    return this.market.pay(u.id, id, b.purpose);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('listings/:id/orders')
  @HttpCode(201)
  order(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(OrderBody)) b: z.infer<typeof OrderBody>) {
    return this.market.createOrder(u.id, id, b.qty);
  }

  @Get('orders')
  orders(@CurrentUser() u: AuthUser, @Query(new ZodPipe(OrdersQuery)) q: z.infer<typeof OrdersQuery>) {
    return this.market.orders(u.id, q.role);
  }

  @Get('orders/:id')
  orderDetail(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.market.order(u.id, id);
  }

  @Post('orders/:id/ship')
  @HttpCode(200)
  ship(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(ShipBody)) b: z.infer<typeof ShipBody>) {
    return this.market.ship(u.id, id, b.trackingNote);
  }

  @Post('orders/:id/complete')
  @HttpCode(200)
  complete(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.market.complete(u.id, id);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('orders/:id/dispute')
  @HttpCode(200)
  dispute(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(DisputeBody)) b: z.infer<typeof DisputeBody>) {
    return this.market.dispute(u.id, id, b.reason);
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.market.cancel(u.id, id);
  }

  @Get('seller')
  seller(@CurrentUser() u: AuthUser) {
    return this.market.seller(u.id);
  }

  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('seller')
  @HttpCode(200)
  activateSeller(@CurrentUser() u: AuthUser) {
    return this.market.activateSeller(u.id);
  }

  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @Post('seller/refresh')
  @HttpCode(200)
  refreshSeller(@CurrentUser() u: AuthUser) {
    return this.market.refreshSeller(u.id);
  }
}

/**
 * Callback Xendit (publik, diverifikasi header x-callback-token sebelum isi dibaca; isi tidak dipercaya, data
 * diambil ulang dari Xendit). Didaftarkan di dasbor Xendit: invoice → /v1/market/xendit/invoice, status akun
 * xenPlatform → /v1/market/xendit/account.
 */
@Controller('market/xendit')
export class XenditWebhookController {
  constructor(private readonly market: MarketService) {}

  @Public()
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Post('invoice')
  @HttpCode(200)
  async invoice(@Headers(XENDIT.callbackTokenHeader) token: string | undefined, @Body() body: Record<string, unknown>) {
    await this.market.invoiceCallback(token, body ?? {});
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Post('account')
  @HttpCode(200)
  async account(@Headers(XENDIT.callbackTokenHeader) token: string | undefined, @Body() body: Record<string, unknown>) {
    await this.market.accountCallback(token, body ?? {});
    return { ok: true };
  }
}

/** Panel super admin: pesanan/sengketa dan akun penjual. Setiap tindakan tercatat di admin_audit_log. */
@Controller('admin/market')
@UseGuards(AdminGuard)
export class AdminMarketController {
  constructor(private readonly market: MarketService) {}

  @Get('orders')
  orders(@Query(new ZodPipe(AdminOrdersQuery)) q: z.infer<typeof AdminOrdersQuery>) {
    return this.market.adminOrders(q.status);
  }

  @Get('orders/:id/dispute')
  dispute(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.market.adminDispute(u.id, id);
  }

  @Post('orders/:id/resolve')
  @HttpCode(204)
  async resolve(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(ResolveBody)) b: z.infer<typeof ResolveBody>) {
    await this.market.resolve(u.id, id, b.outcome, b.note);
  }

  @Get('sellers')
  sellers() {
    return this.market.adminSellers();
  }

  @Post('sellers/:userId/suspend')
  @HttpCode(204)
  async suspend(@CurrentUser() u: AuthUser, @Param('userId', uuid) userId: string, @Body(new ZodPipe(ReasonBody)) b: z.infer<typeof ReasonBody>) {
    await this.market.setSellerSuspended(u.id, userId, true, b.reason);
  }

  @Post('sellers/:userId/restore')
  @HttpCode(204)
  async restore(@CurrentUser() u: AuthUser, @Param('userId', uuid) userId: string, @Body(new ZodPipe(ReasonBody)) b: z.infer<typeof ReasonBody>) {
    await this.market.setSellerSuspended(u.id, userId, false, b.reason);
  }
}
