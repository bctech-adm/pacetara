import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CoreModule } from './core.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [
    CoreModule,
    // Batas global longgar; endpoint login/OTP/pencarian/unggah memasang batas lebih ketat
    // dengan @Throttle() di modulnya. Storage Redis dipasang saat API berjalan >1 replika.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
