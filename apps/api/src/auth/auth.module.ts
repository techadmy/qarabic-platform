import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { CsrfGuard } from './csrf.guard.js';
import { PasswordsService } from './passwords.service.js';
import { RateLimitGuard } from './rate-limit.guard.js';
import { RateLimiterService } from './rate-limiter.service.js';
import { SessionsService } from './sessions.service.js';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordsService,
    SessionsService,
    RateLimiterService,
    // Global guards run in this order: CSRF, then session + permission, then rate limits.
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
  exports: [PasswordsService, SessionsService, RateLimiterService],
})
export class AuthModule {}
