/** Nama antrean BullMQ. Tambahkan di sini agar API dan worker memakai nama yang sama. */
export const QUEUES = {
  maintenance: 'maintenance',
  notifications: 'notifications',
  imports: 'imports',
  subscriptions: 'subscriptions',
} as const;

export const MAINTENANCE_JOBS = {
  heartbeat: 'heartbeat',
  chatImageExpiry: 'chat-image-expiry',
  eventArchive: 'event-archive',
  eventScrape: 'event-scrape',
  subscriptionReconcile: 'subscription-reconcile',
  communitySessions: 'community-sessions',
  leagueSnapshot: 'league-snapshot',
  // Modul 3.1: tinjauan verifikasi KTP > 30 hari kedaluwarsa.
  kycReviewExpiry: 'kyc-review-expiry',
  // Modul 3.2/3.3: pesanan marketplace (kedaluwarsa, selesai otomatis), listing lewat masa tayang, rekonsiliasi Midtrans.
  marketMaintenance: 'market-maintenance',
} as const;

/** Job di antrean notifications: satu kiriman push ke beberapa pengguna. */
export const PUSH_JOB = 'push';

/** Job di antrean imports (modul 2.3): tarik/olah aktivitas Garmin dan Strava. */
export const IMPORT_JOB = 'import';

/** Antrean langganan (modul 2.5): sinkron satu purchaseToken ke Google Play (dari RTDN). */
export const SUBSCRIPTION_JOB = 'play-sync';
