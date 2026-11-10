import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppUpdateController } from './app-update/app-update.controller.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { GoogleVerifier, Mailer, WhatsAppOtp } from './auth/channels.js';
import { CodesService } from './auth/codes.service.js';
import { LevelGuard } from './auth/level.guard.js';
import { CommunitiesController } from './communities/communities.controller.js';
import { CommunitiesService } from './communities/communities.service.js';
import { TokenService } from './auth/token.service.js';
import { CoreModule } from './core.module.js';
import { HealthController } from './health/health.controller.js';
import { StorageService } from './storage/storage.service.js';
import { UsersController } from './users/users.controller.js';
import { UsersRepository } from './users/users.repository.js';
import { UsersService } from './users/users.service.js';

@Module({
  imports: [
    CoreModule,
    // Batas global longgar; endpoint login/OTP/unggah memasang batas lebih ketat dengan @Throttle().
    // Storage Redis untuk throttler dipasang saat API berjalan >1 replika.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
  ],
  controllers: [HealthController, AuthController, UsersController, CommunitiesController, AppUpdateController],
  providers: [
    // Urutan penting: batas laju dulu, lalu autentikasi.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    TokenService,
    CodesService,
    Mailer,
    WhatsAppOtp,
    GoogleVerifier,
    AuthService,
    UsersRepository,
    UsersService,
    StorageService,
    CommunitiesService,
    LevelGuard,
  ],
})
export class AppModule {}
