-- M7 accounting (docs/09 M14, docs/07 §أ, D2): chart of accounts, the double-entry journal kept per
-- currency, vouchers, period close, numbering and the outbox failure list.

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('asset', 'liability', 'equity', 'income', 'expense');

-- CreateEnum
CREATE TYPE "JournalSource" AS ENUM ('manual', 'voucher', 'billing', 'payroll', 'reversal');

-- CreateEnum
CREATE TYPE "VoucherType" AS ENUM ('receipt', 'payment');

-- CreateEnum
CREATE TYPE "VoucherStatus" AS ENUM ('posted', 'void');

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "name_ar" VARCHAR(120) NOT NULL,
    "name_en" VARCHAR(120) NOT NULL,
    "type" "AccountType" NOT NULL,
    "parent_id" INTEGER,
    "is_group" BOOLEAN NOT NULL DEFAULT false,
    "is_cash" BOOLEAN NOT NULL DEFAULT false,
    "currency" CHAR(3),
    "system_key" VARCHAR(32),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "description" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" SERIAL NOT NULL,
    "number" VARCHAR(24) NOT NULL,
    "entry_date" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "memo" VARCHAR(500) NOT NULL,
    "source" "JournalSource" NOT NULL,
    "source_ref" VARCHAR(48),
    "reverses_id" INTEGER,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" SERIAL NOT NULL,
    "entry_id" INTEGER NOT NULL,
    "account_id" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "entry_date" DATE NOT NULL,
    "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "description" VARCHAR(500),
    "party_type" VARCHAR(16),
    "party_id" INTEGER,
    "position" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vouchers" (
    "id" SERIAL NOT NULL,
    "number" VARCHAR(24) NOT NULL,
    "type" "VoucherType" NOT NULL,
    "status" "VoucherStatus" NOT NULL DEFAULT 'posted',
    "voucher_date" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "cash_account_id" INTEGER NOT NULL,
    "party" VARCHAR(160) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "reference" VARCHAR(80),
    "cheque_number" VARCHAR(40),
    "journal_entry_id" INTEGER NOT NULL,
    "void_entry_id" INTEGER,
    "void_reason" VARCHAR(2000),
    "voided_at" TIMESTAMPTZ(6),
    "voided_by" INTEGER,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voucher_lines" (
    "id" SERIAL NOT NULL,
    "voucher_id" INTEGER NOT NULL,
    "account_id" INTEGER NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "description" VARCHAR(500),
    "position" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "voucher_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_periods" (
    "period" CHAR(7) NOT NULL,
    "closed" BOOLEAN NOT NULL DEFAULT true,
    "closed_at" TIMESTAMPTZ(6),
    "closed_by" INTEGER,
    "reopen_reason" VARCHAR(2000),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounting_periods_pkey" PRIMARY KEY ("period")
);

