-- N7 payroll (Laravel M6, docs/21, D41, D89–D95). Money = numeric(12,2) + ISO currency.
-- Payroll computes, records and approves only: no table here moves money (D140).

-- CreateEnum
CREATE TYPE "SalaryType" AS ENUM ('monthly', 'per_class', 'hourly', 'slot');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('present', 'absent', 'leave', 'holiday');

-- CreateEnum
CREATE TYPE "AttendanceSource" AS ENUM ('self', 'staff', 'leave');

-- CreateEnum
CREATE TYPE "LeaveType" AS ENUM ('paid', 'unpaid', 'sick');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('pending', 'approved', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "AdjustmentType" AS ENUM ('fine', 'bonus', 'advance', 'arrears', 'fine_reduction', 'gift', 'other_addition', 'other_deduction', 'csr_conversions');

-- CreateEnum
CREATE TYPE "AdjustmentStatus" AS ENUM ('proposed', 'approved', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('draft', 'reviewed', 'approved', 'paid');

-- CreateEnum
CREATE TYPE "PayslipStatus" AS ENUM ('draft', 'approved', 'paid');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('vodafone_cash', 'bank_transfer', 'cash', 'other');

-- CreateEnum
CREATE TYPE "WalletTxType" AS ENUM ('salary_credit', 'salary_payment', 'reversal');

-- AlterTable
ALTER TABLE "class_sessions" ADD COLUMN     "billable" BOOLEAN,
ADD COLUMN     "pay_hours" DECIMAL(5,2),
ADD COLUMN     "pay_rule_key" VARCHAR(40),
ADD COLUMN     "pay_rule_set_id" INTEGER;

-- CreateTable
CREATE TABLE "pay_rule_sets" (
    "id" SERIAL NOT NULL,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "rules" JSONB NOT NULL,
    "note" VARCHAR(255),
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pay_rule_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_profiles" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "teacher_id" INTEGER,
    "salary_type" "SalaryType" NOT NULL DEFAULT 'hourly',
    "currency" CHAR(3),
    "monthly_salary" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "class_rate" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "hourly_rate" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "csr_rate" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "allowance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "slot_tiers" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" VARCHAR(500),
    "updated_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pay_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "days" SMALLINT NOT NULL,
    "leave_type" "LeaveType" NOT NULL,
    "reason" VARCHAR(2000) NOT NULL,
    "status" "LeaveStatus" NOT NULL DEFAULT 'pending',
    "requested_by" INTEGER,
    "decided_by" INTEGER,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_attendance" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "work_date" DATE NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "paid_leave" BOOLEAN NOT NULL DEFAULT true,
    "check_in_at" TIMESTAMPTZ(6),
    "check_out_at" TIMESTAMPTZ(6),
    "worked_minutes" INTEGER,
    "timezone" VARCHAR(64),
    "source" "AttendanceSource" NOT NULL DEFAULT 'self',
    "leave_request_id" INTEGER,
    "note" VARCHAR(1000),
    "recorded_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" SERIAL NOT NULL,
    "period" CHAR(7) NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'draft',
    "computed_at" TIMESTAMPTZ(6),
    "created_by" INTEGER,
    "reviewed_by" INTEGER,
    "reviewed_at" TIMESTAMPTZ(6),
    "approved_by" INTEGER,
    "approved_at" TIMESTAMPTZ(6),
    "paid_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslips" (
    "id" SERIAL NOT NULL,
    "payroll_run_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "teacher_id" INTEGER,
    "currency" CHAR(3) NOT NULL,
    "salary_type" "SalaryType" NOT NULL,
    "rates" JSONB NOT NULL,
    "paid_hours" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "paid_classes" INTEGER NOT NULL DEFAULT 0,
    "deduction_days" SMALLINT NOT NULL DEFAULT 0,
    "earnings" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "deductions" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "net" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "PayslipStatus" NOT NULL DEFAULT 'draft',
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "errors" JSONB NOT NULL DEFAULT '[]',
    "paid_at" TIMESTAMPTZ(6),
    "paid_on" DATE,
    "paid_by" INTEGER,
    "payment_method" "PaymentMethod",
    "payment_reference" VARCHAR(120),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payslips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_adjustments" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "type" "AdjustmentType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "quantity" INTEGER,
    "currency" CHAR(3) NOT NULL,
    "effective_on" DATE NOT NULL,
    "reason" VARCHAR(2000) NOT NULL,
    "status" "AdjustmentStatus" NOT NULL,
    "session_id" INTEGER,
    "payslip_id" INTEGER,
    "reverses_id" INTEGER,
    "created_by" INTEGER,
    "decided_by" INTEGER,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pay_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslip_lines" (
    "id" SERIAL NOT NULL,
    "payslip_id" INTEGER NOT NULL,
    "code" VARCHAR(24) NOT NULL,
    "sign" SMALLINT NOT NULL,
    "quantity" DECIMAL(10,2),
    "rate" DECIMAL(12,2),
    "amount" DECIMAL(12,2) NOT NULL,
    "pay_adjustment_id" INTEGER,
    "position" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "payslip_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslip_sessions" (
    "id" SERIAL NOT NULL,
    "payslip_id" INTEGER NOT NULL,
    "session_id" INTEGER NOT NULL,
    "starts_at" TIMESTAMPTZ(6),
    "kind" VARCHAR(16) NOT NULL,
    "stage" VARCHAR(20) NOT NULL,
    "pay_hours" DECIMAL(5,2) NOT NULL,
    "pay_rule_key" VARCHAR(40),

    CONSTRAINT "payslip_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "type" "WalletTxType" NOT NULL,
    "payslip_id" INTEGER,
    "reference" VARCHAR(190),
    "created_by" INTEGER,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_events" (
    "id" SERIAL NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "aggregate_type" VARCHAR(40) NOT NULL,
    "aggregate_id" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pay_rule_sets_effective_from_idx" ON "pay_rule_sets"("effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "pay_profiles_user_id_key" ON "pay_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "pay_profiles_teacher_id_key" ON "pay_profiles"("teacher_id");

-- CreateIndex
CREATE INDEX "pay_profiles_active_idx" ON "pay_profiles"("active");

-- CreateIndex
CREATE INDEX "leave_requests_user_id_starts_on_idx" ON "leave_requests"("user_id", "starts_on");

-- CreateIndex
CREATE INDEX "leave_requests_status_starts_on_idx" ON "leave_requests"("status", "starts_on");

-- CreateIndex
CREATE INDEX "staff_attendance_work_date_status_idx" ON "staff_attendance"("work_date", "status");

-- CreateIndex
CREATE INDEX "staff_attendance_user_id_check_out_at_idx" ON "staff_attendance"("user_id", "check_out_at");

-- CreateIndex
CREATE UNIQUE INDEX "staff_attendance_user_id_work_date_key" ON "staff_attendance"("user_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_period_key" ON "payroll_runs"("period");

-- CreateIndex
CREATE INDEX "payslips_user_id_status_idx" ON "payslips"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_payroll_run_id_user_id_key" ON "payslips"("payroll_run_id", "user_id");

-- CreateIndex
CREATE INDEX "pay_adjustments_user_id_effective_on_idx" ON "pay_adjustments"("user_id", "effective_on");

-- CreateIndex
CREATE INDEX "pay_adjustments_type_status_idx" ON "pay_adjustments"("type", "status");

-- CreateIndex
CREATE INDEX "payslip_lines_payslip_id_idx" ON "payslip_lines"("payslip_id");

-- CreateIndex
CREATE INDEX "payslip_sessions_payslip_id_idx" ON "payslip_sessions"("payslip_id");

-- CreateIndex
CREATE INDEX "payslip_sessions_session_id_idx" ON "payslip_sessions"("session_id");

-- CreateIndex
CREATE INDEX "wallet_transactions_user_id_currency_idx" ON "wallet_transactions"("user_id", "currency");

-- CreateIndex
CREATE INDEX "payroll_events_consumed_at_id_idx" ON "payroll_events"("consumed_at", "id");

-- AddForeignKey
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_pay_rule_set_id_fkey" FOREIGN KEY ("pay_rule_set_id") REFERENCES "pay_rule_sets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_rule_sets" ADD CONSTRAINT "pay_rule_sets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_profiles" ADD CONSTRAINT "pay_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_profiles" ADD CONSTRAINT "pay_profiles_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_profiles" ADD CONSTRAINT "pay_profiles_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_leave_request_id_fkey" FOREIGN KEY ("leave_request_id") REFERENCES "leave_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_payroll_run_id_fkey" FOREIGN KEY ("payroll_run_id") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_paid_by_fkey" FOREIGN KEY ("paid_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_adjustments" ADD CONSTRAINT "pay_adjustments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_adjustments" ADD CONSTRAINT "pay_adjustments_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "class_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_adjustments" ADD CONSTRAINT "pay_adjustments_payslip_id_fkey" FOREIGN KEY ("payslip_id") REFERENCES "payslips"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_adjustments" ADD CONSTRAINT "pay_adjustments_reverses_id_fkey" FOREIGN KEY ("reverses_id") REFERENCES "pay_adjustments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_adjustments" ADD CONSTRAINT "pay_adjustments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_adjustments" ADD CONSTRAINT "pay_adjustments_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_payslip_id_fkey" FOREIGN KEY ("payslip_id") REFERENCES "payslips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_pay_adjustment_id_fkey" FOREIGN KEY ("pay_adjustment_id") REFERENCES "pay_adjustments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip_sessions" ADD CONSTRAINT "payslip_sessions_payslip_id_fkey" FOREIGN KEY ("payslip_id") REFERENCES "payslips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_payslip_id_fkey" FOREIGN KEY ("payslip_id") REFERENCES "payslips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Amounts are never negative on adjustments / lines (the sign is separate); runs one per month.
ALTER TABLE "pay_adjustments" ADD CONSTRAINT "pay_adjustments_amount_check" CHECK ("amount" >= 0);
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_sign_check" CHECK ("sign" IN (-1, 1));
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_amount_check" CHECK ("amount" >= 0);
ALTER TABLE "pay_profiles" ADD CONSTRAINT "pay_profiles_money_check" CHECK (
  "monthly_salary" >= 0 AND "class_rate" >= 0 AND "hourly_rate" >= 0 AND "csr_rate" >= 0
  AND "allowance" >= 0 AND "tax" >= 0
);
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_period_check" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_dates_check" CHECK ("ends_on" >= "starts_on" AND "days" >= 1);
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_checkout_check" CHECK ("check_out_at" IS NULL OR ("check_in_at" IS NOT NULL AND "check_out_at" >= "check_in_at"));

-- Pay rule sets (D41) and the wallet ledger (D93) are immutable: a change inserts a new row.
CREATE FUNCTION "payroll_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER "pay_rule_sets_no_update" BEFORE UPDATE OR DELETE ON "pay_rule_sets"
  FOR EACH ROW EXECUTE FUNCTION "payroll_append_only"();
CREATE TRIGGER "wallet_transactions_no_update" BEFORE UPDATE OR DELETE ON "wallet_transactions"
  FOR EACH ROW EXECUTE FUNCTION "payroll_append_only"();

-- Seeded pay rule set #1 (old rules page + B5 + old hourly code: trial unpaid). docs/14 §2.9.
INSERT INTO "pay_rule_sets" ("effective_from", "rules", "note") VALUES (
  '2000-01-01T00:00:00Z',
  '{"taken":{"factor":1,"billable":true},"absent":{"factor":1,"billable":true},"declined":{"factor":1,"billable":true},"leave":{"factor":0,"billable":false},"cancelled:holiday":{"factor":1,"billable":false,"paidHolidayOnly":true},"cancelled":{"factor":0,"billable":false},"moved_out":{"factor":0,"billable":false},"trial:*":{"factor":0,"billable":false},"default":{"factor":0,"billable":false}}',
  'Set #1: old rules page + B5 + old hourly code (trial unpaid). docs/14 §2.9'
);

-- D89: the hourly rate moves from the teacher record to an hourly pay profile (EGP unless the
-- teacher record said otherwise), then the teacher columns go.
INSERT INTO "pay_profiles" ("user_id", "teacher_id", "salary_type", "currency", "hourly_rate", "active", "updated_at")
SELECT t."user_id", t."id", 'hourly', t."hourly_rate_currency", t."hourly_rate", true, CURRENT_TIMESTAMP
FROM "teachers" t
WHERE t."hourly_rate" IS NOT NULL AND t."hourly_rate" > 0
ON CONFLICT ("user_id") DO NOTHING;

ALTER TABLE "teachers" DROP COLUMN "hourly_rate",
DROP COLUMN "hourly_rate_currency";

-- Decided classes migrated before N7 get their pay snapshot from set #1 (paid holidays: by the
-- holiday's `paid` flag on the academy-local day, Africa/Cairo).
UPDATE "class_sessions" c SET
  "pay_rule_set_id" = (SELECT min(id) FROM "pay_rule_sets"),
  "pay_rule_key" = CASE
    WHEN c."kind" = 'trial' THEN 'trial:*'
    WHEN c."stage" = 'cancelled' AND c."stage_reason" = 'holiday' THEN 'cancelled:holiday'
    ELSE c."stage"::text END,
  "billable" = (c."kind" <> 'trial' AND c."stage" IN ('taken', 'absent', 'declined')),
  "pay_hours" = round((CASE
    WHEN c."kind" = 'trial' THEN 0
    WHEN c."stage" IN ('taken', 'absent', 'declined') THEN 1
    WHEN c."stage" = 'cancelled' AND c."stage_reason" = 'holiday' THEN CASE WHEN EXISTS (
      SELECT 1 FROM "holidays" h
      WHERE h."paid" = false
        AND h."date" <= (c."starts_at" AT TIME ZONE 'Africa/Cairo')::date
        AND COALESCE(h."ends_on", h."date") >= (c."starts_at" AT TIME ZONE 'Africa/Cairo')::date
    ) THEN 0 ELSE 1 END
    ELSE 0 END) * c."duration_minutes" / 60.0, 2)
WHERE c."stage" IN ('taken', 'absent', 'declined', 'leave', 'cancelled', 'moved_out');
