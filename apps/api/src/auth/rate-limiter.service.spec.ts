import { describe, expect, it } from 'vitest';
import { RateLimiterService } from './rate-limiter.service.js';

describe('RateLimiterService', () => {
  it('allows max hits per window, then asks to wait until the window ends', () => {
    const rl = new RateLimiterService();
    for (let i = 0; i < 5; i++) expect(rl.hit('k', 5, 60_000, 1_000)).toBe(0);
    expect(rl.hit('k', 5, 60_000, 31_000)).toBe(30);
    expect(rl.hit('other', 5, 60_000, 31_000)).toBe(0);
    expect(rl.hit('k', 5, 60_000, 61_000)).toBe(0);
  });
});
