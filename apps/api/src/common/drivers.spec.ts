import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { envSchema } from '../config/env.js';
import { FakePush, FcmPush } from './push.js';
import { assertKey, S3Storage } from './storage.js';

type Call = { url: string; init: RequestInit };

/** A fetch double: records calls and answers with the next queued response. */
function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const fn = ((url: URL | string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(responses.shift() ?? new Response(null, { status: 200 }));
  }) as typeof fetch;
  return { fn, calls };
}

const s3 = (fetchFn: typeof fetch) =>
  new S3Storage(
    {
      endpoint: 'https://fra1.digitaloceanspaces.example',
      region: 'fra1',
      bucket: 'qarabic-files',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      signedUrlTtl: 300,
    },
    fetchFn,
    () => new Date('2026-11-12T10:00:00Z'),
  );

describe('S3 storage driver (docs/17 §5)', () => {
  it('signs PUT with SigV4 headers, path-style, and never sends the secret', async () => {
    const { fn, calls } = fakeFetch([new Response(null, { status: 200 })]);
    await s3(fn).put('tickets/1/a.png', Buffer.from('png'), 'image/png');
    const [call] = calls;
    expect(call!.url).toBe('https://fra1.digitaloceanspaces.example/qarabic-files/tickets/1/a.png');
    expect(call!.init.method).toBe('PUT');
    const h = call!.init.headers as Record<string, string>;
    expect(h['x-amz-date']).toBe('20261112T100000Z');
    expect(h['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(h.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261112\/fra1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(JSON.stringify(call)).not.toContain('wJalrXUtnFEMI');
  });

  it('GET returns the bytes, a 404 is null, other errors throw; DELETE tolerates 404', async () => {
    const { fn } = fakeFetch([
      new Response('hello', { status: 200 }),
      new Response(null, { status: 404 }),
      new Response(null, { status: 403 }),
      new Response(null, { status: 404 }),
    ]);
    const store = s3(fn);
    expect((await store.get('a/b.txt'))?.toString()).toBe('hello');
    expect(await store.get('a/missing.txt')).toBeNull();
    await expect(store.get('a/denied.txt')).rejects.toThrow('403');
    await expect(store.delete('a/gone.txt')).resolves.toBeUndefined();
  });

  it('hands out a query-signed temporary link and refuses unsafe keys', () => {
    const url = new URL(s3(fakeFetch([]).fn).signedUrl('tickets/1/a.png', 120));
    expect(url.pathname).toBe('/qarabic-files/tickets/1/a.png');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'AKIDEXAMPLE/20261112/fra1/s3/aws4_request',
    );
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    for (const bad of ['../etc/passwd', '/abs', 'a b', 'a/../b']) {
      expect(() => assertKey(bad)).toThrow();
    }
  });
});

describe('push drivers', () => {
  it('fake: keeps messages, reports `invalid-` tokens gone', async () => {
    const fake = new FakePush();
    const r = await fake.send([
      { token: 'good-token-123', title: 't', body: 'b' },
      { token: 'invalid-token', title: 't', body: 'b' },
    ]);
    expect(r.map((x) => [x.ok, x.invalid])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(fake.sent).toHaveLength(1);
  });

  it('fcm: signs an RS256 assertion, caches the OAuth token, marks UNREGISTERED tokens', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString()
      .replace(/\n/g, '\\n');
    const { fn, calls } = fakeFetch([
      Response.json({ access_token: 'ya29.test', expires_in: 3600 }),
      Response.json({ name: 'projects/p/messages/1' }),
      new Response('{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}', {
        status: 404,
      }),
      Response.json({ name: 'projects/p/messages/2' }),
    ]);
    const fcm = new FcmPush(
      { projectId: 'qarabic-test', clientEmail: 'push@qarabic-test.iam.example', privateKey: pem },
      fn,
      () => Date.parse('2026-11-12T10:00:00Z'),
    );
    const first = await fcm.send([
      { token: 'tok-a', title: 'Hi', body: 'B', data: { taskId: '3' } },
      { token: 'tok-gone', title: 'Hi', body: 'B' },
    ]);
    expect(first).toEqual([
      { token: 'tok-a', ok: true, invalid: false },
      { token: 'tok-gone', ok: false, invalid: true },
    ]);
    await fcm.send([{ token: 'tok-b', title: 'Again', body: 'B' }]);
    expect(calls.filter((c) => c.url.includes('oauth2')).length).toBe(1);
    expect(calls[1]!.url).toBe('https://fcm.googleapis.com/v1/projects/qarabic-test/messages:send');
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({
      message: { token: 'tok-a', notification: { title: 'Hi', body: 'B' }, data: { taskId: '3' } },
    });
    const assertion = new URLSearchParams(calls[0]!.init.body as string).get('assertion')!;
    const [h, c, sig] = assertion.split('.');
    const verify = createVerify('RSA-SHA256');
    verify.update(`${h}.${c}`);
    expect(verify.verify(publicKey, Buffer.from(sig!, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toMatchObject({
      iss: 'push@qarabic-test.iam.example',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
    });
  });
});

describe('env rules for the drivers', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/x',
    WEB_ORIGIN: 'http://localhost:3000',
    SESSION_SECRET: 'x'.repeat(40),
    APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  };
  it('defaults to local storage and no push; s3 / fcm need their keys', () => {
    const env = envSchema.parse(base);
    expect([env.STORAGE_DRIVER, env.PUSH_DRIVER]).toEqual(['local', 'none']);
    const s3Missing = envSchema.safeParse({ ...base, STORAGE_DRIVER: 's3' });
    expect(s3Missing.success).toBe(false);
    expect(s3Missing.error!.issues.map((i) => i.path[0]).sort()).toEqual([
      'S3_ACCESS_KEY_ID',
      'S3_BUCKET',
      'S3_ENDPOINT',
      'S3_SECRET_ACCESS_KEY',
    ]);
    expect(envSchema.safeParse({ ...base, PUSH_DRIVER: 'fcm' }).success).toBe(false);
    expect(
      envSchema.safeParse({
        ...base,
        STORAGE_DRIVER: 's3',
        S3_ENDPOINT: 'https://fra1.digitaloceanspaces.example',
        S3_BUCKET: 'b',
        S3_ACCESS_KEY_ID: 'k',
        S3_SECRET_ACCESS_KEY: 's',
      }).success,
    ).toBe(true);
  });
});
