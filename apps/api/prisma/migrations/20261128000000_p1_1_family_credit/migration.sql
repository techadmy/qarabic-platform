-- P1-1 (docs/39 BIL-1, BIL-2; B115): an overpayment stays as the family's credit, one open online
-- attempt per invoice.

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'credit';

-- CreateEnum
CREATE TYPE "FamilyCreditStatus" AS ENUM ('open', 'used', 'refunded');

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "needs_review" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "review_reason" VARCHAR(32),
ADD COLUMN     "unapplied" DECIMAL(12,2) NOT NULL DEFAULT 0;

ALTER TABLE "payments" ADD CONSTRAINT "payments_unapplied_check"
  CHECK ("unapplied" >= 0 AND "unapplied" <= "amount");

-- CreateTable
CREATE TABLE "family_credits" (
    "id" SERIAL NOT NULL,
    "family_id" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "remaining" DECIMAL(12,2) NOT NULL,
    "status" "FamilyCreditStatus" NOT NULL DEFAULT 'open',
    "source_payment_id" INTEGER,
    "reviewed_at" TIMESTAMPTZ(6),
    "reviewed_by" INTEGER,
    "note" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "family_credits_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "family_credits_remaining_check" CHECK ("remaining" >= 0 AND "remaining" <= "amount")
);

-- CreateIndex
CREATE INDEX "family_credits_family_id_status_idx" ON "family_credits"("family_id", "status");

-- AddForeignKey
ALTER TABLE "family_credits" ADD CONSTRAINT "family_credits_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "family_credits" ADD CONSTRAINT "family_credits_source_payment_id_fkey" FOREIGN KEY ("source_payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One open online attempt per invoice (BIL-2: a double click cannot open two checkouts).
-- Older duplicates (before this rule) are cancelled first, keeping the newest.
UPDATE "payments" p SET "status" = 'cancelled', "failure_reason" = 'superseded'
WHERE p."status" = 'pending' AND p."method" IN ('stripe', 'paypal')
  AND EXISTS (SELECT 1 FROM "payments" q WHERE q."invoice_id" = p."invoice_id" AND q."status" = 'pending'
              AND q."method" IN ('stripe', 'paypal') AND q."id" > p."id");
CREATE UNIQUE INDEX "payments_one_pending_online" ON "payments"("invoice_id")
  WHERE "status" = 'pending' AND "method" IN ('stripe', 'paypal');

-- The customer-credits liability (chart code 2140, under accrued liabilities 21).
INSERT INTO "ledger_accounts" ("code", "name_ar", "name_en", "type", "parent_id", "is_group", "is_cash", "system_key")
SELECT '2140', 'أرصدة دائنة للعملاء (مدفوعات زائدة)', 'Customer credits (overpayments)', 'liability', a."id", false, false, 'customer_credits'
FROM "ledger_accounts" a WHERE a."code" = '21'
ON CONFLICT DO NOTHING;
