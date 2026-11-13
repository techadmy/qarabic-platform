-- S3 follow-up: who took a typed request's latest step, when, and the note shown to the family.

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "request_decided_at" TIMESTAMPTZ(6),
ADD COLUMN     "request_decided_by" INTEGER,
ADD COLUMN     "request_note" VARCHAR(2000);

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_request_decided_by_fkey" FOREIGN KEY ("request_decided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
