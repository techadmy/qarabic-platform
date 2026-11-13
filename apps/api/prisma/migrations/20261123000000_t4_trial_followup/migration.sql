-- T4 trial follow-up (docs/33 §3.5–3.7): reminders, trial reports, stale rule.

-- CreateEnum
CREATE TYPE "TrialReminderKind" AS ENUM ('before_24h', 'before_1h', 'late_alert');

-- CreateEnum
CREATE TYPE "TrialLevel" AS ENUM ('beginner', 'intermediate', 'advanced');

-- CreateEnum
CREATE TYPE "TrialEngagement" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "TrialAttendance" AS ENUM ('on_time', 'late', 'left_early');

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "stale_lost_suggested_at" TIMESTAMPTZ(6),
ADD COLUMN     "stale_reminded_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "trial_reminders" (
    "session_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "kind" "TrialReminderKind" NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "trial_reminders_pkey" PRIMARY KEY ("session_id","user_id","kind")
);

-- CreateTable
CREATE TABLE "trial_reports" (
    "id" SERIAL NOT NULL,
    "session_id" INTEGER NOT NULL,
    "lead_id" INTEGER,
    "attendance" "TrialAttendance" NOT NULL,
    "level" "TrialLevel" NOT NULL,
    "recommended_course_id" INTEGER,
    "classes_per_week" SMALLINT NOT NULL,
    "minutes_per_class" SMALLINT NOT NULL,
    "engagement" "TrialEngagement" NOT NULL,
    "notes" VARCHAR(2000),
    "submitted_by" INTEGER,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "trial_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trial_reports_session_id_key" ON "trial_reports"("session_id");

-- CreateIndex
CREATE INDEX "trial_reports_lead_id_idx" ON "trial_reports"("lead_id");

-- AddForeignKey
ALTER TABLE "trial_reports" ADD CONSTRAINT "trial_reports_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "class_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trial_reports" ADD CONSTRAINT "trial_reports_recommended_course_id_fkey" FOREIGN KEY ("recommended_course_id") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

