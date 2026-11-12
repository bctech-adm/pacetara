import type { Point } from '../runs/geo.js';
import type { RunVisibility } from '../runs/runs.service.js';

export type ImportSource = 'health_connect' | 'garmin' | 'strava';
export type OAuthProvider = 'garmin' | 'strava';

/** Lari dari sumber luar, sebelum diproses server (zona privasi, enkripsi, deduplikasi). */
export interface ImportedRun {
  source: ImportSource;
  /** Id aktivitas di sumbernya (Health Connect metadata id, Garmin activityId, Strava activity id). */
  externalId: string;
  title: string;
  startedAt: Date;
  endedAt: Date;
  /** Rute (detik sejak startedAt). Kosong = tidak ada rute: statistik yang dilaporkan dipakai. */
  segments: Point[][];
  /** Statistik menurut sumber; dipakai hanya jika rute tidak ada atau tidak bisa dihitung. */
  reported: { distanceM: number | null; movingTimeS: number | null; elevationGainM: number | null };
  visibility: RunVisibility;
}

export type ImportStatus = 'imported' | 'updated' | 'duplicate' | 'already_imported' | 'skipped';

export interface ImportResult {
  status: ImportStatus;
  runId: string | null;
  reason?: string;
}

/**
 * Job di antrean `imports` (diproses worker). Token tidak pernah masuk antrean. Data aktivitas dari push
 * Garmin (bisa berisi rute) disimpan terenkripsi FieldCrypto (`payload`, base64).
 */
export type ImportJob =
  | { kind: 'garmin-pull'; userId: string; callbackUrl: string }
  | { kind: 'garmin-push'; userId: string; payload: string }
  | { kind: 'garmin-deregister'; userId: string }
  | { kind: 'strava-activity'; userId: string; activityId: string; aspect: 'create' | 'update' | 'delete' }
  | { kind: 'strava-deauth'; userId: string }
  | { kind: 'strava-sync'; userId: string };

/** Jenis aktivitas yang dianggap lari. */
export const isGarminRun = (type: unknown) => typeof type === 'string' && /RUN/i.test(type);
export const isStravaRun = (type: unknown) => typeof type === 'string' && ['Run', 'TrailRun', 'VirtualRun'].includes(type);
