import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AdminGuard } from '../admin/admin-auth.service.js';
import { type AuthUser, CurrentUser, Public, ZodPipe } from '../common/http.js';
import { PaymentsService } from './payments.service.js';

const AdminQuery = z.object({ status: z.enum(['all', 'pending', 'paid', 'failed', 'expired', 'refunded']).default('all') });

/** Pembayaran Midtrans milik pengguna (dasbor web) dan notifikasi HTTP Midtrans. */
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('mine')
  mine(@CurrentUser() u: AuthUser) {
    return this.payments.mine(u.id);
  }

  /**
   * Payment Notification URL di dasbor Midtrans. Publik; signature_key diperiksa sebelum apa pun, status diambil
   * ulang dari API Midtrans. Menjawab 200 agar Midtrans berhenti mengulang; galat 5xx membuat Midtrans mengulang.
   */
  @Public()
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Post('midtrans/notification')
  @HttpCode(200)
  async notification(@Body() body: Record<string, unknown>) {
    await this.payments.handleNotification(body ?? {});
    return { ok: true };
  }
}

@Controller('admin/payments')
@UseGuards(AdminGuard)
export class AdminPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  list(@Query(new ZodPipe(AdminQuery)) q: z.infer<typeof AdminQuery>) {
    return this.payments.adminList(q.status);
  }
}
