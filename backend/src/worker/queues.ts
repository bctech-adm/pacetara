/** Nama antrean BullMQ. Tambahkan di sini agar API dan worker memakai nama yang sama. */
export const QUEUES = {
  maintenance: 'maintenance',
} as const;

export const MAINTENANCE_JOBS = {
  heartbeat: 'heartbeat',
} as const;
