import { describe, expect, it } from 'vitest';
import { randomToken, sha256, signCsrf, verifyCsrf } from './tokens.js';

describe('tokens', () => {
  it('makes 43-char url-safe random tokens and hex sha256', () => {
    expect(randomToken()).toMatch(/^[\w-]{43}$/);
    expect(sha256('a')).toHaveLength(64);
  });

  it('signs and verifies CSRF tokens with the secret', () => {
    const t = signCsrf('s'.repeat(32));
    expect(verifyCsrf('s'.repeat(32), t)).toBe(true);
    expect(verifyCsrf('o'.repeat(32), t)).toBe(false);
    expect(verifyCsrf('s'.repeat(32), `${t}x`)).toBe(false);
    expect(verifyCsrf('s'.repeat(32), 'no-dot')).toBe(false);
  });
});
