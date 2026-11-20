import { DEMO_EMAIL_DOMAIN, isDemoEmail } from '../common/demo.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { localDate, toDbDate } from '../schedule/time.js';

/*
| D153: the permanent demo accounts (`pnpm --filter @qarabic/api demo:accounts`, docs/36). Safe to
| run again and again, on production too: it creates what is missing and puts the demo records back
| in shape (active, not archived, flagged demo, the password given), and deletes nothing. It only
| ever touches logins on `@demo.qarabic.test` and the profiles hanging off them.
*/

export const DEMO_ZONE = 'Africa/Cairo';

export interface DemoSlot {
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  weekday: number;
  /** `HH:MM`, Cairo wall time. */
  time: string;
}

export interface DemoPersonas {
  teacher: { email: string; name: string; firstName: string; lastName: string };
  parent: { email: string; name: string };
  students: Array<{ name: string; gender: 'male' | 'female'; age: number; slots: DemoSlot[] }>;
  /** Minutes per class. */
  sessionMinutes: number;
}

export const DEMO_PERSONAS: DemoPersonas = {
  teacher: {
    email: `demo-teacher@${DEMO_EMAIL_DOMAIN}`,
    name: 'معلم تجريبي',
    firstName: 'معلم',
    lastName: 'تجريبي',
  },
  parent: { email: `demo-parent@${DEMO_EMAIL_DOMAIN}`, name: 'ولي أمر تجريبي' },
  students: [
    {
      name: 'طالب تجريبي 1',
      gender: 'male',
      age: 10,
      slots: [
        { weekday: 7, time: '17:00' },
        { weekday: 2, time: '17:00' },
      ],
    },
    {
      name: 'طالب تجريبي 2',
      gender: 'female',
      age: 8,
      slots: [
        { weekday: 1, time: '17:30' },
        { weekday: 3, time: '17:30' },
      ],
    },
  ],
  sessionMinutes: 30,
};

/** The demo teacher's hourly rate (EGP); payroll never pays it (D153). */
const DEMO_HOURLY_RATE = '100.00';

export class DemoAccountsError extends Error {}

export interface DemoAccountsResult {
  created: string[];
  updated: string[];
}

/**
 * Creates or repairs the demo teacher, parent, students and their weekly classes.
 * `passwordHash` is already hashed; the plain password never reaches this function.
 */
