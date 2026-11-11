import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { ENV, type Env } from './config/env.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // The WhatsApp webhook signature is computed over the raw body.
    rawBody: true,
  });
  configureApp(app);
  await app.listen(app.get<Env>(ENV).PORT);
}

void bootstrap();
