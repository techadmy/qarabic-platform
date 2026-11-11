-- AlterTable
ALTER TABLE "class_sessions" ALTER COLUMN "zoom_join_url" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "enrollments" ALTER COLUMN "external_meeting_url" SET DATA TYPE TEXT;

-- Meeting links are now stored encrypted (AES-256-GCM, `v1:` + base64): a link stored before
-- this change (development data only) cannot be read any more, so it is cleared.
UPDATE "enrollments" SET "external_meeting_url" = NULL
  WHERE "external_meeting_url" IS NOT NULL AND "external_meeting_url" NOT LIKE 'v1:%';
UPDATE "class_sessions" SET "zoom_join_url" = NULL
  WHERE "zoom_join_url" IS NOT NULL AND "zoom_join_url" NOT LIKE 'v1:%';
