import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { ENV, type Env } from './config/env.js';
import { configureApp } from './http/configure-app.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const env = app.get<Env>(ENV);
  configureApp(app, env);
  app.enableShutdownHooks();

  await app.listen(env.PORT, '0.0.0.0');
  Logger.log(`API siap di port ${env.PORT} (${env.NODE_ENV})`, 'Bootstrap');
}

void bootstrap();
