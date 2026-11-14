import { describe, expect, it } from 'vitest';
import { RateLimiterService } from './rate-limiter.service.js';

describe('RateLimiterService', () => {
  it('allows max hits per window, then asks to wait until the window ends', async () => {
    const rl = new RateLimiterService();
    for (let i = 0; i < 5; i++) expect(await rl.hit('k', 5, 60_000, 1_000)).toBe(0);
    expect(await rl.hit('k', 5, 60_000, 31_000)).toBe(30);
    expect(await rl.hit('other', 5, 60_000, 31_000)).toBe(0);
    expect(await rl.hit('k', 5, 60_000, 61_000)).toBe(0);
  });
});
