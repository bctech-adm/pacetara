/** Nama antrean BullMQ. Tambahkan di sini agar API dan worker memakai nama yang sama. */
export const QUEUES = {
  maintenance: 'maintenance',
  notifications: 'notifications',
} as const;

export const MAINTENANCE_JOBS = {
  heartbeat: 'heartbeat',
  chatImageExpiry: 'chat-image-expiry',
  eventArchive: 'event-archive',
} as const;

/** Job di antrean notifications: satu kiriman push ke beberapa pengguna. */
export const PUSH_JOB = 'push';
