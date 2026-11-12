/** Nama antrean BullMQ. Tambahkan di sini agar API dan worker memakai nama yang sama. */
export const QUEUES = {
  maintenance: 'maintenance',
  notifications: 'notifications',
  imports: 'imports',
} as const;

export const MAINTENANCE_JOBS = {
  heartbeat: 'heartbeat',
  chatImageExpiry: 'chat-image-expiry',
  eventArchive: 'event-archive',
  eventScrape: 'event-scrape',
} as const;

/** Job di antrean notifications: satu kiriman push ke beberapa pengguna. */
export const PUSH_JOB = 'push';

/** Job di antrean imports (modul 2.3): tarik/olah aktivitas Garmin dan Strava. */
export const IMPORT_JOB = 'import';
