import { Clock } from '../src/common/clock.js';
import { FieldCipher } from '../src/common/crypto.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PayRuleEngine } from '../src/payroll/pay-rules.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { addDays, localDate } from '../src/schedule/time.js';
import { SessionGenerator } from '../src/sessions/generator.js';
import { SettingsService } from '../src/settings/settings.service.js';

const DEMO_DOMAIN = 'demo.qarabic.test';
/** Weekday pairs and local start hours per demo student: no teacher or student overlaps. */
const PLAN = [
  { days: [1, 3], hour: 16 },
  { days: [2, 4], hour: 17 },
  { days: [5, 7], hour: 18 },
  { days: [6, 2], hour: 15 },
  { days: [3, 6], hour: 19 },
  { days: [4, 7], hour: 14 },
] as const;

/**
 * Development only: an enrollment with two weekly times for each demo student (in the family's
 * zone, with a made-up external meeting link), then a week of past and a week of upcoming classes
 * from the generator; a few past ones are marked (held, absent, leave) so the board has something
 * to show. Skipped when enrollments exist.
 */
export async function seedDemoSchedule(
  prisma: PrismaClient,
  encryptionKey: string,
): Promise<boolean> {
  const cipher = FieldCipher.fromBase64(encryptionKey);
  if ((await prisma.enrollment.count()) > 0) return false;
  const students = await prisma.student.findMany({
    where: { family: { user: { email: { endsWith: `@${DEMO_DOMAIN}` } } }, archivedAt: null },
    include: { family: true },
    orderBy: { id: 'asc' },
  });
  if (!students.length) return false;
  const today = localDate(Date.now(), 'Africa/Cairo');
  const startsOn = addDays(today, -7);

  for (const [k, s] of students.entries()) {
    if (!s.teacherId || !s.regularCourseId) continue;
    const plan = PLAN[k % PLAN.length]!;
    const e = await prisma.enrollment.create({
      data: {
        studentId: s.id,
        courseId: s.regularCourseId,
        teacherId: s.teacherId,
        kind: s.family.status === 'trial' ? 'trial' : 'regular',
        startsOn: new Date(`${startsOn}T00:00:00Z`),
        timezone: s.family.timezone,
        meetingMode: 'external',
        externalMeetingUrl: cipher.encrypt(`https://meet.example.test/demo-${s.id}`),
        slots: {
          create: plan.days.map((weekday) => ({
            teacherId: s.teacherId!,
            weekday,
            localStartTime: `${String(plan.hour).padStart(2, '0')}:00`,
            durationMinutes: 30,
            timezone: s.family.timezone,
            validFrom: new Date(`${startsOn}T00:00:00Z`),
          })),
        },
      },
    });
    await prisma.statusChange.create({
      data: { subjectType: 'enrollment', subjectId: e.id, toStatus: 'active' },
    });
  }

  const clock = new Clock();
  const settings = new SettingsService(prisma as PrismaService);
  const pay = new PayRuleEngine(prisma as PrismaService, settings);
  const generator = new SessionGenerator(prisma as PrismaService, settings, clock, pay);
  await generator.run({ from: startsOn, to: addDays(today, 7) });

  // Mark the past classes like a real week: mostly held, one absent, one leave.
  const past = await prisma.classSession.findMany({
    where: { startsAt: { lt: new Date(Date.now() - 3_600_000) }, stage: 'scheduled' },
    orderBy: { startsAt: 'asc' },
  });
  for (const [i, s] of past.entries()) {
    const stage = i % 7 === 3 ? 'absent' : i % 7 === 5 ? 'leave' : 'taken';
    await prisma.classSession.update({
      where: { id: s.id },
      data: {
        stage,
        stageReason: stage === 'leave' ? 'student' : null,
        activatedAt: stage === 'leave' ? null : s.startsAt,
        endedAt: stage === 'taken' ? s.endsAt : null,
        markedAt: s.endsAt,
        // N7 pay snapshot, as the state machine writes it.
        ...(await pay.snapshot({ ...s, stage, stageReason: stage === 'leave' ? 'student' : null })),
        updatedAt: new Date(),
      },
    });
  }
  return true;
}
