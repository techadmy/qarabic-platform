import { describe, expect, it } from 'vitest';
import { loginPathFor, safeNextPath } from './redirect';

describe('safeNextPath', () => {
  it('keeps same-site paths', () => {
    expect(safeNextPath('/roles?tab=all')).toBe('/roles?tab=all');
  });
  it.each([null, '', 'https://evil.test', '//evil.test', '/\\evil.test', 'roles', '/login'])(
    'falls back to home for %s',
    (value) => expect(safeNextPath(value)).toBe('/'),
  );
});

describe('loginPathFor', () => {
  it('adds next only when it is not home', () => {
    expect(loginPathFor('/')).toBe('/login');
    expect(loginPathFor('/roles', '?a=1')).toBe('/login?next=%2Froles%3Fa%3D1');
  });
});
