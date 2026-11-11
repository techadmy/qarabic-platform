-- CreateEnum
CREATE TYPE "FamilyStatus" AS ENUM ('regular', 'trial', 'on_leave', 'suspended', 'deactivated');

-- CreateEnum
CREATE TYPE "ActiveStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('male', 'female');

-- CreateEnum
CREATE TYPE "StudentLanguage" AS ENUM ('english', 'urdu', 'english_urdu', 'pashto', 'arabic');

-- CreateEnum
CREATE TYPE "CourseCategory" AS ENUM ('regular', 'additional');

-- CreateEnum
CREATE TYPE "PersonType" AS ENUM ('family', 'student', 'teacher', 'staff');

-- AlterTable
ALTER TABLE "roles" ADD COLUMN     "description" VARCHAR(500),
ALTER COLUMN "label_en" DROP NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "archive_reason" VARCHAR(500),
ADD COLUMN     "archived_at" TIMESTAMPTZ(6),
ADD COLUMN     "archived_by" INTEGER,
ADD COLUMN     "phone" VARCHAR(16),
ADD COLUMN     "status_changed_at" TIMESTAMPTZ(6),
ADD COLUMN     "status_changed_by" INTEGER,
ADD COLUMN     "status_reason" VARCHAR(500);

-- CreateTable
CREATE TABLE "courses" (
    "id" SERIAL NOT NULL,
    "name_ar" VARCHAR(120) NOT NULL,
    "name_en" VARCHAR(120) NOT NULL,
    "category" "CourseCategory" NOT NULL DEFAULT 'regular',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "families" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "country_code" CHAR(2),
    "timezone" VARCHAR(64) NOT NULL,
    "manager_id" INTEGER,
    "start_date" DATE,
    "trial_date" DATE,
    "zoom_id" VARCHAR(100),
    "whatsapp_group_id" VARCHAR(100),
    "comment" TEXT,
    "status" "FamilyStatus" NOT NULL DEFAULT 'regular',
    "status_reason" VARCHAR(500),
    "status_changed_at" TIMESTAMPTZ(6),
    "status_changed_by" INTEGER,
    "archived_at" TIMESTAMPTZ(6),
    "archived_by" INTEGER,
    "archive_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "families_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "students" (
    "id" SERIAL NOT NULL,
    "family_id" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "email" VARCHAR(191),
    "gender" "Gender",
    "age" SMALLINT,
    "language" "StudentLanguage",
    "regular_course_id" INTEGER,
    "additional_course_id" INTEGER,
    "teacher_id" INTEGER,
    "start_date" DATE,
    "zoom_id" VARCHAR(100),
    "remark_parent" TEXT,
    "remark_teacher" TEXT,
    "status" "ActiveStatus" NOT NULL DEFAULT 'active',
    "status_reason" VARCHAR(500),
    "status_changed_at" TIMESTAMPTZ(6),
    "status_changed_by" INTEGER,
    "archived_at" TIMESTAMPTZ(6),
    "archived_by" INTEGER,
    "archive_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teachers" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "first_name" VARCHAR(60) NOT NULL,
    "last_name" VARCHAR(60),
    "alt_phone" VARCHAR(16),
    "gender" "Gender",
    "nationality" VARCHAR(60),
    "country_code" CHAR(2),
    "timezone" VARCHAR(64) NOT NULL,
    "age" SMALLINT,
    "hourly_rate" DECIMAL(12,2),
    "hourly_rate_currency" CHAR(3) NOT NULL DEFAULT 'EGP',
    "qualification" TEXT,
    "experience" TEXT,
    "address" VARCHAR(500),
    "skype_id" VARCHAR(100),
    "description" TEXT,
    "status" "ActiveStatus" NOT NULL DEFAULT 'active',
    "status_reason" VARCHAR(500),
    "status_changed_at" TIMESTAMPTZ(6),
    "status_changed_by" INTEGER,
    "archived_at" TIMESTAMPTZ(6),
    "archived_by" INTEGER,
    "archive_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "teachers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teacher_courses" (
    "teacher_id" INTEGER NOT NULL,
    "course_id" INTEGER NOT NULL,

    CONSTRAINT "teacher_courses_pkey" PRIMARY KEY ("teacher_id","course_id")
);

-- CreateTable
CREATE TABLE "status_changes" (
    "id" SERIAL NOT NULL,
    "subject_type" "PersonType" NOT NULL,
    "subject_id" INTEGER NOT NULL,
    "from_status" VARCHAR(32),
    "to_status" VARCHAR(32) NOT NULL,
    "reason" VARCHAR(500),
    "changed_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "status_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" SERIAL NOT NULL,
    "actor_id" INTEGER,
    "action" VARCHAR(64) NOT NULL,
    "subject_type" VARCHAR(64) NOT NULL,
    "subject_id" INTEGER,
    "before" JSONB,
    "after" JSONB,
    "reason" VARCHAR(500),
    "ip" VARCHAR(45),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" VARCHAR(100) NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "courses_name_en_key" ON "courses"("name_en");

-- CreateIndex
CREATE UNIQUE INDEX "families_user_id_key" ON "families"("user_id");

-- CreateIndex
CREATE INDEX "families_status_idx" ON "families"("status");

-- CreateIndex
CREATE INDEX "families_manager_id_idx" ON "families"("manager_id");

-- CreateIndex
CREATE INDEX "families_archived_at_idx" ON "families"("archived_at");

-- CreateIndex
CREATE INDEX "students_family_id_idx" ON "students"("family_id");

-- CreateIndex
CREATE INDEX "students_teacher_id_idx" ON "students"("teacher_id");

-- CreateIndex
CREATE INDEX "students_status_idx" ON "students"("status");

-- CreateIndex
CREATE INDEX "students_archived_at_idx" ON "students"("archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "teachers_user_id_key" ON "teachers"("user_id");

-- CreateIndex
CREATE INDEX "teachers_status_idx" ON "teachers"("status");

-- CreateIndex
CREATE INDEX "teachers_archived_at_idx" ON "teachers"("archived_at");

-- CreateIndex
CREATE INDEX "teacher_courses_course_id_idx" ON "teacher_courses"("course_id");

-- CreateIndex
CREATE INDEX "status_changes_subject_type_subject_id_idx" ON "status_changes"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "audit_logs_subject_type_subject_id_idx" ON "audit_logs"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_idx" ON "audit_logs"("actor_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "roles_label_ar_key" ON "roles"("label_ar");

-- CreateIndex
CREATE UNIQUE INDEX "roles_label_en_key" ON "roles"("label_en");

-- CreateIndex
CREATE INDEX "users_archived_at_idx" ON "users"("archived_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_status_changed_by_fkey" FOREIGN KEY ("status_changed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_archived_by_fkey" FOREIGN KEY ("archived_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "families" ADD CONSTRAINT "families_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "families" ADD CONSTRAINT "families_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "families" ADD CONSTRAINT "families_status_changed_by_fkey" FOREIGN KEY ("status_changed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "families" ADD CONSTRAINT "families_archived_by_fkey" FOREIGN KEY ("archived_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_regular_course_id_fkey" FOREIGN KEY ("regular_course_id") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_additional_course_id_fkey" FOREIGN KEY ("additional_course_id") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_status_changed_by_fkey" FOREIGN KEY ("status_changed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_archived_by_fkey" FOREIGN KEY ("archived_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teachers" ADD CONSTRAINT "teachers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teachers" ADD CONSTRAINT "teachers_status_changed_by_fkey" FOREIGN KEY ("status_changed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teachers" ADD CONSTRAINT "teachers_archived_by_fkey" FOREIGN KEY ("archived_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_courses" ADD CONSTRAINT "teacher_courses_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_courses" ADD CONSTRAINT "teacher_courses_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_changes" ADD CONSTRAINT "status_changes_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Checks the ORM cannot express.
ALTER TABLE "teachers" ADD CONSTRAINT "teachers_hourly_rate_check" CHECK ("hourly_rate" IS NULL OR "hourly_rate" >= 0);
ALTER TABLE "families" ADD CONSTRAINT "families_country_code_check" CHECK ("country_code" IS NULL OR "country_code" ~ '^[A-Z]{2}$');
ALTER TABLE "teachers" ADD CONSTRAINT "teachers_country_code_check" CHECK ("country_code" IS NULL OR "country_code" ~ '^[A-Z]{2}$');
ALTER TABLE "students" ADD CONSTRAINT "students_age_check" CHECK ("age" IS NULL OR "age" BETWEEN 1 AND 120);
