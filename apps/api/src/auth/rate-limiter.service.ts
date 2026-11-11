import { Injectable } from '@nestjs/common';

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window counters kept in memory (one API process for now). Moves to Redis with the BullMQ
 * work in N2, when the API runs more than one process.
 */
@Injectable()
export class RateLimiterService {
  private readonly buckets = new Map<string, Bucket>();

  /** Counts a hit; returns the seconds to wait when the key is over `max` in its window, else 0. */
  hit(key: string, max: number, windowMs: number, now = Date.now()): number {
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (this.buckets.size > 10_000) this.sweep(now);
    return bucket.count > max ? Math.ceil((bucket.resetAt - now) / 1000) : 0;
  }

  reset(): void {
    this.buckets.clear();
  }

  private sweep(now: number): void {
    for (const [key, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(key);
  }
}
