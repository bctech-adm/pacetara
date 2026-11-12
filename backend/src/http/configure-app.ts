import type { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';
import helmet from 'helmet';
import type { Env } from '../config/env.js';
import { rejectInsecure } from './reject-insecure.js';

/** Pengaturan HTTP bersama untuk main.ts dan tes end-to-end. */
export function configureApp(app: NestExpressApplication, env: Env): void {
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(rejectInsecure(env));
  // Push Garmin bisa membawa detail aktivitas beserta titik GPS (modul 2.3): batas lebih besar hanya di rute itu,
  // sejalan dengan batas body Traefik 15 MB (#131). Parser global di bawah melewati body yang sudah diparse.
  app.use('/v1/imports/garmin/push', json({ limit: '15mb' }));
  app.useBodyParser('json', { limit: '1mb' });

  const origins = env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins, credentials: false });

  app.setGlobalPrefix('v1', { exclude: ['health', 'health/live'] });
}
