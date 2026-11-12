import { createSign } from 'node:crypto';
import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';

/** One push to one device token. `data` values are strings (FCM rule). */
export interface PushMessage {
  token: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

/** `invalid`: the token is gone (app removed, token rotated) and should be forgotten. */
export interface PushResult {
  token: string;
  ok: boolean;
  invalid: boolean;
}

/** A push transport (docs/17 §5). */
export interface PushSender {
  readonly driver: 'none' | 'fake' | 'fcm';
  send(messages: readonly PushMessage[]): Promise<PushResult[]>;
}

/** `PUSH_DRIVER=none`: nothing leaves the server. */
export class NonePush implements PushSender {
  readonly driver = 'none' as const;
  send(messages: readonly PushMessage[]): Promise<PushResult[]> {
    return Promise.resolve(messages.map((m) => ({ token: m.token, ok: false, invalid: false })));
  }
}

/** `PUSH_DRIVER=fake` (tests, local): keeps the messages; tokens starting `invalid-` are gone. */
export class FakePush implements PushSender {
  readonly driver = 'fake' as const;
  readonly sent: PushMessage[] = [];

  send(messages: readonly PushMessage[]): Promise<PushResult[]> {
    return Promise.resolve(
      messages.map((m) => {
        const invalid = m.token.startsWith('invalid-');
        if (!invalid) this.sent.push(m);
        return { token: m.token, ok: !invalid, invalid };
      }),
    );
  }

  clear(): void {
    this.sent.length = 0;
  }
}

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  /** PEM; `\n` escapes are accepted (env files). */
  privateKey: string;
}

type Fetch = typeof fetch;
const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/**
 * Firebase Cloud Messaging HTTP v1 (Android and iOS through FCM): a service-account JWT is traded
 * for an OAuth token (cached until a minute before it expires), then one request per message.
 * 404 / `UNREGISTERED` / `INVALID_ARGUMENT` on the token marks it invalid.
 */
export class FcmPush implements PushSender {
  readonly driver = 'fcm' as const;
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly cfg: FcmConfig,
    private readonly http: Fetch = fetch,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  /** The signed service-account assertion (RS256). */
  assertion(): string {
    const iat = Math.floor(this.nowMs() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(
      JSON.stringify({
        iss: this.cfg.clientEmail,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat,
        exp: iat + 3600,
      }),
    );
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const key = this.cfg.privateKey.replace(/\\n/g, '\n');
    return `${header}.${claims}.${b64url(signer.sign(key))}`;
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > this.nowMs() + 60_000) {
      return this.accessToken.value;
    }
    const res = await this.http('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: this.assertion(),
      }).toString(),
    });
    if (!res.ok) throw new Error(`FCM auth failed (${res.status}).`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = {
      value: body.access_token,
      expiresAt: this.nowMs() + body.expires_in * 1000,
    };
    return body.access_token;
  }

  async send(messages: readonly PushMessage[]): Promise<PushResult[]> {
    if (messages.length === 0) return [];
    const bearer = await this.token();
    const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.cfg.projectId)}/messages:send`;
    const out: PushResult[] = [];
    for (const m of messages) {
      const res = await this.http(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: m.token,
            notification: { title: m.title, body: m.body },
            ...(m.data ? { data: m.data } : {}),
          },
        }),
      });
      let invalid = res.status === 404;
      if (!res.ok && !invalid) {
        const text = await res.text();
        invalid = /UNREGISTERED|registration-token-not-registered/.test(text);
      }
      out.push({ token: m.token, ok: res.ok, invalid });
    }
    return out;
  }
}

/** The configured sender (`PUSH_DRIVER`); tests swap it with `use()`. */
@Injectable()
export class PushGateway {
  private readonly logger = new Logger(PushGateway.name);
  private sender: PushSender;

  constructor(@Inject(ENV) env: Env) {
    this.sender =
      env.PUSH_DRIVER === 'fcm'
        ? new FcmPush({
            projectId: env.FCM_PROJECT_ID!,
            clientEmail: env.FCM_CLIENT_EMAIL!,
            privateKey: env.FCM_PRIVATE_KEY!,
          })
        : env.PUSH_DRIVER === 'fake'
          ? new FakePush()
          : new NonePush();
  }

  get driver(): PushSender['driver'] {
    return this.sender.driver;
  }

  use(sender: PushSender): void {
    this.sender = sender;
  }

  /** Never throws: a push failure must not undo the change that caused it. */
  async send(messages: readonly PushMessage[]): Promise<PushResult[]> {
    try {
      return await this.sender.send(messages);
    } catch (error) {
      this.logger.error(`Push not sent: ${(error as Error).message}`);
      return messages.map((m) => ({ token: m.token, ok: false, invalid: false }));
    }
  }
}

@Global()
@Module({ providers: [PushGateway], exports: [PushGateway] })
export class PushModule {}
