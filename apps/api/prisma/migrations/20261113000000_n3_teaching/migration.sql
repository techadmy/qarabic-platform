-- CreateEnum
CREATE TYPE "HifzType" AS ENUM ('sabaq', 'sabaqi', 'manzil');

-- CreateEnum
CREATE TYPE "HifzGrade" AS ENUM ('excellent', 'very_good', 'good', 'needs_work', 'not_memorised');

-- CreateEnum
CREATE TYPE "TestTrack" AS ENUM ('qaida', 'nazra', 'hifz');

-- CreateEnum
CREATE TYPE "TestStatus" AS ENUM ('scheduled', 'taken', 'refused', 'cancelled');

-- CreateTable
CREATE TABLE "quran_surahs" (
    "number" SMALLINT NOT NULL,
    "name_ar" VARCHAR(64) NOT NULL,
    "name_en" VARCHAR(64) NOT NULL,
    "ayah_count" SMALLINT NOT NULL,
    "juz_start" SMALLINT NOT NULL,

    CONSTRAINT "quran_surahs_pkey" PRIMARY KEY ("number")
);

-- CreateTable
CREATE TABLE "lesson_reports" (
    "id" SERIAL NOT NULL,
    "session_id" INTEGER NOT NULL,
    "student_id" INTEGER NOT NULL,
    "teacher_id" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "homework" TEXT,
    "tajweed_notes" TEXT,
    "teacher_notes" TEXT,
    "rating" SMALLINT,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "submitted_late" BOOLEAN NOT NULL DEFAULT false,
    "submitted_by" INTEGER,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lesson_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hifz_entries" (
    "id" SERIAL NOT NULL,
    "lesson_report_id" INTEGER NOT NULL,
    "session_id" INTEGER NOT NULL,
    "student_id" INTEGER NOT NULL,
    "position" SMALLINT NOT NULL DEFAULT 0,
    "type" "HifzType" NOT NULL,
    "from_surah" SMALLINT NOT NULL,
    "from_ayah" SMALLINT NOT NULL,
    "to_surah" SMALLINT NOT NULL,
    "to_ayah" SMALLINT NOT NULL,
    "ayahs" SMALLINT NOT NULL,
    "pages" DECIMAL(5,2),
    "grade" "HifzGrade",
    "mistakes" SMALLINT,
    "notes" VARCHAR(500),
    "lesson_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hifz_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_tests" (
    "id" SERIAL NOT NULL,
    "student_id" INTEGER NOT NULL,
    "teacher_id" INTEGER NOT NULL,
    "course_id" INTEGER,
    "track" "TestTrack" NOT NULL,
    "sections" TEXT[],
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
    "duration_minutes" SMALLINT NOT NULL DEFAULT 30,
    "student_timezone" VARCHAR(64) NOT NULL,
    "notes" TEXT,
    "status" "TestStatus" NOT NULL DEFAULT 'scheduled',
    "status_reason" VARCHAR(500),
    "tajweed_score" SMALLINT,
    "reading_score" SMALLINT,
    "hifz_score" SMALLINT,
    "overall_score" SMALLINT,
    "mistakes" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "remarks" TEXT,
    "internal_notes" TEXT,
    "teacher_rating" SMALLINT,
    "recorded_at" TIMESTAMPTZ(6),
    "recorded_by" INTEGER,
    "created_by" INTEGER,
    "decided_by" INTEGER,
    "decided_at" TIMESTAMPTZ(6),
    "legacy_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_tests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lesson_reports_session_id_key" ON "lesson_reports"("session_id");

-- CreateIndex
CREATE INDEX "lesson_reports_student_id_submitted_at_idx" ON "lesson_reports"("student_id", "submitted_at");

-- CreateIndex
CREATE INDEX "lesson_reports_teacher_id_submitted_at_idx" ON "lesson_reports"("teacher_id", "submitted_at");

-- CreateIndex
CREATE INDEX "hifz_entries_lesson_report_id_idx" ON "hifz_entries"("lesson_report_id");

-- CreateIndex
CREATE INDEX "hifz_entries_student_id_type_lesson_at_idx" ON "hifz_entries"("student_id", "type", "lesson_at");

-- CreateIndex
CREATE UNIQUE INDEX "student_tests_legacy_id_key" ON "student_tests"("legacy_id");

-- CreateIndex
CREATE INDEX "student_tests_status_scheduled_at_idx" ON "student_tests"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "student_tests_teacher_id_scheduled_at_idx" ON "student_tests"("teacher_id", "scheduled_at");

-- CreateIndex
CREATE INDEX "student_tests_student_id_scheduled_at_idx" ON "student_tests"("student_id", "scheduled_at");

-- AddForeignKey
ALTER TABLE "lesson_reports" ADD CONSTRAINT "lesson_reports_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "class_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_reports" ADD CONSTRAINT "lesson_reports_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_reports" ADD CONSTRAINT "lesson_reports_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_reports" ADD CONSTRAINT "lesson_reports_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_reports" ADD CONSTRAINT "lesson_reports_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hifz_entries" ADD CONSTRAINT "hifz_entries_lesson_report_id_fkey" FOREIGN KEY ("lesson_report_id") REFERENCES "lesson_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hifz_entries" ADD CONSTRAINT "hifz_entries_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_tests" ADD CONSTRAINT "student_tests_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_tests" ADD CONSTRAINT "student_tests_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_tests" ADD CONSTRAINT "student_tests_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_tests" ADD CONSTRAINT "student_tests_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_tests" ADD CONSTRAINT "student_tests_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_tests" ADD CONSTRAINT "student_tests_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------- N3 rules the schema cannot say

-- One scheduled test per student and track (D117): the service checks it under the student lock,
-- this index is the last line of defence.
CREATE UNIQUE INDEX "student_tests_open_student_track_key" ON "student_tests" ("student_id", "track")
  WHERE "status" = 'scheduled';

ALTER TABLE "lesson_reports" ADD CONSTRAINT "lesson_reports_rating_check"
  CHECK ("rating" IS NULL OR "rating" BETWEEN 1 AND 5);
ALTER TABLE "hifz_entries" ADD CONSTRAINT "hifz_entries_range_check"
  CHECK ("from_surah" BETWEEN 1 AND 114 AND "to_surah" BETWEEN 1 AND 114
    AND "from_ayah" >= 1 AND "to_ayah" >= 1 AND "ayahs" >= 0);
ALTER TABLE "student_tests" ADD CONSTRAINT "student_tests_scores_check"
  CHECK ((tajweed_score IS NULL OR tajweed_score BETWEEN 0 AND 100)
    AND (reading_score IS NULL OR reading_score BETWEEN 0 AND 100)
    AND (hifz_score IS NULL OR hifz_score BETWEEN 0 AND 100)
    AND (overall_score IS NULL OR overall_score BETWEEN 0 AND 100)
    AND (teacher_rating IS NULL OR teacher_rating BETWEEN 0 AND 100));

-- The 114 surahs (Hafs), same rows as `@qarabic/shared` QURAN_SURAHS (a test compares them).
INSERT INTO "quran_surahs" ("number", "name_ar", "name_en", "ayah_count", "juz_start") VALUES
  (1, 'الفاتحة', 'Al-Fatihah', 7, 1),
  (2, 'البقرة', 'Al-Baqarah', 286, 1),
  (3, 'آل عمران', 'Al-Imran', 200, 3),
  (4, 'النساء', 'An-Nisa', 176, 4),
  (5, 'المائدة', 'Al-Ma''idah', 120, 6),
  (6, 'الأنعام', 'Al-An''am', 165, 7),
  (7, 'الأعراف', 'Al-A''raf', 206, 8),
  (8, 'الأنفال', 'Al-Anfal', 75, 9),
  (9, 'التوبة', 'At-Tawbah', 129, 10),
  (10, 'يونس', 'Yunus', 109, 11),
  (11, 'هود', 'Hud', 123, 11),
  (12, 'يوسف', 'Yusuf', 111, 12),
  (13, 'الرعد', 'Ar-Ra''d', 43, 13),
  (14, 'إبراهيم', 'Ibrahim', 52, 13),
  (15, 'الحجر', 'Al-Hijr', 99, 14),
  (16, 'النحل', 'An-Nahl', 128, 14),
  (17, 'الإسراء', 'Al-Isra', 111, 15),
  (18, 'الكهف', 'Al-Kahf', 110, 15),
  (19, 'مريم', 'Maryam', 98, 16),
  (20, 'طه', 'Ta-Ha', 135, 16),
  (21, 'الأنبياء', 'Al-Anbiya', 112, 17),
  (22, 'الحج', 'Al-Hajj', 78, 17),
  (23, 'المؤمنون', 'Al-Mu''minun', 118, 18),
  (24, 'النور', 'An-Nur', 64, 18),
  (25, 'الفرقان', 'Al-Furqan', 77, 18),
  (26, 'الشعراء', 'Ash-Shu''ara', 227, 19),
  (27, 'النمل', 'An-Naml', 93, 19),
  (28, 'القصص', 'Al-Qasas', 88, 20),
  (29, 'العنكبوت', 'Al-Ankabut', 69, 20),
  (30, 'الروم', 'Ar-Rum', 60, 21),
  (31, 'لقمان', 'Luqman', 34, 21),
  (32, 'السجدة', 'As-Sajdah', 30, 21),
  (33, 'الأحزاب', 'Al-Ahzab', 73, 21),
  (34, 'سبأ', 'Saba', 54, 22),
  (35, 'فاطر', 'Fatir', 45, 22),
  (36, 'يس', 'Ya-Sin', 83, 22),
  (37, 'الصافات', 'As-Saffat', 182, 23),
  (38, 'ص', 'Sad', 88, 23),
  (39, 'الزمر', 'Az-Zumar', 75, 23),
  (40, 'غافر', 'Ghafir', 85, 24),
  (41, 'فصلت', 'Fussilat', 54, 24),
  (42, 'الشورى', 'Ash-Shura', 53, 25),
  (43, 'الزخرف', 'Az-Zukhruf', 89, 25),
  (44, 'الدخان', 'Ad-Dukhan', 59, 25),
  (45, 'الجاثية', 'Al-Jathiyah', 37, 25),
  (46, 'الأحقاف', 'Al-Ahqaf', 35, 26),
  (47, 'محمد', 'Muhammad', 38, 26),
  (48, 'الفتح', 'Al-Fath', 29, 26),
  (49, 'الحجرات', 'Al-Hujurat', 18, 26),
  (50, 'ق', 'Qaf', 45, 26),
  (51, 'الذاريات', 'Adh-Dhariyat', 60, 26),
  (52, 'الطور', 'At-Tur', 49, 27),
  (53, 'النجم', 'An-Najm', 62, 27),
  (54, 'القمر', 'Al-Qamar', 55, 27),
  (55, 'الرحمن', 'Ar-Rahman', 78, 27),
  (56, 'الواقعة', 'Al-Waqi''ah', 96, 27),
  (57, 'الحديد', 'Al-Hadid', 29, 27),
  (58, 'المجادلة', 'Al-Mujadilah', 22, 28),
  (59, 'الحشر', 'Al-Hashr', 24, 28),
  (60, 'الممتحنة', 'Al-Mumtahanah', 13, 28),
  (61, 'الصف', 'As-Saff', 14, 28),
  (62, 'الجمعة', 'Al-Jumu''ah', 11, 28),
  (63, 'المنافقون', 'Al-Munafiqun', 11, 28),
  (64, 'التغابن', 'At-Taghabun', 18, 28),
  (65, 'الطلاق', 'At-Talaq', 12, 28),
  (66, 'التحريم', 'At-Tahrim', 12, 28),
  (67, 'الملك', 'Al-Mulk', 30, 29),
  (68, 'القلم', 'Al-Qalam', 52, 29),
  (69, 'الحاقة', 'Al-Haqqah', 52, 29),
  (70, 'المعارج', 'Al-Ma''arij', 44, 29),
  (71, 'نوح', 'Nuh', 28, 29),
  (72, 'الجن', 'Al-Jinn', 28, 29),
  (73, 'المزمل', 'Al-Muzzammil', 20, 29),
  (74, 'المدثر', 'Al-Muddaththir', 56, 29),
  (75, 'القيامة', 'Al-Qiyamah', 40, 29),
  (76, 'الإنسان', 'Al-Insan', 31, 29),
  (77, 'المرسلات', 'Al-Mursalat', 50, 29),
  (78, 'النبأ', 'An-Naba', 40, 30),
  (79, 'النازعات', 'An-Nazi''at', 46, 30),
  (80, 'عبس', 'Abasa', 42, 30),
  (81, 'التكوير', 'At-Takwir', 29, 30),
  (82, 'الانفطار', 'Al-Infitar', 19, 30),
  (83, 'المطففين', 'Al-Mutaffifin', 36, 30),
  (84, 'الانشقاق', 'Al-Inshiqaq', 25, 30),
  (85, 'البروج', 'Al-Buruj', 22, 30),
  (86, 'الطارق', 'At-Tariq', 17, 30),
  (87, 'الأعلى', 'Al-A''la', 19, 30),
  (88, 'الغاشية', 'Al-Ghashiyah', 26, 30),
  (89, 'الفجر', 'Al-Fajr', 30, 30),
  (90, 'البلد', 'Al-Balad', 20, 30),
  (91, 'الشمس', 'Ash-Shams', 15, 30),
  (92, 'الليل', 'Al-Layl', 21, 30),
  (93, 'الضحى', 'Ad-Duha', 11, 30),
  (94, 'الشرح', 'Ash-Sharh', 8, 30),
  (95, 'التين', 'At-Tin', 8, 30),
  (96, 'العلق', 'Al-Alaq', 19, 30),
  (97, 'القدر', 'Al-Qadr', 5, 30),
  (98, 'البينة', 'Al-Bayyinah', 8, 30),
  (99, 'الزلزلة', 'Az-Zalzalah', 8, 30),
  (100, 'العاديات', 'Al-Adiyat', 11, 30),
  (101, 'القارعة', 'Al-Qari''ah', 11, 30),
  (102, 'التكاثر', 'At-Takathur', 8, 30),
  (103, 'العصر', 'Al-Asr', 3, 30),
  (104, 'الهمزة', 'Al-Humazah', 9, 30),
  (105, 'الفيل', 'Al-Fil', 5, 30),
  (106, 'قريش', 'Quraysh', 4, 30),
  (107, 'الماعون', 'Al-Ma''un', 7, 30),
  (108, 'الكوثر', 'Al-Kawthar', 3, 30),
  (109, 'الكافرون', 'Al-Kafirun', 6, 30),
  (110, 'النصر', 'An-Nasr', 3, 30),
  (111, 'المسد', 'Al-Masad', 5, 30),
  (112, 'الإخلاص', 'Al-Ikhlas', 4, 30),
  (113, 'الفلق', 'Al-Falaq', 5, 30),
  (114, 'الناس', 'An-Nas', 6, 30);
