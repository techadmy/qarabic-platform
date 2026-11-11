-- N6 billing (docs/20, D83–D88): fee packages, family billing profiles, invoices, payments,
-- provider webhook events, the billing_events ledger outbox and reminder claims.
-- Money is numeric(12,2) + ISO currency. Invoice lines and billing events are append-only.

-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('monthly', 'manual', 'split');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'issued', 'partially_paid', 'paid', 'void', 'split');

-- CreateEnum
CREATE TYPE "InvoiceLineType" AS ENUM ('package', 'manual', 'adjustment', 'discount', 'split');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('stripe', 'paypal', 'cash', 'bank_transfer', 'cheque', 'other');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'succeeded', 'failed', 'cancelled', 'refunded');

-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('received', 'processed', 'ignored', 'failed');

-- CreateTable
CREATE TABLE "fee_packages" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "classes_per_week" SMALLINT NOT NULL,
    "session_minutes" SMALLINT NOT NULL DEFAULT 30,
    "description" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fee_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_package_prices" (
    "id" SERIAL NOT NULL,
    "fee_package_id" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "monthly_amount" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fee_package_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "family_billing_profiles" (
    "family_id" INTEGER NOT NULL,
    "currency" CHAR(3),
    "billing_day" SMALLINT NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "custom_fee" DECIMAL(12,2),
    "starts_on" DATE,
    "updated_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "family_billing_profiles_pkey" PRIMARY KEY ("family_id")
);

