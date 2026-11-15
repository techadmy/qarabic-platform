-- P1-5 follow-up (docs/39 BIL-10): a reused Idempotency-Key with another body is refused.
-- The scoped key `manual:<invoiceId>:<key>` can exceed 64 characters with a 64-character key.
ALTER TABLE "payments" ALTER COLUMN "idempotency_key" TYPE VARCHAR(100);
ALTER TABLE "payments" ADD COLUMN "request_hash" CHAR(64);
