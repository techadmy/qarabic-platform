-- N4 support centre: «تواصل معنا» tickets, timeline, files, WhatsApp intake log (docs/22, docs/32).
-- Sorts after N3 (20261113000000_n3_teaching).


-- CreateEnum
CREATE TYPE "TicketType" AS ENUM ('bug', 'feature');

-- CreateEnum
CREATE TYPE "TicketCategory" AS ENUM ('classes', 'teacher', 'billing', 'technical', 'suggestion', 'other');

-- CreateEnum
CREATE TYPE "TicketChannel" AS ENUM ('in_app', 'whatsapp', 'staff', 'phone');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('p0', 'p1', 'p2', 'p3');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('new', 'triaged', 'in_progress', 'needs_info', 'fixed', 'verified', 'wont_fix');

-- CreateEnum
CREATE TYPE "TicketSubjectType" AS ENUM ('session', 'invoice', 'student');

-- CreateEnum
CREATE TYPE "TicketQueue" AS ENUM ('scheduling', 'billing', 'complaints', 'tech', 'product', 'general');

-- CreateEnum
CREATE TYPE "TicketVisibility" AS ENUM ('normal', 'restricted');

-- CreateEnum
CREATE TYPE "TicketCommentKind" AS ENUM ('comment', 'status', 'priority', 'assignment', 'system');

-- CreateEnum
CREATE TYPE "TicketAttachmentSource" AS ENUM ('screenshot', 'upload', 'whatsapp');

-- CreateTable
CREATE TABLE "tickets" (
    "id" SERIAL NOT NULL,
    "channel" "TicketChannel" NOT NULL DEFAULT 'in_app',
    "type" "TicketType" NOT NULL,
    "category" "TicketCategory" NOT NULL,
    "subcategory" VARCHAR(40),
    "subject_type" "TicketSubjectType",
    "subject_id" INTEGER,
    "queue" "TicketQueue" NOT NULL,
    "visibility" "TicketVisibility" NOT NULL DEFAULT 'normal',
    "family_id" INTEGER,
    "teacher_id" INTEGER,
    "sla_due_at" TIMESTAMPTZ(6),
    "first_response_at" TIMESTAMPTZ(6),
    "sla_breach_notified_at" TIMESTAMPTZ(6),
    "priority" "TicketPriority",
    "status" "TicketStatus" NOT NULL DEFAULT 'new',
    "title" VARCHAR(160) NOT NULL,
    "description" TEXT NOT NULL,
    "reporter_id" INTEGER,
    "reporter_role" VARCHAR(100),
    "contact_phone" TEXT,
    "contact_hash" CHAR(64),
    "area" VARCHAR(40),
    "context" JSONB,
    "pr_url" VARCHAR(300),
    "resolution" TEXT,
    "duplicate_of_id" INTEGER,
    "assignee_id" INTEGER,
    "triaged_at" TIMESTAMPTZ(6),
    "fixed_at" TIMESTAMPTZ(6),
    "verified_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "last_public_at" TIMESTAMPTZ(6),
    "reporter_seen_at" TIMESTAMPTZ(6),
    "whatsapp_window_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_comments" (
    "id" SERIAL NOT NULL,
    "ticket_id" INTEGER NOT NULL,
    "author_id" INTEGER,
    "author_label" VARCHAR(60),
    "kind" "TicketCommentKind" NOT NULL DEFAULT 'comment',
    "body" TEXT,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "meta" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_attachments" (
    "id" SERIAL NOT NULL,
    "ticket_id" INTEGER NOT NULL,
    "comment_id" INTEGER,
    "source" "TicketAttachmentSource" NOT NULL,
    "storage_key" VARCHAR(255) NOT NULL,
    "mime" VARCHAR(100) NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "original_name" VARCHAR(150),
    "pruned_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_inbound_messages" (
    "id" SERIAL NOT NULL,
    "wa_message_id" VARCHAR(191) NOT NULL,
    "from_hash" CHAR(64) NOT NULL,
    "type" VARCHAR(16) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "user_id" INTEGER,
    "ticket_id" INTEGER,
    "error" VARCHAR(200),
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_inbound_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tickets_status_priority_idx" ON "tickets"("status", "priority");

-- CreateIndex
CREATE INDEX "tickets_queue_status_idx" ON "tickets"("queue", "status");

-- CreateIndex
CREATE INDEX "tickets_reporter_id_status_idx" ON "tickets"("reporter_id", "status");

-- CreateIndex
CREATE INDEX "tickets_assignee_id_idx" ON "tickets"("assignee_id");

-- CreateIndex
CREATE INDEX "tickets_family_id_idx" ON "tickets"("family_id");

-- CreateIndex
CREATE INDEX "tickets_teacher_id_idx" ON "tickets"("teacher_id");

-- CreateIndex
CREATE INDEX "tickets_sla_due_at_idx" ON "tickets"("sla_due_at");

-- CreateIndex
CREATE INDEX "tickets_contact_hash_idx" ON "tickets"("contact_hash");

-- CreateIndex
CREATE INDEX "ticket_comments_ticket_id_id_idx" ON "ticket_comments"("ticket_id", "id");

-- CreateIndex
CREATE INDEX "ticket_attachments_ticket_id_idx" ON "ticket_attachments"("ticket_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_inbound_messages_wa_message_id_key" ON "whatsapp_inbound_messages"("wa_message_id");

-- CreateIndex
CREATE INDEX "whatsapp_inbound_messages_status_idx" ON "whatsapp_inbound_messages"("status");

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_duplicate_of_id_fkey" FOREIGN KEY ("duplicate_of_id") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "ticket_comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Hand-written: a subject is a type + id pair, never half of one.
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_subject_pair_check"
  CHECK (("subject_type" IS NULL) = ("subject_id" IS NULL));

-- Hand-written: a closed ticket has its close time; an open one does not.
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_closed_at_check"
  CHECK (("status" IN ('verified', 'wont_fix')) = ("closed_at" IS NOT NULL));
