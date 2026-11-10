import type { NextFunction, Request, Response } from 'express';
import type { Env } from '../config/env.js';

/**
 * Di produksi, tolak permintaan yang tidak datang lewat HTTPS (X-Forwarded-Proto dari Caddy,
 * dibaca Express lewat `trust proxy`). Healthcheck internal container dikecualikan.
 */
export function rejectInsecure(env: Pick<Env, 'NODE_ENV'>) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (env.NODE_ENV !== 'production' || req.path.startsWith('/health') || req.secure) return next();
    res.status(403).json({ statusCode: 403, message: 'HTTPS diperlukan' });
  };
}
