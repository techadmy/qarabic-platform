import { Controller, HttpCode, HttpStatus, Logger, Post, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public, SkipCsrf } from '../auth/decorators.js';
import { RateLimiterService } from '../auth/rate-limiter.service.js';
import { Clock } from '../common/clock.js';
import { ApiException, notFound } from '../common/errors.js';
import { signatureValid, urlValidation, ZoomAttendance, type ZoomBody } from './zoom.attendance.js';
import { ZoomConfig } from './zoom.config.js';

/**
 * `POST /integrations/zoom/webhook` (Z1, docs/42 §6). The one public route without `@Can`: Zoom
 * cannot sign in, so every request must carry a valid `x-zm-signature` (HMAC-SHA256 with the
 * app's secret token over the raw body) with a timestamp under 5 minutes old, else 401 (429 after
 * repeated failures from one IP; signed requests are never limited). 404 while
 * tracking is off. Answers Zoom's URL validation; otherwise stores the event and answers 200 at
 * once (Zoom wants < 3 s); processing runs in the background.
 */
/** Invalid requests allowed per IP per minute before 429 (valid ones are never limited). */
export const FAILURES_PER_MINUTE = 20;

@ApiExcludeController()
@Controller('integrations/zoom/webhook')
export class ZoomWebhookController {
  private readonly logger = new Logger(ZoomWebhookController.name);

  constructor(
    private readonly config: ZoomConfig,
    private readonly attendance: ZoomAttendance,
    private readonly clock: Clock,
    private readonly limiter: RateLimiterService,
  ) {}

  @Public()
  @SkipCsrf()
  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: Request & { rawBody?: Buffer },
  ): Promise<{ ok: true } | { plainToken: string; encryptedToken: string }> {
    if (!this.config.enabled) throw notFound();
    const secret = this.config.webhookSecret!;
    if (
      !signatureValid(
        secret,
        req.get('x-zm-request-timestamp'),
        req.get('x-zm-signature'),
        req.rawBody,
        this.clock.nowMs(),
      )
    ) {
      // Its own policy (review P2): only failures count, per IP, so a flood of forged requests
      // never starves Zoom's real (signed) events. Needs TRUST_PROXY right behind nginx (B120).
      const wait = await this.limiter.hit(
        `zoom-webhook-fail:${req.ip}`,
        FAILURES_PER_MINUTE,
        60_000,
        this.clock.nowMs(),
      );
      if (wait > 0) {
        throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, {
          message: 'Too many invalid requests.',
          code: 'rate_limited',
        });
      }
      throw new ApiException(HttpStatus.UNAUTHORIZED, {
        message: 'Invalid signature.',
        code: 'invalid_signature',
      });
    }
    const body = (req.body ?? {}) as {
      event?: string;
      payload?: { plainToken?: unknown };
    };
    if (body.event === 'endpoint.url_validation') {
      const token = typeof body.payload?.plainToken === 'string' ? body.payload.plainToken : '';
      return urlValidation(secret, token.slice(0, 200));
    }
    await this.attendance.store(body as ZoomBody);
    setImmediate(() => {
      this.attendance
        .processPending()
        .catch((e: unknown) => this.logger.error('zoom processing failed', e as Error));
    });
    return { ok: true };
  }
}
