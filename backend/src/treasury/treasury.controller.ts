import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { LevelGuard, RequireLevel } from '../auth/level.guard.js';
import { type AuthUser, CurrentUser, ZodPipe } from '../common/http.js';
import { CASH_CATEGORIES, TreasuryService } from './treasury.service.js';

const uuid = new ParseUUIDPipe();
const date = z.string().regex(/^20\d\d-\d\d-\d\d$/, 'Format tanggal YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Tanggal tidak valid');
const CashBody = z
  .object({
    kind: z.enum(['in', 'out']),
    // Rupiah bulat, tanpa desimal.
    amount: z.number().int().min(1).max(1_000_000_000_000),
    category: z.enum(CASH_CATEGORIES),
    occurredOn: date,
    description: z.string().trim().max(200).optional(),
  })
  .strict();
const CashPatch = CashBody.partial().strict();
const PageQuery = z.object({ page: z.coerce.number().int().min(1).max(200).default(1) });
const size = z.string().trim().min(1).max(10);
const ItemBody = z
  .object({
    name: z.string().trim().min(3, 'Nama minimal 3 karakter').max(80),
    description: z.string().trim().max(500).optional(),
    price: z.number().int().min(0).max(100_000_000),
    sizes: z.array(size).min(1, 'Minimal satu ukuran').max(12).refine((a) => new Set(a).size === a.length, 'Ukuran tidak boleh ganda'),
    orderDeadline: z.coerce.date(),
  })
  .strict();
const ItemPatch = ItemBody.partial().extend({ closed: z.boolean().optional() }).strict();
const OrderBody = z.object({ size, quantity: z.number().int().min(1).max(20), note: z.string().trim().max(200).optional() }).strict();
const PaidBody = z.object({ paid: z.boolean() }).strict();

/** Kas komunitas dan pre-order jersey (modul 2.6, Komunitas Pro, pencatatan saja). */
@Controller('communities/:id')
@UseGuards(LevelGuard)
@RequireLevel(1)
export class CommunityTreasuryController {
  constructor(private readonly treasury: TreasuryService) {}

  @Get('cash')
  cash(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Query(new ZodPipe(PageQuery)) q: z.infer<typeof PageQuery>) {
    return this.treasury.cash(u.id, id, q.page);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('cash')
  addCash(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(CashBody)) b: z.infer<typeof CashBody>) {
    return this.treasury.addCash(u.id, id, b);
  }

  @Patch('cash/:entryId')
  updateCash(
    @CurrentUser() u: AuthUser,
    @Param('id', uuid) id: string,
    @Param('entryId', uuid) entryId: string,
    @Body(new ZodPipe(CashPatch)) b: z.infer<typeof CashPatch>,
  ) {
    return this.treasury.updateCash(u.id, id, entryId, b);
  }

  @Delete('cash/:entryId')
  @HttpCode(204)
  async deleteCash(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Param('entryId', uuid) entryId: string) {
    await this.treasury.deleteCash(u.id, id, entryId);
  }

  @Get('jersey')
  jersey(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.treasury.jerseyItems(u.id, id);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('jersey')
  createItem(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(ItemBody)) b: z.infer<typeof ItemBody>) {
    return this.treasury.createItem(u.id, id, b);
  }
}

@Controller('jersey')
@UseGuards(LevelGuard)
@RequireLevel(1)
export class JerseyController {
  constructor(private readonly treasury: TreasuryService) {}

  @Patch('items/:id')
  updateItem(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(ItemPatch)) b: z.infer<typeof ItemPatch>) {
    return this.treasury.updateItem(u.id, id, b);
  }

  @Delete('items/:id')
  @HttpCode(204)
  async deleteItem(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.treasury.deleteItem(u.id, id);
  }

  @Get('items/:id/orders')
  orders(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.treasury.orders(u.id, id);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('items/:id/orders')
  @HttpCode(200)
  order(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(OrderBody)) b: z.infer<typeof OrderBody>) {
    return this.treasury.placeOrder(u.id, id, b);
  }

  @Delete('orders/:id')
  @HttpCode(204)
  async cancel(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.treasury.deleteOrder(u.id, id);
  }

  @Post('orders/:id/paid')
  @HttpCode(200)
  paid(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(PaidBody)) b: z.infer<typeof PaidBody>) {
    return this.treasury.markPaid(u.id, id, b.paid);
  }
}
