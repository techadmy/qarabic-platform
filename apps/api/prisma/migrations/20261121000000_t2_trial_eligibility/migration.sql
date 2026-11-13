-- T2 trial eligibility (docs/33 §4.1): per-teacher trial settings.

-- CreateEnum
CREATE TYPE "TeacherAudience" AS ENUM ('children', 'adults', 'both');

-- AlterTable
ALTER TABLE "teachers" ADD COLUMN     "accepts_trials" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "audience" "TeacherAudience" NOT NULL DEFAULT 'both',
ADD COLUMN     "languages" VARCHAR(16)[] DEFAULT ARRAY[]::VARCHAR(16)[],
ADD COLUMN     "max_trials_per_week" SMALLINT;
