import { Injectable, Logger } from '@nestjs/common';
import { CrmConfig } from './crm.config.js';

/**
 * Captcha of the public forms (Laravel `CaptchaVerifier`): off by default; Cloudflare Turnstile
 * when `FORMS_CAPTCHA_DRIVER=turnstile`. A network failure counts as a failed check.
 */
@Injectable()
export class CaptchaVerifier {
  private readonly logger = new Logger(CaptchaVerifier.name);
  /** Tests replace the HTTP call. */
  fetcher: typeof fetch = (...args) => fetch(...args);

  constructor(private readonly config: CrmConfig) {}

  enabled(): boolean {
    return this.config.captchaDriver === 'turnstile';
  }

  async verify(token: string, ip: string | undefined): Promise<boolean> {
    if (!this.enabled()) return true;
    if (!token || !this.config.turnstileSecret) return false;
    try {
      const body = new URLSearchParams({ secret: this.config.turnstileSecret, response: token });
      if (ip) body.set('remoteip', ip);
      const res = await this.fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(5000),
      });
      const json = (await res.json()) as { success?: boolean };
      return json.success === true;
    } catch (error) {
      this.logger.warn(`Captcha verification failed: ${(error as Error).message}`);
      return false;
    }
  }
}