-- CreateTable
CREATE TABLE "student_fee_packages" (
    "student_id" INTEGER NOT NULL,
    "fee_package_id" INTEGER NOT NULL,
    "updated_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "student_fee_packages_pkey" PRIMARY KEY ("student_id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" SERIAL NOT NULL,
    "number" VARCHAR(32),
    "family_id" INTEGER NOT NULL,
    "kind" "InvoiceKind" NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'draft',
    "period_start" DATE,
    "period_end" DATE,
    "period_key" VARCHAR(48),
    "currency" CHAR(3) NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "adjustments" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discounts" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "paid" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "issue_date" DATE,
    "due_date" DATE,
    "issued_at" TIMESTAMPTZ(6),
    "issued_by" INTEGER,
    "paid_at" TIMESTAMPTZ(6),
    "voided_at" TIMESTAMPTZ(6),
    "voided_by" INTEGER,
    "void_reason" VARCHAR(500),
    "split_from_id" INTEGER,
    "notes" VARCHAR(1000),
    "created_by" INTEGER,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" SERIAL NOT NULL,
    "invoice_id" INTEGER NOT NULL,
    "type" "InvoiceLineType" NOT NULL,
    "student_id" INTEGER,
    "fee_package_id" INTEGER,
    "description" VARCHAR(500) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "meta" JSONB,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_sequences" (
    "year" SMALLINT NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "invoice_sequences_pkey" PRIMARY KEY ("year")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" SERIAL NOT NULL,
    "invoice_id" INTEGER NOT NULL,
    "family_id" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'pending',
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "provider_ref" VARCHAR(191),
    "provider_payment_id" VARCHAR(191),
    "checkout_url" TEXT,
    "reference" VARCHAR(191),
    "note" VARCHAR(1000),
    "received_at" TIMESTAMPTZ(6),
    "refunded_at" TIMESTAMPTZ(6),
    "failure_reason" VARCHAR(500),
    "recorded_by" INTEGER,
    "initiated_by" INTEGER,
    "idempotency_key" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_webhook_events" (
    "id" SERIAL NOT NULL,
    "provider" VARCHAR(16) NOT NULL,
    "event_id" VARCHAR(191) NOT NULL,
    "type" VARCHAR(96) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'received',
    "error" VARCHAR(1000),
    "processed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_events" (
    "id" SERIAL NOT NULL,
    "type" VARCHAR(48) NOT NULL,
    "subject_type" VARCHAR(32) NOT NULL,
    "subject_id" INTEGER NOT NULL,
    "family_id" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "payload" JSONB,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_reminders" (
    "id" SERIAL NOT NULL,
    "invoice_id" INTEGER NOT NULL,
    "slot" VARCHAR(32) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'sending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoice_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fee_packages_is_active_idx" ON "fee_packages"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "fee_package_prices_fee_package_id_currency_key" ON "fee_package_prices"("fee_package_id", "currency");

-- CreateIndex
CREATE INDEX "student_fee_packages_fee_package_id_idx" ON "student_fee_packages"("fee_package_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_number_key" ON "invoices"("number");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_period_key_key" ON "invoices"("period_key");

-- CreateIndex
CREATE INDEX "invoices_family_id_status_idx" ON "invoices"("family_id", "status");

-- CreateIndex
CREATE INDEX "invoices_status_due_date_idx" ON "invoices"("status", "due_date");

-- CreateIndex
CREATE INDEX "invoices_period_start_idx" ON "invoices"("period_start");

-- CreateIndex
CREATE INDEX "invoices_split_from_id_idx" ON "invoices"("split_from_id");

-- CreateIndex
CREATE INDEX "invoice_lines_invoice_id_idx" ON "invoice_lines"("invoice_id");

-- CreateIndex
CREATE INDEX "invoice_lines_student_id_idx" ON "invoice_lines"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "payments"("idempotency_key");

-- CreateIndex
CREATE INDEX "payments_invoice_id_status_idx" ON "payments"("invoice_id", "status");

-- CreateIndex
CREATE INDEX "payments_family_id_status_idx" ON "payments"("family_id", "status");

-- CreateIndex
CREATE INDEX "payments_received_at_idx" ON "payments"("received_at");

-- CreateIndex
CREATE INDEX "payments_method_provider_payment_id_idx" ON "payments"("method", "provider_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_method_provider_ref_key" ON "payments"("method", "provider_ref");

-- CreateIndex
CREATE INDEX "payment_webhook_events_status_created_at_idx" ON "payment_webhook_events"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_webhook_events_provider_event_id_key" ON "payment_webhook_events"("provider", "event_id");

-- CreateIndex
CREATE INDEX "billing_events_consumed_at_id_idx" ON "billing_events"("consumed_at", "id");

-- CreateIndex
CREATE INDEX "billing_events_subject_type_subject_id_idx" ON "billing_events"("subject_type", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_reminders_invoice_id_slot_key" ON "invoice_reminders"("invoice_id", "slot");

-- AddForeignKey
ALTER TABLE "fee_packages" ADD CONSTRAINT "fee_packages_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_package_prices" ADD CONSTRAINT "fee_package_prices_fee_package_id_fkey" FOREIGN KEY ("fee_package_id") REFERENCES "fee_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "family_billing_profiles" ADD CONSTRAINT "family_billing_profiles_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "family_billing_profiles" ADD CONSTRAINT "family_billing_profiles_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_fee_packages" ADD CONSTRAINT "student_fee_packages_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_fee_packages" ADD CONSTRAINT "student_fee_packages_fee_package_id_fkey" FOREIGN KEY ("fee_package_id") REFERENCES "fee_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_fee_packages" ADD CONSTRAINT "student_fee_packages_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issued_by_fkey" FOREIGN KEY ("issued_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_voided_by_fkey" FOREIGN KEY ("voided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_split_from_id_fkey" FOREIGN KEY ("split_from_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_fee_package_id_fkey" FOREIGN KEY ("fee_package_id") REFERENCES "fee_packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_initiated_by_fkey" FOREIGN KEY ("initiated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_reminders" ADD CONSTRAINT "invoice_reminders_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Business rules the API also checks (a bug can never store bad money).
ALTER TABLE "fee_packages" ADD CONSTRAINT "fee_packages_classes_per_week_check" CHECK ("classes_per_week" BETWEEN 1 AND 14);
ALTER TABLE "fee_package_prices" ADD CONSTRAINT "fee_package_prices_amount_check" CHECK ("monthly_amount" > 0);
ALTER TABLE "family_billing_profiles" ADD CONSTRAINT "family_billing_profiles_day_check" CHECK ("billing_day" IN (1, 15));
ALTER TABLE "family_billing_profiles" ADD CONSTRAINT "family_billing_profiles_fee_check" CHECK ("custom_fee" IS NULL OR "custom_fee" >= 0);
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_amounts_check" CHECK ("total" >= 0 AND "paid" >= 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_check" CHECK ("amount" > 0);

-- Invoice lines are never edited or deleted (D83): corrections are new lines.
CREATE FUNCTION "invoice_lines_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'invoice_lines is append-only';
END;
$$;
CREATE TRIGGER "invoice_lines_no_update" BEFORE UPDATE OR DELETE ON "invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION "invoice_lines_append_only"();

-- The ledger outbox (D86): rows are never deleted; only consumed_at may change (set by the ledger).
CREATE FUNCTION "billing_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'billing_events is append-only';
  END IF;
  IF (NEW."id", NEW."type", NEW."subject_type", NEW."subject_id", NEW."family_id", NEW."amount",
      NEW."currency", NEW."payload"::text, NEW."occurred_at", NEW."created_at")
     IS DISTINCT FROM
     (OLD."id", OLD."type", OLD."subject_type", OLD."subject_id", OLD."family_id", OLD."amount",
      OLD."currency", OLD."payload"::text, OLD."occurred_at", OLD."created_at") THEN
    RAISE EXCEPTION 'billing_events is append-only (only consumed_at may change)';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "billing_events_no_change" BEFORE UPDATE OR DELETE ON "billing_events"
  FOR EACH ROW EXECUTE FUNCTION "billing_events_append_only"();
