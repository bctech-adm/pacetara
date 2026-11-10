import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { ENV, type Env } from './config/env.js';
import { rejectInsecure } from './http/reject-insecure.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const env = app.get<Env>(ENV);

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
  app.enableShutdownHooks();

  await app.listen(env.PORT, '0.0.0.0');
  Logger.log(`API siap di port ${env.PORT} (${env.NODE_ENV})`, 'Bootstrap');
}

void bootstrap();
