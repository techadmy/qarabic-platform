-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('active', 'paused', 'ended');

-- CreateEnum
CREATE TYPE "SessionKind" AS ENUM ('regular', 'trial', 'rescheduled', 'advance', 'extra');

-- CreateEnum
CREATE TYPE "SessionStage" AS ENUM ('scheduled', 'activated', 'in_progress', 'ended', 'taken', 'absent', 'declined', 'leave', 'cancelled', 'moved_out');

-- CreateEnum
CREATE TYPE "SessionSource" AS ENUM ('generated', 'manual', 'request', 'migrated');

-- CreateEnum
CREATE TYPE "MeetingMode" AS ENUM ('zoom', 'external');

-- CreateEnum
CREATE TYPE "ZoomStatus" AS ENUM ('none', 'pending', 'ready', 'failed', 'external', 'deleted');

-- CreateEnum
CREATE TYPE "SessionRequestType" AS ENUM ('leave', 'reschedule', 'advance', 'extra');

-- CreateEnum
CREATE TYPE "SessionRequestStatus" AS ENUM ('pending', 'approved', 'auto_approved', 'rejected', 'cancelled', 'expired');

-- CreateEnum
CREATE TYPE "TeacherBlockKind" AS ENUM ('recurring', 'one_off');

-- AlterEnum
ALTER TYPE "PersonType" ADD VALUE 'enrollment';

