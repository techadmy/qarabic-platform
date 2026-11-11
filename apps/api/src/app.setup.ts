import { type INestApplication, RequestMethod } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { CSRF_HEADER } from './auth/cookies.js';
import { ENV, type Env } from './config/env.js';

export const API_PREFIX = 'api/v1';

/** Shared by `main.ts` and the e2e tests, so tests run the real HTTP stack. */
export function configureApp(app: NestExpressApplication): INestApplication {
  const env = app.get<Env>(ENV);
  app.useLogger(app.get(Logger));
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');
  // The old public form endpoint keeps its URL (`POST /api/class-request`, D105).
  app.setGlobalPrefix(API_PREFIX, {
    exclude: [{ path: 'api/class-request', method: RequestMethod.POST }],
  });
  // same-site: the web app (app.qarabic.com) and the API (api.qarabic.com) share the site.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(cookieParser());
  app.enableCors({
    origin: env.WEB_ORIGIN,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Accept', 'X-Requested-With', CSRF_HEADER],
  });
  app.enableShutdownHooks();

  if (env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('Qarabic API')
      .setVersion('1')
      .addCookieAuth('qarabic_session')
      .build();
    SwaggerModule.setup('api/docs', app, () => SwaggerModule.createDocument(app, config));
  }
  return app;
}