-- CreateTable
CREATE TABLE "accounting_sequences" (
    "key" VARCHAR(16) NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "accounting_sequences_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ledger_outbox_failures" (
    "id" SERIAL NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "event_id" INTEGER NOT NULL,
    "event_type" VARCHAR(48) NOT NULL,
    "error" VARCHAR(1000) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "last_attempt_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ledger_outbox_failures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_code_key" ON "ledger_accounts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_system_key_key" ON "ledger_accounts"("system_key");

-- CreateIndex
CREATE INDEX "ledger_accounts_parent_id_idx" ON "ledger_accounts"("parent_id");

-- CreateIndex
CREATE INDEX "ledger_accounts_type_idx" ON "ledger_accounts"("type");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_number_key" ON "journal_entries"("number");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_source_ref_key" ON "journal_entries"("source_ref");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_reverses_id_key" ON "journal_entries"("reverses_id");

-- CreateIndex
CREATE INDEX "journal_entries_entry_date_id_idx" ON "journal_entries"("entry_date", "id");

-- CreateIndex
CREATE INDEX "journal_entries_currency_entry_date_idx" ON "journal_entries"("currency", "entry_date");

-- CreateIndex
CREATE INDEX "journal_entries_source_idx" ON "journal_entries"("source");

-- CreateIndex
CREATE INDEX "journal_entries_created_by_idx" ON "journal_entries"("created_by");

-- CreateIndex
CREATE INDEX "journal_lines_entry_id_idx" ON "journal_lines"("entry_id");

-- CreateIndex
CREATE INDEX "journal_lines_account_id_currency_entry_date_idx" ON "journal_lines"("account_id", "currency", "entry_date");

-- CreateIndex
CREATE INDEX "journal_lines_currency_entry_date_idx" ON "journal_lines"("currency", "entry_date");

-- CreateIndex
CREATE INDEX "journal_lines_party_type_party_id_idx" ON "journal_lines"("party_type", "party_id");

-- CreateIndex
CREATE UNIQUE INDEX "vouchers_number_key" ON "vouchers"("number");

-- CreateIndex
CREATE UNIQUE INDEX "vouchers_journal_entry_id_key" ON "vouchers"("journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "vouchers_void_entry_id_key" ON "vouchers"("void_entry_id");

-- CreateIndex
CREATE INDEX "vouchers_type_status_idx" ON "vouchers"("type", "status");

-- CreateIndex
CREATE INDEX "vouchers_voucher_date_idx" ON "vouchers"("voucher_date");

-- CreateIndex
CREATE INDEX "vouchers_cash_account_id_idx" ON "vouchers"("cash_account_id");

-- CreateIndex
CREATE INDEX "voucher_lines_voucher_id_idx" ON "voucher_lines"("voucher_id");

-- CreateIndex
CREATE INDEX "voucher_lines_account_id_idx" ON "voucher_lines"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_outbox_failures_source_event_id_key" ON "ledger_outbox_failures"("source", "event_id");

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reverses_id_fkey" FOREIGN KEY ("reverses_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_cash_account_id_fkey" FOREIGN KEY ("cash_account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_void_entry_id_fkey" FOREIGN KEY ("void_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_voided_by_fkey" FOREIGN KEY ("voided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_lines" ADD CONSTRAINT "voucher_lines_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_lines" ADD CONSTRAINT "voucher_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Integrity --------------------------------------------------------------------------------------
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_parent_check" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_currency_check" CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$');
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_amount_check"
  CHECK ("debit" >= 0 AND "credit" >= 0 AND (("debit" > 0) <> ("credit" > 0)));
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_amount_check" CHECK ("amount" > 0);
ALTER TABLE "voucher_lines" ADD CONSTRAINT "voucher_lines_amount_check" CHECK ("amount" > 0);
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_period_check" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

-- The journal is append-only: corrections are reversing entries (docs/07 §أ.5).
CREATE FUNCTION "journal_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER "journal_entries_no_update" BEFORE UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION "journal_append_only"();
CREATE TRIGGER "journal_lines_no_update" BEFORE UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION "journal_append_only"();

-- No entry is dated in a closed period.
CREATE FUNCTION "journal_open_period"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "accounting_periods"
             WHERE "period" = to_char(NEW."entry_date", 'YYYY-MM') AND "closed") THEN
    RAISE EXCEPTION 'accounting period % is closed', to_char(NEW."entry_date", 'YYYY-MM');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "journal_entries_open_period" BEFORE INSERT ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION "journal_open_period"();

-- Every entry balances at commit: 2+ lines, debits = credits, lines in the entry's currency and date.
CREATE FUNCTION "journal_entry_balanced"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target INTEGER;
  n INTEGER;
  dr NUMERIC;
  cr NUMERIC;
  bad INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN
    target := NEW."id";
  ELSE
    target := NEW."entry_id";
  END IF;
  SELECT count(*), coalesce(sum(l."debit"), 0), coalesce(sum(l."credit"), 0),
         count(*) FILTER (WHERE l."currency" <> e."currency" OR l."entry_date" <> e."entry_date")
    INTO n, dr, cr, bad
    FROM "journal_entries" e LEFT JOIN "journal_lines" l ON l."entry_id" = e."id"
   WHERE e."id" = target;
  IF n < 2 OR dr <> cr OR bad > 0 THEN
    RAISE EXCEPTION 'journal entry % does not balance (lines %, debit %, credit %)', target, n, dr, cr;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "journal_entries_balanced" AFTER INSERT ON "journal_entries"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "journal_entry_balanced"();
CREATE CONSTRAINT TRIGGER "journal_lines_balanced" AFTER INSERT ON "journal_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "journal_entry_balanced"();

-- The chart of accounts (src/accounting/chart.ts; old accounts_cat + accounts_head, reviewed).
INSERT INTO "ledger_accounts" ("id", "code", "name_ar", "name_en", "type", "parent_id", "is_group", "is_cash", "system_key") VALUES
  (1, '1', 'الأصول', 'Assets', 'asset', NULL, true, false, NULL),
  (2, '11', 'النقدية والبنوك', 'Cash and bank', 'asset', 1, true, false, NULL),
  (3, '1110', 'النقدية بالصندوق', 'Cash in hand', 'asset', 2, false, true, 'cash'),
  (4, '1120', 'البنك', 'Bank', 'asset', 2, false, true, 'bank'),
  (5, '1130', 'حساب تسوية Stripe', 'Stripe clearing', 'asset', 2, false, true, 'stripe_clearing'),
  (6, '1140', 'حساب تسوية PayPal', 'PayPal clearing', 'asset', 2, false, true, 'paypal_clearing'),
  (7, '1150', 'محفظة فودافون كاش', 'Vodafone Cash wallet', 'asset', 2, false, true, 'vodafone_cash'),
  (8, '12', 'الذمم المدينة', 'Receivables', 'asset', 1, true, false, NULL),
  (9, '1210', 'ذمم أولياء الأمور (الرسوم الدراسية)', 'Tuition receivable', 'asset', 8, false, false, 'receivable'),
  (10, '13', 'السلف والمصروفات المدفوعة مقدمًا', 'Advances and prepayments', 'asset', 1, true, false, NULL),
  (11, '1310', 'سلف المعلمين والموظفين', 'Staff advances', 'asset', 10, false, false, 'staff_advances'),
  (12, '1320', 'مصروفات مدفوعة مقدمًا', 'Prepaid expenses', 'asset', 10, false, false, NULL),
  (13, '14', 'الأصول الثابتة الملموسة', 'Tangible assets', 'asset', 1, true, false, NULL),
  (14, '1410', 'الأثاث', 'Furniture', 'asset', 13, false, false, NULL),
  (15, '1420', 'الأجهزة الكهربائية', 'Electrical equipment', 'asset', 13, false, false, NULL),
  (16, '1430', 'المعدات المكتبية', 'Office equipment', 'asset', 13, false, false, NULL),
  (17, '1440', 'أجهزة الحاسب', 'Computers', 'asset', 13, false, false, NULL),
  (18, '1490', 'مجمع الإهلاك', 'Accumulated depreciation', 'asset', 13, false, false, NULL),
  (19, '15', 'الأصول غير الملموسة', 'Intangible assets', 'asset', 1, true, false, NULL),
  (20, '1510', 'البرمجيات', 'Software', 'asset', 19, false, false, NULL),
  (21, '1520', 'استضافة الموقع', 'Website hosting', 'asset', 19, false, false, NULL),
  (22, '1530', 'الشهرة', 'Goodwill', 'asset', 19, false, false, NULL),
  (23, '1590', 'مجمع الاستهلاك', 'Accumulated amortization', 'asset', 19, false, false, NULL),
  (24, '2', 'الخصوم', 'Liabilities', 'liability', NULL, true, false, NULL),
  (25, '21', 'المصروفات المستحقة', 'Accrued expenses', 'liability', 24, true, false, NULL),
  (26, '2110', 'رواتب مستحقة (محافظ المعلمين)', 'Salaries payable (teacher wallets)', 'liability', 25, false, false, 'salaries_payable'),
  (27, '2120', 'مرافق مستحقة', 'Utilities payable', 'liability', 25, false, false, NULL),
  (28, '2130', 'دائنون آخرون', 'Other payables', 'liability', 25, false, false, NULL),
  (29, '22', 'الضرائب', 'Taxes', 'liability', 24, true, false, NULL),
  (30, '2210', 'ضرائب مستحقة', 'Tax payable', 'liability', 29, false, false, 'tax_payable'),
  (31, '23', 'القروض طويلة الأجل', 'Long-term loans', 'liability', 24, true, false, NULL),
  (32, '2310', 'قرض', 'Loan', 'liability', 31, false, false, NULL),
  (33, '3', 'حقوق الملكية', 'Equity', 'equity', NULL, true, false, NULL),
  (34, '3100', 'رأس المال', 'Owner''s capital', 'equity', 33, false, false, NULL),
  (35, '3150', 'المسحوبات الشخصية', 'Owner''s drawings', 'equity', 33, false, false, NULL),
  (36, '3200', 'الأرباح المحتجزة', 'Retained earnings', 'equity', 33, false, false, 'retained_earnings'),
  (37, '3300', 'أرصدة افتتاحية', 'Opening balance equity', 'equity', 33, false, false, 'opening_balance'),
  (38, '4', 'الإيرادات', 'Income', 'income', NULL, true, false, NULL),
  (39, '4100', 'إيرادات الرسوم الدراسية', 'Tuition fees', 'income', 38, false, false, 'tuition_revenue'),
  (40, '4150', 'خصومات مسموح بها', 'Discounts allowed', 'income', 38, false, false, 'discounts'),
  (41, '4200', 'إيرادات الجزاءات', 'Fines income', 'income', 38, false, false, 'fines_income'),
  (42, '4900', 'إيرادات أخرى', 'Other income', 'income', 38, false, false, NULL),
  (43, '5', 'المصروفات', 'Expenses', 'expense', NULL, true, false, NULL),
  (44, '51', 'تكلفة الخدمات', 'Cost of services', 'expense', 43, true, false, NULL),
  (45, '5110', 'رواتب المعلمين', 'Teacher salaries', 'expense', 44, false, false, 'salaries_expense'),
  (46, '5120', 'مكافآت المديرين', 'Directors'' remuneration', 'expense', 44, false, false, NULL),
  (47, '5130', 'الإيجار', 'Rent', 'expense', 44, false, false, NULL),
  (48, '5140', 'الكهرباء', 'Electricity', 'expense', 44, false, false, NULL),
  (49, '5150', 'الإنترنت', 'Internet', 'expense', 44, false, false, NULL),
  (50, '5160', 'سماعات الرأس', 'Headphones', 'expense', 44, false, false, NULL),
  (51, '5170', 'التدريب', 'Training', 'expense', 44, false, false, NULL),
  (52, '5180', 'الإهلاك', 'Depreciation', 'expense', 44, false, false, NULL),
  (53, '5190', 'الاستهلاك', 'Amortization', 'expense', 44, false, false, NULL),
  (54, '52', 'المصروفات الإدارية والعمومية', 'Administrative and general', 'expense', 43, true, false, NULL),
  (55, '5210', 'رواتب الموظفين الإداريين', 'Administrative salaries', 'expense', 54, false, false, NULL),
  (56, '5215', 'الطباعة والأدوات المكتبية', 'Printing and stationery', 'expense', 54, false, false, NULL),
  (57, '5220', 'الأتعاب القانونية', 'Legal fees', 'expense', 54, false, false, NULL),
  (58, '5225', 'الدعاية والإعلان', 'Advertising', 'expense', 54, false, false, NULL),
  (59, '5230', 'الهاتف', 'Telephone', 'expense', 54, false, false, NULL),
  (60, '5235', 'الوقود', 'Fuel', 'expense', 54, false, false, NULL),
  (61, '5240', 'الإصلاح والصيانة', 'Repairs and maintenance', 'expense', 54, false, false, NULL),
  (62, '5245', 'الأمن', 'Security', 'expense', 54, false, false, NULL),
  (63, '5250', 'الغاز', 'Gas', 'expense', 54, false, false, NULL),
  (64, '5255', 'المياه', 'Water', 'expense', 54, false, false, NULL),
  (65, '5260', 'السفر والانتقالات', 'Travel', 'expense', 54, false, false, NULL),
  (66, '5265', 'البريد السريع', 'Courier', 'expense', 54, false, false, NULL),
  (67, '5270', 'النظافة', 'Cleaning', 'expense', 54, false, false, NULL),
  (68, '5275', 'أتعاب المراجعة', 'Audit fees', 'expense', 54, false, false, NULL),
  (69, '5280', 'عمولات بوابات الدفع', 'Payment gateway fees', 'expense', 54, false, false, 'gateway_fees'),
  (70, '53', 'المصروفات البنكية', 'Bank charges', 'expense', 43, true, false, NULL),
  (71, '5310', 'الفوائد', 'Interest', 'expense', 70, false, false, NULL),
  (72, '5320', 'مصروفات بنكية أخرى', 'Other bank charges', 'expense', 70, false, false, NULL),
  (73, '54', 'الضرائب', 'Tax', 'expense', 43, true, false, NULL),
  (74, '5410', 'ضريبة الدخل', 'Income tax', 'expense', 73, false, false, NULL);
SELECT setval(pg_get_serial_sequence('"ledger_accounts"', 'id'), 74);
