import { describe, expect, it } from 'vitest';
import { apiOriginOf, contentSecurityPolicy } from './csp';

describe('contentSecurityPolicy', () => {
  const prod = contentSecurityPolicy({
    nonce: 'abc',
    apiOrigin: 'https://api.qarabic.com',
    dev: false,
  });

  it('allows scripts only by nonce, with strict-dynamic, and no eval in production', () => {
    expect(prod).toContain(`script-src 'self' 'nonce-abc' 'strict-dynamic'`);
    expect(prod).not.toContain('unsafe-eval');
  });

  it('refuses framing, plugins and foreign base or form targets', () => {
    for (const d of [
      `frame-ancestors 'none'`,
      `object-src 'none'`,
      `frame-src 'none'`,
      `base-uri 'self'`,
      `form-action 'self'`,
      'upgrade-insecure-requests',
    ]) {
      expect(prod).toContain(d);
    }
  });

  it('lets the app call and show images from its API origin only', () => {
    expect(prod).toContain(`connect-src 'self' https://api.qarabic.com`);
    expect(prod).toContain(`img-src 'self' blob: data: https://api.qarabic.com`);
  });

  it('allows eval and the dev socket only in development', () => {
    const dev = contentSecurityPolicy({ nonce: 'n', apiOrigin: null, dev: true });
    expect(dev).toContain(`'unsafe-eval'`);
    expect(dev).toContain(`connect-src 'self' ws: wss:`);
    expect(dev).not.toContain('upgrade-insecure-requests');
  });
});

describe('upgrade-insecure-requests', () => {
  it('is left out when the API is plain http (server rehearsal, e2e builds)', () => {
    for (const apiOrigin of ['http://localhost:4200', null]) {
      expect(contentSecurityPolicy({ nonce: 'n', apiOrigin, dev: false })).not.toContain(
        'upgrade-insecure-requests',
      );
    }
  });
});

describe('apiOriginOf', () => {
  it.each([
    ['https://api.qarabic.com/api/v1', 'https://api.qarabic.com'],
    ['http://localhost:3272', 'http://localhost:3272'],
    ['', null],
    [undefined, null],
    ['/api', null],
  ])('%j → %j', (url, origin) => expect(apiOriginOf(url)).toBe(origin));
});