-- CreateTable
CREATE TABLE "enrollments" (
    "id" SERIAL NOT NULL,
    "student_id" INTEGER NOT NULL,
    "course_id" INTEGER NOT NULL,
    "teacher_id" INTEGER NOT NULL,
    "kind" "SessionKind" NOT NULL DEFAULT 'regular',
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'active',
    "paused_reason" VARCHAR(32),
    "starts_on" DATE NOT NULL,
    "ends_on" DATE,
    "session_minutes" SMALLINT NOT NULL DEFAULT 30,
    "timezone" VARCHAR(64) NOT NULL,
    "meeting_mode" "MeetingMode" NOT NULL DEFAULT 'zoom',
    "external_meeting_url" VARCHAR(500),
    "notes" TEXT,
    "status_changed_at" TIMESTAMPTZ(6),
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_slots" (
    "id" SERIAL NOT NULL,
    "enrollment_id" INTEGER NOT NULL,
    "teacher_id" INTEGER NOT NULL,
    "weekday" SMALLINT NOT NULL,
    "local_start_time" CHAR(5) NOT NULL,
    "duration_minutes" SMALLINT NOT NULL,
    "timezone" VARCHAR(64) NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "schedule_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "date" DATE NOT NULL,
    "ends_on" DATE,
    "paid" BOOLEAN NOT NULL DEFAULT true,
    "applies_to" VARCHAR(16) NOT NULL DEFAULT 'all',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teacher_blocks" (
    "id" SERIAL NOT NULL,
    "teacher_id" INTEGER NOT NULL,
    "kind" "TeacherBlockKind" NOT NULL,
    "reason" VARCHAR(16) NOT NULL DEFAULT 'other',
    "weekday" SMALLINT,
    "local_start_time" CHAR(5),
    "duration_minutes" SMALLINT,
    "timezone" VARCHAR(64),
    "valid_from" DATE,
    "valid_to" DATE,
    "starts_at" TIMESTAMPTZ(6),
    "ends_at" TIMESTAMPTZ(6),
    "note" VARCHAR(500),
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "teacher_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teacher_work_hours" (
    "id" SERIAL NOT NULL,
    "teacher_id" INTEGER NOT NULL,
    "weekday" SMALLINT NOT NULL,
    "local_start_time" CHAR(5) NOT NULL,
    "local_end_time" CHAR(5) NOT NULL,
    "timezone" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teacher_work_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zoom_hosts" (
    "id" SERIAL NOT NULL,
    "zoom_user_id" VARCHAR(64) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "label" VARCHAR(100),
    "teacher_id" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "zoom_hosts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "class_sessions" (
    "id" SERIAL NOT NULL,
    "enrollment_id" INTEGER,
    "schedule_slot_id" INTEGER,
    "occurrence_date" DATE,
    "teacher_id" INTEGER NOT NULL,
    "student_id" INTEGER NOT NULL,
    "course_id" INTEGER,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "duration_minutes" SMALLINT NOT NULL,
    "kind" "SessionKind" NOT NULL DEFAULT 'regular',
    "stage" "SessionStage" NOT NULL DEFAULT 'scheduled',
    "stage_reason" VARCHAR(32),
    "origin_session_id" INTEGER,
    "source" "SessionSource" NOT NULL DEFAULT 'manual',
    "is_detached" BOOLEAN NOT NULL DEFAULT false,
    "activated_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "marked_at" TIMESTAMPTZ(6),
    "marked_by" INTEGER,
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "review_reason" VARCHAR(32),
    "zoom_status" "ZoomStatus" NOT NULL DEFAULT 'none',
    "zoom_meeting_id" VARCHAR(32),
    "zoom_host_id" INTEGER,
    "zoom_join_url" VARCHAR(500),
    "zoom_error" VARCHAR(255),
    "actual_started_at" TIMESTAMPTZ(6),
    "actual_ended_at" TIMESTAMPTZ(6),
    "teacher_joined_at" TIMESTAMPTZ(6),
    "student_joined_at" TIMESTAMPTZ(6),
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_by" INTEGER,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "class_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_events" (
    "id" SERIAL NOT NULL,
    "session_id" INTEGER NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "from_stage" VARCHAR(20),
    "to_stage" VARCHAR(20),
    "actor_user_id" INTEGER,
    "actor_role" VARCHAR(100),
    "payload" JSONB,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "session_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_requests" (
    "id" SERIAL NOT NULL,
    "type" "SessionRequestType" NOT NULL,
    "session_id" INTEGER NOT NULL,
    "enrollment_id" INTEGER,
    "student_id" INTEGER NOT NULL,
    "requested_by" INTEGER NOT NULL,
    "requester_role" VARCHAR(100),
    "reason" TEXT NOT NULL,
    "notified_at" TIMESTAMPTZ(6),
    "proposed_starts_at" TIMESTAMPTZ(6),
    "proposed_duration_minutes" SMALLINT,
    "proposed_teacher_id" INTEGER,
    "status" "SessionRequestStatus" NOT NULL DEFAULT 'pending',
    "decided_by" INTEGER,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" TEXT,
    "result_session_id" INTEGER,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "enrollments_student_id_status_idx" ON "enrollments"("student_id", "status");

-- CreateIndex
CREATE INDEX "enrollments_teacher_id_status_idx" ON "enrollments"("teacher_id", "status");

-- CreateIndex
CREATE INDEX "enrollments_course_id_idx" ON "enrollments"("course_id");

-- CreateIndex
CREATE INDEX "schedule_slots_teacher_id_weekday_idx" ON "schedule_slots"("teacher_id", "weekday");

-- CreateIndex
CREATE INDEX "schedule_slots_enrollment_id_valid_to_idx" ON "schedule_slots"("enrollment_id", "valid_to");

-- CreateIndex
CREATE INDEX "holidays_date_idx" ON "holidays"("date");

-- CreateIndex
CREATE INDEX "teacher_blocks_teacher_id_kind_idx" ON "teacher_blocks"("teacher_id", "kind");

-- CreateIndex
CREATE INDEX "teacher_work_hours_teacher_id_weekday_idx" ON "teacher_work_hours"("teacher_id", "weekday");

-- CreateIndex
CREATE UNIQUE INDEX "zoom_hosts_zoom_user_id_key" ON "zoom_hosts"("zoom_user_id");

-- CreateIndex
CREATE INDEX "class_sessions_starts_at_idx" ON "class_sessions"("starts_at");

-- CreateIndex
CREATE INDEX "class_sessions_teacher_id_starts_at_idx" ON "class_sessions"("teacher_id", "starts_at");

-- CreateIndex
CREATE INDEX "class_sessions_student_id_starts_at_idx" ON "class_sessions"("student_id", "starts_at");

-- CreateIndex
CREATE INDEX "class_sessions_enrollment_id_starts_at_idx" ON "class_sessions"("enrollment_id", "starts_at");

-- CreateIndex
CREATE INDEX "class_sessions_stage_starts_at_idx" ON "class_sessions"("stage", "starts_at");

-- CreateIndex
CREATE INDEX "class_sessions_updated_at_id_idx" ON "class_sessions"("updated_at", "id");

-- CreateIndex
CREATE INDEX "class_sessions_zoom_meeting_id_idx" ON "class_sessions"("zoom_meeting_id");

-- CreateIndex
CREATE UNIQUE INDEX "class_sessions_slot_occurrence_key" ON "class_sessions"("schedule_slot_id", "occurrence_date");

-- CreateIndex
CREATE INDEX "session_events_session_id_occurred_at_idx" ON "session_events"("session_id", "occurred_at");

-- CreateIndex
CREATE INDEX "session_events_type_occurred_at_idx" ON "session_events"("type", "occurred_at");

-- CreateIndex
CREATE INDEX "session_requests_status_created_at_idx" ON "session_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "session_requests_student_id_status_idx" ON "session_requests"("student_id", "status");

-- CreateIndex
CREATE INDEX "session_requests_session_id_idx" ON "session_requests"("session_id");

-- CreateIndex
CREATE INDEX "session_requests_requested_by_idx" ON "session_requests"("requested_by");

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_slots" ADD CONSTRAINT "schedule_slots_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_slots" ADD CONSTRAINT "schedule_slots_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_blocks" ADD CONSTRAINT "teacher_blocks_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_work_hours" ADD CONSTRAINT "teacher_work_hours_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zoom_hosts" ADD CONSTRAINT "zoom_hosts_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_schedule_slot_id_fkey" FOREIGN KEY ("schedule_slot_id") REFERENCES "schedule_slots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_origin_session_id_fkey" FOREIGN KEY ("origin_session_id") REFERENCES "class_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_marked_by_fkey" FOREIGN KEY ("marked_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_zoom_host_id_fkey" FOREIGN KEY ("zoom_host_id") REFERENCES "zoom_hosts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "class_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_requests" ADD CONSTRAINT "session_requests_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "class_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_requests" ADD CONSTRAINT "session_requests_result_session_id_fkey" FOREIGN KEY ("result_session_id") REFERENCES "class_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_requests" ADD CONSTRAINT "session_requests_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_requests" ADD CONSTRAINT "session_requests_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_requests" ADD CONSTRAINT "session_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_requests" ADD CONSTRAINT "session_requests_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------- N2 invariants the schema DSL cannot express

-- At most one live (active or paused) enrollment per student and course (Laravel `scheduling.enrollment_exists`).
CREATE UNIQUE INDEX "enrollments_live_student_course_key" ON "enrollments" ("student_id", "course_id")
  WHERE "status" IN ('active', 'paused');

-- At most one pending request of a type per class (Laravel `pending_key`).
CREATE UNIQUE INDEX "session_requests_pending_key" ON "session_requests" ("session_id", "type")
  WHERE "status" = 'pending';

ALTER TABLE "schedule_slots"
  ADD CONSTRAINT "schedule_slots_weekday_check" CHECK ("weekday" BETWEEN 1 AND 7),
  ADD CONSTRAINT "schedule_slots_time_check" CHECK ("local_start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD CONSTRAINT "schedule_slots_duration_check" CHECK ("duration_minutes" BETWEEN 5 AND 1440),
  ADD CONSTRAINT "schedule_slots_validity_check" CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from" - 1);

ALTER TABLE "teacher_work_hours"
  ADD CONSTRAINT "teacher_work_hours_weekday_check" CHECK ("weekday" BETWEEN 1 AND 7);

ALTER TABLE "class_sessions"
  ADD CONSTRAINT "class_sessions_time_check" CHECK ("ends_at" > "starts_at"),
  ADD CONSTRAINT "class_sessions_lock_version_check" CHECK ("lock_version" >= 0);

ALTER TABLE "holidays"
  ADD CONSTRAINT "holidays_range_check" CHECK ("ends_on" IS NULL OR "ends_on" >= "date");

-- The class timeline is append-only (Laravel SessionEvent::updating/deleting throw).
CREATE FUNCTION "session_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'session_events is append-only';
END;
$$;
CREATE TRIGGER "session_events_no_update" BEFORE UPDATE OR DELETE ON "session_events"
  FOR EACH ROW EXECUTE FUNCTION "session_events_append_only"();
