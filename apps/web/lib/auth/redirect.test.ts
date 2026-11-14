import { describe, expect, it } from 'vitest';
import { loginPathFor, safeNextPath } from './redirect';

describe('safeNextPath', () => {
  it.each(['/roles?tab=all', '/families/3#notes', '/leads?q=a%20b', '/search?q=a%5Cb'])(
    'keeps the same-site path %s',
    (value) => expect(safeNextPath(value)).toBe(value),
  );

  it.each([
    null,
    undefined,
    '',
    'roles',
    'https://evil.test',
    'https:evil.test',
    '//evil.test',
    '/\\evil.test',
    // docs/39 P0-1: control characters and encoded slashes that URL parsing turns into `//`.
    '/%09/evil.test',
    '/\t/evil.test',
    '/\n/evil.test',
    '/\r/evil.test',
    '/%0a/evil.test',
    '/%5C/evil.test',
    '/%5c%5cevil.test',
    '/%2F/evil.test',
    '/%252F/evil.test',
    '/%E0%A4%A',
    '/login',
    '/login?next=/roles',
  ])('falls back to home for %j', (value) => expect(safeNextPath(value)).toBe('/'));

  it('never leaves the origin, whatever the input', () => {
    for (const value of ['/%09/evil.test', '/\t/evil.test', '/%5C/evil.test']) {
      // The old check passed these; the browser would have gone to evil.test.
      expect(new URL(safeNextPath(value), 'https://app.test').origin).toBe('https://app.test');
    }
  });
});

describe('loginPathFor', () => {
  it('adds next only when it is not home', () => {
    expect(loginPathFor('/')).toBe('/login');
    expect(loginPathFor('/roles', '?a=1')).toBe('/login?next=%2Froles%3Fa%3D1');
  });
});
