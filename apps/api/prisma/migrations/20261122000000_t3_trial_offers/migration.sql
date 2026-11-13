-- T3 open trial offers (docs/33 §4.3).

-- CreateEnum
CREATE TYPE "TrialOfferStatus" AS ENUM ('open', 'claimed', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "TrialOfferPolicy" AS ENUM ('first_accept', 'volunteer');

-- CreateEnum
CREATE TYPE "TrialOfferResponse" AS ENUM ('accept', 'volunteer', 'decline');

-- CreateTable
CREATE TABLE "trial_offers" (
    "id" SERIAL NOT NULL,
    "lead_id" INTEGER NOT NULL,
    "student_id" INTEGER NOT NULL,
    "course_id" INTEGER NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "duration_minutes" SMALLINT NOT NULL,
    "timezone" VARCHAR(64) NOT NULL,
    "policy" "TrialOfferPolicy" NOT NULL DEFAULT 'first_accept',
    "audience" VARCHAR(16) NOT NULL,
    "status" "TrialOfferStatus" NOT NULL DEFAULT 'open',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "meeting_url" TEXT,
    "note" VARCHAR(500),
    "created_by" INTEGER,
    "claimed_teacher_id" INTEGER,
    "session_id" INTEGER,
    "closed_at" TIMESTAMPTZ(6),
    "closed_by" INTEGER,
    "expiry_notified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "trial_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trial_offer_teachers" (
    "offer_id" INTEGER NOT NULL,
    "teacher_id" INTEGER NOT NULL,
    "rank" SMALLINT,
    "response" "TrialOfferResponse",
    "responded_at" TIMESTAMPTZ(6),

    CONSTRAINT "trial_offer_teachers_pkey" PRIMARY KEY ("offer_id","teacher_id")
);

-- CreateIndex
CREATE INDEX "trial_offers_status_expires_at_idx" ON "trial_offers"("status", "expires_at");

-- CreateIndex
CREATE INDEX "trial_offers_lead_id_idx" ON "trial_offers"("lead_id");

-- CreateIndex
CREATE INDEX "trial_offers_student_id_status_idx" ON "trial_offers"("student_id", "status");

-- CreateIndex
CREATE INDEX "trial_offer_teachers_teacher_id_idx" ON "trial_offer_teachers"("teacher_id");

-- AddForeignKey
ALTER TABLE "trial_offers" ADD CONSTRAINT "trial_offers_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trial_offers" ADD CONSTRAINT "trial_offers_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trial_offers" ADD CONSTRAINT "trial_offers_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trial_offers" ADD CONSTRAINT "trial_offers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trial_offers" ADD CONSTRAINT "trial_offers_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trial_offers" ADD CONSTRAINT "trial_offers_claimed_teacher_id_fkey" FOREIGN KEY ("claimed_teacher_id") REFERENCES "teachers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trial_offers" ADD CONSTRAINT "trial_offers_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "class_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trial_offer_teachers" ADD CONSTRAINT "trial_offer_teachers_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "trial_offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trial_offer_teachers" ADD CONSTRAINT "trial_offer_teachers_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One open offer per student at a time (a race between two CSRs ends in a unique violation).
CREATE UNIQUE INDEX "trial_offers_one_open_per_student" ON "trial_offers"("student_id") WHERE "status" = 'open';
