import {
  ayahCountOf,
  ayahsInRange,
  overallScore,
  tajweedScore,
  TEST_SECTIONS,
} from '@qarabic/shared';
import type { PrismaClient } from '../src/generated/prisma/client.js';

const DEMO_DOMAIN = 'demo.qarabic.test';
const HOUR = 3_600_000;
const SUMMARIES = [
  'راجع الطالب الدرس السابق وحفظ الآيات الجديدة بإتقان.',
  'قراءة جيدة مع ملاحظات بسيطة على المدود.',
  'أحسن الطالب في التسميع، ويحتاج إلى مزيد من المراجعة.',
];

/**
 * Development only (fake data): a lesson report with hifz rows for every past held class of the
 * demo students — each child memorises Juz Amma backwards from An-Nas, a few ayahs a class — the
 * latest held class of the first student left without a report (so «بلا تقرير» has a row), and
 * three student tests (one upcoming, one taken, one refused). Skipped when reports exist.
 */
export async function seedDemoTeaching(prisma: PrismaClient): Promise<boolean> {
  if ((await prisma.lessonReport.count()) > 0) return false;
  const students = await prisma.student.findMany({
    where: { family: { user: { email: { endsWith: `@${DEMO_DOMAIN}` } } }, archivedAt: null },
    orderBy: { id: 'asc' },
  });
  if (!students.length) return false;
  const now = Date.now();

  for (const [k, student] of students.entries()) {
    const held = await prisma.classSession.findMany({
      where: { studentId: student.id, stage: 'taken', deletedAt: null },
      include: { teacher: { select: { userId: true } } },
      orderBy: { startsAt: 'asc' },
    });
    // Position: surah 114 ayah 1, moving towards An-Naba.
    let surah = 114;
    let ayah = 1;
    let previous: { surah: number; from: number; to: number } | null = null;
    for (const [i, s] of held.entries()) {
      if (k === 0 && i === held.length - 1) {
        await prisma.classSession.update({
          where: { id: s.id },
          data: { stage: 'ended', markedAt: null, updatedAt: new Date() },
        });
        continue;
      }
      const to = Math.min(ayahCountOf(surah), ayah + 3);
      const sabaq = { surah, from: ayah, to };
      const ended = (s.endedAt ?? s.endsAt).getTime();
      const submittedAt = new Date(ended + (i % 4 === 3 ? 30 : 0.25) * HOUR);
      const dueAt = new Date(ended + 24 * HOUR);
      const rows = [
        { type: 'sabaq' as const, ...sabaq, grade: 'very_good' as const, mistakes: i % 3 },
        ...(previous
          ? [{ type: 'sabaqi' as const, ...previous, grade: 'excellent' as const }]
          : []),
        { type: 'manzil' as const, surah: 1, from: 1, to: 7, grade: 'good' as const },
      ];
      await prisma.lessonReport.create({
        data: {
          sessionId: s.id,
          studentId: student.id,
          teacherId: s.teacherId,
          summary: SUMMARIES[i % SUMMARIES.length]!,
          homework: `مراجعة سورة رقم ${surah} من الآية ${ayah} إلى ${to}`,
          tajweedNotes: i % 2 ? 'الانتباه إلى أحكام النون الساكنة.' : null,
          teacherNotes: i % 5 === 4 ? 'تأخر الطالب خمس دقائق.' : null,
          rating: 3 + (i % 3),
          dueAt,
          submittedLate: submittedAt > dueAt,
          submittedAt,
          submittedById: s.teacher.userId,
          createdAt: submittedAt,
          updatedAt: submittedAt,
          hifz: {
            create: rows.map((r, position) => ({
              sessionId: s.id,
              studentId: student.id,
              position,
              type: r.type,
              fromSurah: r.surah,
              fromAyah: r.from,
              toSurah: r.surah,
              toAyah: r.to,
              ayahs: ayahsInRange({ surah: r.surah, ayah: r.from }, { surah: r.surah, ayah: r.to }),
              grade: r.grade,
              mistakes: 'mistakes' in r ? r.mistakes : null,
              lessonAt: s.startsAt,
              createdAt: submittedAt,
            })),
          },
        },
      });
      previous = sabaq;
      ayah = to + 1;
      if (ayah > ayahCountOf(surah)) {
        surah -= 1;
        ayah = 1;
      }
    }
  }

  // Three tests: upcoming, taken (with a result), refused.
  const withTeacher = students.filter((s) => s.teacherId);
  const all = TEST_SECTIONS.map((s) => s.key);
  const plans = [
    { status: 'scheduled' as const, track: 'hifz' as const, at: now + 2 * 24 * HOUR },
    { status: 'taken' as const, track: 'nazra' as const, at: now - 3 * 24 * HOUR },
    { status: 'refused' as const, track: 'qaida' as const, at: now - 5 * 24 * HOUR },
  ];
  for (const [i, plan] of plans.entries()) {
    const student = withTeacher[i % withTeacher.length];
    if (!student) break;
    const family = await prisma.family.findUniqueOrThrow({ where: { id: student.familyId } });
    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { id: student.teacherId! } });
    const mistakes = plan.status === 'taken' ? [7, 22] : [];
    const tajweed = tajweedScore(all, mistakes);
    await prisma.studentTest.create({
      data: {
        studentId: student.id,
        teacherId: teacher.id,
        courseId: student.regularCourseId,
        track: plan.track,
        sections: all,
        scheduledAt: new Date(Math.floor(plan.at / HOUR) * HOUR),
        studentTimezone: family.timezone,
        status: plan.status,
        statusReason: plan.status === 'refused' ? 'لم يحضر الطالب' : null,
        ...(plan.status === 'taken'
          ? {
              mistakes,
              tajweedScore: tajweed,
              readingScore: 75,
              overallScore: overallScore('nazra', tajweed, 75),
              remarks: 'أداء جيد، مع ملاحظة المدود.',
              recordedAt: new Date(plan.at + HOUR),
              recordedById: teacher.userId,
            }
          : {}),
        ...(plan.status === 'refused'
          ? { decidedAt: new Date(plan.at + HOUR), decidedById: teacher.userId }
          : {}),
        createdById: teacher.userId,
      },
    });
  }
  return true;
}
