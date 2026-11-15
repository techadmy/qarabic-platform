-- A1 (docs/42 §4, D148 / B131): teacher availability changes wait for staff approval.
CREATE TYPE "AvailabilityChangeKind" AS ENUM ('work_hours', 'block_create', 'block_update', 'block_delete');
CREATE TYPE "AvailabilityChangeStatus" AS ENUM ('pending', 'approved', 'applied', 'rejected', 'withdrawn');

CREATE TABLE "availability_changes" (
    "id" SERIAL NOT NULL,
    "teacher_id" INTEGER NOT NULL,
    "kind" "AvailabilityChangeKind" NOT NULL,
    "block_id" INTEGER,
    "payload" JSONB NOT NULL,
    "effective_from" DATE NOT NULL,
    "status" "AvailabilityChangeStatus" NOT NULL DEFAULT 'pending',
    "note" VARCHAR(500),
    "requested_by" INTEGER,
    "decided_by" INTEGER,
    "decided_at" TIMESTAMPTZ(6),
    "decision_reason" VARCHAR(500),
    "applied_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "availability_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "availability_changes_status_teacher_id_idx" ON "availability_changes"("status", "teacher_id");
CREATE INDEX "availability_changes_status_effective_from_idx" ON "availability_changes"("status", "effective_from");

ALTER TABLE "availability_changes" ADD CONSTRAINT "availability_changes_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
