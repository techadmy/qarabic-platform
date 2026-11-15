-- P1-3 (docs/39 BIL-5): a captured payment whose amount or currency does not match its attempt is
-- held for review (not `failed`), with what was captured, and posted to a suspense account.

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'needs_review';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "captured_amount" DECIMAL(12,2),
ADD COLUMN     "captured_currency" CHAR(3);

-- Receipts under review (suspense), chart code 2150 under accrued liabilities 21.
INSERT INTO "ledger_accounts" ("code", "name_ar", "name_en", "type", "parent_id", "is_group", "is_cash", "system_key")
SELECT '2150', 'مقبوضات قيد المراجعة (حساب معلّق)', 'Receipts under review (suspense)', 'liability', a."id", false, false, 'suspense'
FROM "ledger_accounts" a WHERE a."code" = '21'
ON CONFLICT DO NOTHING;
