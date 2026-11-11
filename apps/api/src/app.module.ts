import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AccountModule } from './account/account.module.js';
import { AuditModule } from './audit/audit.service.js';
import { AuthModule } from './auth/auth.module.js';
import { HttpExceptionFilter } from './common/http-exception.filter.js';
import { ConfigModule } from './config/config.module.js';
import { ENV, type Env } from './config/env.js';
import { HealthController } from './health/health.controller.js';
import { MailModule } from './mail/mailer.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { PeopleModule } from './people/people.module.js';
import { RolesModule } from './roles/roles.module.js';
import { SettingsModule } from './settings/settings.service.js';

/** Never logged: credentials, cookies, tokens. */
export const REDACT = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-xsrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.passwordHash',
];

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
          redact: { paths: REDACT, censor: '[redacted]' },
          autoLogging: { ignore: (req) => req.url?.endsWith('/health') ?? false },
          ...(env.NODE_ENV === 'development'
            ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
            : {}),
        },
      }),
    }),
    PrismaModule,
    MailModule,
    AuditModule,
    SettingsModule,
    AuthModule,
    AccountModule,
    RolesModule,
    PeopleModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: HttpExceptionFilter }],
})
export class AppModule {}
