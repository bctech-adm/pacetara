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
import { PubSubOidcVerifier } from './subscriptions/oidc.js';
import { PlayApi } from './subscriptions/play-api.js';
import { SubscriptionQueue } from './subscriptions/subscription-queue.js';
import { AdminSubscriptionsController, PlayRtdnController, SubscriptionsController } from './subscriptions/subscriptions.controller.js';
import { SubscriptionsService } from './subscriptions/subscriptions.service.js';
import { UsersController } from './users/users.controller.js';
import { BuddiesController } from './buddies/buddies.controller.js';
import { BuddiesService } from './buddies/buddies.service.js';
import { CommunityStatsController, LeagueController } from './league/league.controller.js';
import { LeagueService } from './league/league.service.js';
import { CommunitySchedulesController, SessionsController } from './schedules/schedules.controller.js';
import { SchedulesService } from './schedules/schedules.service.js';
import { AdminSpotsController, SpotsController } from './spots/spots.controller.js';
import { SpotsService } from './spots/spots.service.js';
import { CommunityTreasuryController, JerseyController } from './treasury/treasury.controller.js';
import { TreasuryService } from './treasury/treasury.service.js';
import { UsersRepository } from './users/users.repository.js';
import { AdminKycController, KycController } from './kyc/kyc.controller.js';
import { KycEngine } from './kyc/kyc-engine.js';
import { KycService } from './kyc/kyc.service.js';
import { AdminMarketController, MarketController, XenditWebhookController } from './market/market.controller.js';
import { MarketOrderSync } from './market/market-orders.js';
import { MarketService } from './market/market.service.js';
import { XenditApi } from './market/xendit.js';
import { MidtransApi } from './payments/midtrans.js';
import { AdminPaymentsController, PaymentsController } from './payments/payments.controller.js';
import { PaymentsService } from './payments/payments.service.js';
import { UsersService } from './users/users.service.js';

@Module({
  imports: [
    CoreModule,
    // Batas global longgar; endpoint login/OTP/unggah memasang batas lebih ketat dengan @Throttle().
    // Storage Redis untuk throttler dipasang saat API berjalan >1 replika.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
  ],
  controllers: [HealthController, AuthController, UsersController, CommunitiesController, AppUpdateController, RunsController, LiveController, ChatController, ReportsController, AppealController, AdminAuthController, AdminController, EventsController, AdminEventsController, NotificationsController, InvitationsController, SafetyController, FeedController, PassportController, ImportsController, ImportWebhooksController, EventSubmissionsController, AdminEventQueueController, SubscriptionsController, PlayRtdnController, AdminSubscriptionsController,
    // Modul 2.6 Fitur komunitas lanjutan.
    CommunitySchedulesController, SessionsController, LeagueController, CommunityStatsController, BuddiesController, CommunityTreasuryController,
    JerseyController, SpotsController, AdminSpotsController,
    // Modul 3.1 Verifikasi Level 2.
    KycController, AdminKycController,
    // Modul 3.2 Marketplace (+ pembayaran Midtrans bersama 3.3).
    MarketController, XenditWebhookController, AdminMarketController, PaymentsController, AdminPaymentsController],
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
    PlayApi,
    PubSubOidcVerifier,
    SubscriptionQueue,
    SubscriptionsService,
    SchedulesService,
    LeagueService,
    BuddiesService,
    TreasuryService,
    SpotsService,
    KycEngine,
    KycService,
    MidtransApi,
    PaymentsService,
    XenditApi,
    MarketOrderSync,
    MarketService,
    ReportsService,
    ModerationService,
    AdminAuthService,
    AdminGuard,
    LevelGuard,
  ],
})
export class AppModule {}
