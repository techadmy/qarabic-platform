import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window counters (docs/39 RBAC-4, P2-3). In the app they live in Postgres
 * (`rate_limit_buckets`), so a limit holds across every API process; one atomic upsert per hit.
 * Without a database (unit tests) they are kept in memory.
 */
@Injectable()
export class RateLimiterService {
  private readonly buckets = new Map<string, Bucket>();

  constructor(@Optional() private readonly prisma?: PrismaService) {}

  /** Counts a hit; returns the seconds to wait when the key is over `max` in its window, else 0. */
  async hit(key: string, max: number, windowMs: number, now = Date.now()): Promise<number> {
    const { count, resetAt } = this.prisma
      ? await this.hitDb(key.slice(0, 255), windowMs, now)
      : this.hitMemory(key, windowMs, now);
    return count > max ? Math.max(1, Math.ceil((resetAt - now) / 1000)) : 0;
  }

  reset(): void {
    this.buckets.clear();
  }

  private async hitDb(key: string, windowMs: number, now: number): Promise<Bucket> {
    const at = new Date(now);
    const reset = new Date(now + windowMs);
    const [row] = await this.prisma!.$queryRaw<Array<{ count: number; reset_at: Date }>>`
      INSERT INTO "rate_limit_buckets" ("key", "count", "reset_at") VALUES (${key}, 1, ${reset})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "rate_limit_buckets"."reset_at" <= ${at} THEN 1
                       ELSE "rate_limit_buckets"."count" + 1 END,
        "reset_at" = CASE WHEN "rate_limit_buckets"."reset_at" <= ${at} THEN ${reset}
                          ELSE "rate_limit_buckets"."reset_at" END
      RETURNING "count", "reset_at"`;
    // Now and then, drop the windows that are over.
    if (Math.random() < 0.01) {
      await this.prisma!.$executeRaw`DELETE FROM "rate_limit_buckets" WHERE "reset_at" <= ${at}`;
    }
    return { count: Number(row!.count), resetAt: row!.reset_at.getTime() };
  }

  private hitMemory(key: string, windowMs: number, now: number): Bucket {
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (this.buckets.size > 10_000) {
      for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
    }
    return bucket;
  }
}
