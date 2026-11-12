-- N5 CRM: leads, their timeline and in-app alerts (docs/26, docs/33 §3). Additive only.

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('new', 'contacted', 'trial_scheduled', 'trial_done', 'converted', 'lost', 'spam', 'job_applicant');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('web_form', 'phone', 'whatsapp', 'walk_in', 'referral', 'other');

-- CreateEnum
CREATE TYPE "LostReason" AS ENUM ('not_interested', 'no_response', 'price', 'schedule', 'duplicate', 'other');

-- CreateEnum
CREATE TYPE "TrialOutcome" AS ENUM ('interested', 'not_interested', 'no_show');

-- CreateEnum
CREATE TYPE "LeadActivityType" AS ENUM ('note', 'call', 'whatsapp', 'email', 'status_changed', 'assigned', 'account_created', 'trial_booked', 'trial_cancelled', 'trial_outcome', 'converted', 'resubmitted', 'created');

-- CreateTable
CREATE TABLE "leads" (
    "id" SERIAL NOT NULL,
    "status" "LeadStatus" NOT NULL DEFAULT 'new',
    "source" "LeadSource" NOT NULL DEFAULT 'web_form',
    "site" VARCHAR(40),
    "parent_name" VARCHAR(120) NOT NULL,
    "email" VARCHAR(190),
    "phone" VARCHAR(40),
    "phone_digits" VARCHAR(15),
    "country_code" CHAR(2),
    "city" VARCHAR(80),
    "timezone" VARCHAR(64) NOT NULL,
    "preferred_language" VARCHAR(8),
    "children" JSONB NOT NULL DEFAULT '[]',
    "course_interest" VARCHAR(120),
    "preferred_times" VARCHAR(500),
    "preferred_schedule" JSONB,
    "teacher_gender_pref" VARCHAR(8),
    "heard_from" VARCHAR(16),
    "message" TEXT,
    "utm" JSONB,
    "external_ref" VARCHAR(100),
    "referral_family_id" INTEGER,
    "family_id" INTEGER,
    "assigned_to" INTEGER,
    "assigned_at" TIMESTAMPTZ(6),
    "auto_assigned_at" TIMESTAMPTZ(6),
    "created_by" INTEGER,
    "next_follow_up_at" TIMESTAMPTZ(6),
    "follow_up_notified_for" TIMESTAMPTZ(6),
    "last_contacted_at" TIMESTAMPTZ(6),
    "first_response_at" TIMESTAMPTZ(6),
    "sla_notified_at" TIMESTAMPTZ(6),
    "contact_attempts" INTEGER NOT NULL DEFAULT 0,
    "trial_outcome" "TrialOutcome",
    "lost_reason" "LostReason",
    "status_note" VARCHAR(1000),
    "status_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "converted_at" TIMESTAMPTZ(6),
    "converted_by" INTEGER,
    "spam_score" SMALLINT NOT NULL DEFAULT 0,
    "spam_flags" JSONB,
    "ip_hash" CHAR(64),
    "submissions" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_activities" (
    "id" SERIAL NOT NULL,
    "lead_id" INTEGER NOT NULL,
    "type" "LeadActivityType" NOT NULL,
    "body" TEXT,
    "call_result" VARCHAR(16),
    "meta" JSONB,
    "user_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lead_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "event" VARCHAR(32) NOT NULL,
    "data" JSONB NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "leads_external_ref_key" ON "leads"("external_ref");

-- CreateIndex
CREATE INDEX "leads_status_created_at_idx" ON "leads"("status", "created_at");

-- CreateIndex
CREATE INDEX "leads_assigned_to_status_idx" ON "leads"("assigned_to", "status");

-- CreateIndex
CREATE INDEX "leads_email_idx" ON "leads"("email");

-- CreateIndex
CREATE INDEX "leads_phone_digits_idx" ON "leads"("phone_digits");

-- CreateIndex
CREATE INDEX "leads_family_id_idx" ON "leads"("family_id");

-- CreateIndex
CREATE INDEX "leads_next_follow_up_at_idx" ON "leads"("next_follow_up_at");

-- CreateIndex
CREATE INDEX "leads_ip_hash_created_at_idx" ON "leads"("ip_hash", "created_at");

-- CreateIndex
CREATE INDEX "lead_activities_lead_id_id_idx" ON "lead_activities"("lead_id", "id");

-- CreateIndex
CREATE INDEX "lead_activities_type_idx" ON "lead_activities"("type");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_referral_family_id_fkey" FOREIGN KEY ("referral_family_id") REFERENCES "families"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_converted_by_fkey" FOREIGN KEY ("converted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The lead timeline is append-only (docs/26 §3.2), like session_events.
CREATE FUNCTION "lead_activities_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'lead_activities is append-only';
END;
$$;
CREATE TRIGGER "lead_activities_no_update" BEFORE UPDATE OR DELETE ON "lead_activities"
  FOR EACH ROW EXECUTE FUNCTION "lead_activities_append_only"();
