-- D151: the teacher's personal Zoom link (encrypted) and its meeting id; enrollments default to it.
ALTER TYPE "MeetingMode" ADD VALUE 'teacher';

ALTER TABLE "teachers" ADD COLUMN "zoom_join_url" TEXT,
ADD COLUMN "zoom_meeting_id" VARCHAR(20);

CREATE UNIQUE INDEX "teachers_zoom_meeting_id_key" ON "teachers"("zoom_meeting_id");
