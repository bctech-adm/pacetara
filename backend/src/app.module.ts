import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AdminAuthController, AdminController } from './admin/admin.controller.js';
import { AdminAuthService, AdminGuard } from './admin/admin-auth.service.js';
import { ModerationService } from './admin/moderation.service.js';
import { AppUpdateController } from './app-update/app-update.controller.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { GoogleVerifier, Mailer, WhatsAppOtp } from './auth/channels.js';
import { CodesService } from './auth/codes.service.js';
import { LevelGuard } from './auth/level.guard.js';
import { ChatController } from './chat/chat.controller.js';
import { ChatService } from './chat/chat.service.js';
import { CommunitiesController, InvitationsController } from './communities/communities.controller.js';
import { CommunitiesService } from './communities/communities.service.js';
import { TokenService } from './auth/token.service.js';
import { CoreModule } from './core.module.js';
import { EventScraper } from './event-engine/event-scraper.js';
import { AdminEventQueueController, EventSubmissionsController } from './event-engine/event-submissions.controller.js';
import { EventSubmissionsService } from './event-engine/event-submissions.service.js';
import { ScrapeHttp } from './event-engine/scrape-http.js';
import { AdminEventsController, EventsController } from './events/events.controller.js';
import { EventsService } from './events/events.service.js';
import { FeedController } from './feed/feed.controller.js';
import { FeedService } from './feed/feed.service.js';
import { NotificationsController } from './notifications/notifications.controller.js';
import { NotificationsService } from './notifications/notifications.service.js';
import { PushQueue } from './notifications/push.js';
import { BadgesService } from './passport/badges.service.js';
import { PassportController } from './passport/passport.controller.js';
import { PassportService } from './passport/passport.service.js';
import { StatsService } from './passport/stats.service.js';
import { SafetyController } from './safety/safety.controller.js';
import { SafetyService } from './safety/safety.service.js';
import { HealthController } from './health/health.controller.js';
import { ImportQueue } from './imports/import-queue.js';
import { ImportWriter } from './imports/import-writer.js';
import { ImportsController, ImportWebhooksController } from './imports/imports.controller.js';
import { ImportsService } from './imports/imports.service.js';
import { ProviderHttp } from './imports/provider-http.js';
import { UserThrottlerGuard } from './http/user-throttler.guard.js';
import { LiveController } from './live/live.controller.js';
import { LiveService } from './live/live.service.js';
import { RealtimeService } from './realtime/realtime.service.js';
import { AppealController, ReportsController } from './moderation/reports.controller.js';
import { ReportsService } from './moderation/reports.service.js';
import { RunsController } from './runs/runs.controller.js';
import { RunsService } from './runs/runs.service.js';
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
  controllers: [HealthController, AuthController, UsersController, CommunitiesController, AppUpdateController, RunsController, LiveController, ChatController, ReportsController, AppealController, AdminAuthController, AdminController, EventsController, AdminEventsController, NotificationsController, InvitationsController, SafetyController, FeedController, PassportController, ImportsController, ImportWebhooksController, EventSubmissionsController, AdminEventQueueController],
  providers: [
    // Urutan penting: batas laju dulu, lalu autentikasi.
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
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
    RunsService,
    RealtimeService,
    LiveService,
    ChatService,
    EventsService,
    EventSubmissionsService,
    ScrapeHttp,
    EventScraper,
    NotificationsService,
    PushQueue,
    SafetyService,
    FeedService,
    BadgesService,
    PassportService,
    StatsService,
    ProviderHttp,
    ImportWriter,
    ImportQueue,
    ImportsService,
    ReportsService,
    ModerationService,
    AdminAuthService,
    AdminGuard,
    LevelGuard,
  ],
})
export class AppModule {}
