import { describe, expect, it } from 'vitest';
import { csrfBinding, randomToken, sha256, signCsrf, verifyCsrf } from './tokens.js';

describe('tokens', () => {
  it('makes 43-char url-safe random tokens and hex sha256', () => {
    expect(randomToken()).toMatch(/^[\w-]{43}$/);
    expect(sha256('a')).toHaveLength(64);
  });

  it('signs and verifies CSRF tokens with the secret', () => {
    const a = csrfBinding('session-a');
    const t = signCsrf('s'.repeat(32), a);
    expect(verifyCsrf('s'.repeat(32), a, t)).toBe(true);
    expect(verifyCsrf('o'.repeat(32), a, t)).toBe(false);
    expect(verifyCsrf('s'.repeat(32), a, `${t}x`)).toBe(false);
    expect(verifyCsrf('s'.repeat(32), a, 'no-dot')).toBe(false);
    // P2-3: bound to its session (and `anon` before sign-in).
    expect(verifyCsrf('s'.repeat(32), csrfBinding('session-b'), t)).toBe(false);
    expect(verifyCsrf('s'.repeat(32), csrfBinding(null), t)).toBe(false);
    expect(csrfBinding(undefined)).toBe('anon');
  });
});
