-- M8 operations (docs/09 M16–M17): tasks and their timeline, task templates, announcements and
-- read receipts, notification preferences and class reminder claims.

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('pending', 'awaiting', 'completed', 'closed');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('low', 'normal', 'high');

-- CreateEnum
CREATE TYPE "AnnouncementStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateTable
CREATE TABLE "tasks" (
    "id" SERIAL NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'pending',
    "priority" "TaskPriority" NOT NULL DEFAULT 'normal',
    "due_at" TIMESTAMPTZ(6),
    "assignee_id" INTEGER NOT NULL,
    "created_by" INTEGER NOT NULL,
    "subject_type" VARCHAR(16),
    "subject_id" INTEGER,
    "template_id" INTEGER,
    "submitted_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "close_reason" VARCHAR(2000),
    "due_notified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_events" (
    "id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "body" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "author_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_templates" (
    "id" SERIAL NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "priority" "TaskPriority" NOT NULL DEFAULT 'normal',
    "due_in_days" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcements" (
    "id" SERIAL NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "audience" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "status" "AnnouncementStatus" NOT NULL DEFAULT 'draft',
    "published_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement_reads" (
    "announcement_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "read_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "announcement_reads_pkey" PRIMARY KEY ("announcement_id","user_id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "user_id" INTEGER NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "in_app" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT false,
    "whatsapp" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id","kind")
);

-- CreateTable
CREATE TABLE "class_reminders" (
    "session_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "class_reminders_pkey" PRIMARY KEY ("session_id","user_id")
);

-- CreateIndex
CREATE INDEX "tasks_assignee_id_status_idx" ON "tasks"("assignee_id", "status");

-- CreateIndex
CREATE INDEX "tasks_created_by_status_idx" ON "tasks"("created_by", "status");

-- CreateIndex
CREATE INDEX "tasks_status_due_at_idx" ON "tasks"("status", "due_at");

-- CreateIndex
CREATE INDEX "tasks_subject_type_subject_id_idx" ON "tasks"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "task_events_task_id_id_idx" ON "task_events"("task_id", "id");

-- CreateIndex
CREATE INDEX "announcements_status_published_at_idx" ON "announcements"("status", "published_at");

-- CreateIndex
CREATE INDEX "announcement_reads_user_id_idx" ON "announcement_reads"("user_id");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "task_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_templates" ADD CONSTRAINT "task_templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_reminders" ADD CONSTRAINT "class_reminders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Integrity --------------------------------------------------------------------------------------
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_subject_check"
  CHECK (("subject_type" IS NULL) = ("subject_id" IS NULL));
ALTER TABLE "task_templates" ADD CONSTRAINT "task_templates_due_check"
  CHECK ("due_in_days" IS NULL OR "due_in_days" BETWEEN 0 AND 365);

-- The task timeline is append-only.
CREATE FUNCTION "task_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'task_events is append-only';
END;
$$;
CREATE TRIGGER "task_events_no_update" BEFORE UPDATE OR DELETE ON "task_events"
  FOR EACH ROW EXECUTE FUNCTION "task_events_append_only"();
