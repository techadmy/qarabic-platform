import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';

/**
 * Z1 (docs/42 §6): the Server-to-Server app's keys from the environment (never logged). Off unless
 * ZOOM_DRIVER=s2s with all four keys, which the owner sets on the server (B129). Tests use
 * `use()` / `reset()`.
 */
@Injectable()
export class ZoomConfig {
  accountId: string | null = null;
  clientId: string | null = null;
  clientSecret: string | null = null;
  webhookSecret: string | null = null;
  private driver: Env['ZOOM_DRIVER'] = 'none';

  constructor(@Inject(ENV) private readonly env: Env) {
    this.reset();
  }

  reset(): void {
    this.driver = this.env.ZOOM_DRIVER;
    this.accountId = this.env.ZOOM_ACCOUNT_ID ?? null;
    this.clientId = this.env.ZOOM_CLIENT_ID ?? null;
    this.clientSecret = this.env.ZOOM_CLIENT_SECRET ?? null;
    this.webhookSecret = this.env.ZOOM_WEBHOOK_SECRET ?? null;
  }

  /** Tests: switch tracking on with throwaway keys. */
  use(keys: {
    accountId: string;
    clientId: string;
    clientSecret: string;
    webhookSecret: string;
  }): void {
    this.driver = 's2s';
    Object.assign(this, keys);
  }

  /** Attendance tracking (webhook + reports) is on. */
  get enabled(): boolean {
    return (
      this.driver === 's2s' &&
      !!this.accountId &&
      !!this.clientId &&
      !!this.clientSecret &&
      !!this.webhookSecret
    );
  }
}
