-- P2-3 (docs/39 RBAC-4): rate-limit counters in Postgres, shared by every API process.
CREATE TABLE "rate_limit_buckets" (
    "key" VARCHAR(255) NOT NULL,
    "count" INTEGER NOT NULL,
    "reset_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "rate_limit_buckets_reset_at_idx" ON "rate_limit_buckets"("reset_at");