export async function ensureDemoAccounts(
  prisma: PrismaClient,
  passwordHash: string,
  nowMs: number,
  personas: DemoPersonas = DEMO_PERSONAS,
): Promise<DemoAccountsResult> {
  for (const email of [personas.teacher.email, personas.parent.email]) {
    if (!isDemoEmail(email)) {
      throw new DemoAccountsError(`Refused: ${email} is not on @${DEMO_EMAIL_DOMAIN}.`);
    }
  }
  const result: DemoAccountsResult = { created: [], updated: [] };
  const note = (created: boolean, what: string) =>
    (created ? result.created : result.updated).push(what);

  await prisma.$transaction(async (tx) => {
    const roles = new Map(
      (await tx.role.findMany({ where: { name: { in: ['teacher', 'parent'] } } })).map((r) => [
        r.name,
        r.id,
      ]),
    );
    if (!roles.has('teacher') || !roles.has('parent')) {
      throw new DemoAccountsError('The teacher and parent roles are missing (run the seed first).');
    }
    const course = await tx.course.findFirst({
      where: { isActive: true, category: 'regular' },
      orderBy: { id: 'asc' },
    });
    if (!course)
      throw new DemoAccountsError('No active regular course to enrol the demo students.');
    const today = localDate(nowMs, DEMO_ZONE);

    const login = async (email: string, name: string, role: string) => {
      const data = {
        name,
        passwordHash,
        roleId: roles.get(role)!,
        timezone: DEMO_ZONE,
        locale: 'ar' as const,
        isActive: true,
        isDemo: true,
        archivedAt: null,
        archivedById: null,
        archiveReason: null,
      };
      const existing = await tx.user.findUnique({ where: { email }, select: { id: true } });
      if (existing) {
        await tx.user.update({ where: { id: existing.id }, data });
        note(false, email);
        return existing.id;
      }
      const user = await tx.user.create({ data: { email, ...data } });
      note(true, email);
      return user.id;
    };

    // --- the teacher
    const teacherUserId = await login(personas.teacher.email, personas.teacher.name, 'teacher');
    const teacherData = {
      firstName: personas.teacher.firstName,
      lastName: personas.teacher.lastName,
      timezone: DEMO_ZONE,
      countryCode: 'EG',
      status: 'active' as const,
      archivedAt: null,
      archivedById: null,
      archiveReason: null,
      // Classes use the platform's Zoom flow or none; no personal link (D151) and no Zoom user.
      zoomJoinUrl: null,
      zoomMeetingId: null,
      acceptsTrials: false,
    };
    const teacher = await tx.teacher.upsert({
      where: { userId: teacherUserId },
      create: { userId: teacherUserId, gender: 'male', ...teacherData },
      update: teacherData,
    });
    await tx.teacherCourse.upsert({
      where: { teacherId_courseId: { teacherId: teacher.id, courseId: course.id } },
      create: { teacherId: teacher.id, courseId: course.id },
      update: {},
    });
    await tx.payProfile.upsert({
      where: { userId: teacherUserId },
      create: {
        userId: teacherUserId,
        teacherId: teacher.id,
        salaryType: 'hourly',
        currency: 'EGP',
        hourlyRate: DEMO_HOURLY_RATE,
      },
      update: { teacherId: teacher.id, salaryType: 'hourly', active: true },
    });

    // --- the family
    const parentUserId = await login(personas.parent.email, personas.parent.name, 'parent');
    const familyData = {
      timezone: DEMO_ZONE,
      countryCode: 'EG',
      status: 'regular' as const,
      archivedAt: null,
      archivedById: null,
      archiveReason: null,
    };
    const family = await tx.family.upsert({
      where: { userId: parentUserId },
      create: { userId: parentUserId, startDate: toDbDate(today), ...familyData },
      update: familyData,
    });

    // --- the students and their weekly classes with the demo teacher
    for (const s of personas.students) {
      const studentData = {
        regularCourseId: course.id,
        teacherId: teacher.id,
        status: 'active' as const,
        archivedAt: null,
        archivedById: null,
        archiveReason: null,
      };
      const found = await tx.student.findFirst({
        where: { familyId: family.id, name: s.name },
        orderBy: { id: 'asc' },
        select: { id: true },
      });
      const student = found
        ? await tx.student.update({ where: { id: found.id }, data: studentData })
        : await tx.student.create({
            data: {
              familyId: family.id,
              name: s.name,
              gender: s.gender,
              age: s.age,
              language: 'arabic',
              startDate: toDbDate(today),
              ...studentData,
            },
          });
      note(!found, `student:${s.name}`);

      const enrollment = await tx.enrollment.findFirst({
        where: { studentId: student.id, teacherId: teacher.id, kind: 'regular', status: 'active' },
        select: { id: true },
      });
      if (enrollment) {
        note(false, `enrollment:${s.name}`);
        continue;
      }
      await tx.enrollment.create({
        data: {
          studentId: student.id,
          courseId: course.id,
          teacherId: teacher.id,
          kind: 'regular',
          status: 'active',
          startsOn: toDbDate(today),
          sessionMinutes: personas.sessionMinutes,
          timezone: DEMO_ZONE,
          meetingMode: 'zoom',
          notes: 'D153 demo account',
          slots: {
            create: s.slots.map((slot) => ({
              teacherId: teacher.id,
              weekday: slot.weekday,
              localStartTime: slot.time,
              durationMinutes: personas.sessionMinutes,
              timezone: DEMO_ZONE,
              validFrom: toDbDate(today),
            })),
          },
        },
      });
      note(true, `enrollment:${s.name}`);
    }
  });
  return result;
}
