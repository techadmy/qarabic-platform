-- S3 typed support requests (docs/32 §3 #4–#7).

-- CreateEnum
CREATE TYPE "TicketRequestState" AS ENUM ('submitted', 'proposed', 'accepted', 'declined', 'approved', 'rejected', 'done');

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "proposal" JSONB,
ADD COLUMN     "request" JSONB,
ADD COLUMN     "request_state" "TicketRequestState";
