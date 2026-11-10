import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import type { Env } from '../config/env.js';
import { rejectInsecure } from './reject-insecure.js';

/** Pengaturan HTTP bersama untuk main.ts dan tes end-to-end. */
export function configureApp(app: NestExpressApplication, env: Env): void {
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(rejectInsecure(env));
  app.useBodyParser('json', { limit: '1mb' });

  const origins = env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins, credentials: false });

  app.setGlobalPrefix('v1', { exclude: ['health', 'health/live'] });
}
