import { PasswordsService } from '../src/auth/passwords.service.js';
import { loadEnv } from '../src/config/env.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { createPrismaClient } from '../src/prisma/prisma.service.js';
import { syncRolesAndPermissions } from '../src/rbac/sync-roles.js';
import { seedCourses } from './seed-people.js';

/**
 * `pnpm --filter @qarabic/api qa:seed` — the QA journeys' starting point (apps/web/e2e-journeys,
 * docs/standards/testing.md «Journeys»). Test data only, on a `*_test` database only:
 *
 * 1. empties every table (the journeys start from a known state on every run);
 * 2. roles, permissions and the reference courses;
 * 3. the QA personas, all named «QA …» on `qa.qarabic.test` (no real people), one password from
 *    QA_PASSWORD (CI makes a throwaway one per run): a staff admin, a teacher with a tracked Zoom
 *    personal meeting (made-up ids), a second teacher for trials, a family (parent login) and two
 *    students;
 * 4. the settings the journeys rely on: no minimum class length (a journey ends the class right
 *    away) and class reminders on, to the parents too (the in-app bell; mail/WhatsApp stay off).
 *
 * `--password-for=<email>` instead only sets QA_PASSWORD on one existing QA login.
 *
 * Zoom tracking itself is switched on by the API process's env (ZOOM_DRIVER=s2s + throwaway keys),
 * never here; the journeys post signed webhook events to it, nothing reaches Zoom.
 */

export const QA_DOMAIN = 'qa.qarabic.test';
export const QA_ZOOM = {
  hostId: 'qa-zoom-host-1',
  meetingId: '9000000001',
  joinUrl: 'https://us02web.zoom.us/j/9000000001?pwd=qa',
} as const;

const SETTINGS: Record<string, Prisma.InputJsonValue> = {
  'sessions.min_duration_min': 0,
  'notifications.class_reminders': true,
  'notifications.class_reminders_parents': true,
  'notifications.class_reminder_minutes': 30,
  'notifications.email_enabled': false,
  'notifications.whatsapp_enabled': false,
};

function databaseName(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

async function main(): Promise<void> {
  const env = loadEnv();
  const name = databaseName(env.DATABASE_URL);
  if (env.NODE_ENV === 'production' || !name.endsWith('_test')) {
    throw new Error(`qa:seed runs only on a *_test database (got "${name}").`);
  }
  const password = process.env.QA_PASSWORD;
  if (!password || password.length < 12) throw new Error('Set QA_PASSWORD (12+ characters).');

  const prisma = createPrismaClient(env.DATABASE_URL);
  // `--password-for=<email>`: a login a journey made through the product (e.g. the family J2
  // converts) gets QA_PASSWORD, since mail is off. QA addresses only; nothing else changes.
  const passwordFor = process.argv.find((a) => a.startsWith('--password-for='))?.slice(15);
  if (passwordFor !== undefined) {
    try {
      if (!passwordFor.endsWith(`@${QA_DOMAIN}`)) {
        throw new Error(`--password-for takes a QA address on ${QA_DOMAIN} only.`);
      }
      const { count } = await prisma.user.updateMany({
        where: { email: passwordFor },
        data: { passwordHash: await new PasswordsService().hash(password) },
      });
      if (count !== 1) throw new Error(`No QA login ${passwordFor}.`);
      console.log(`QA password set for ${passwordFor}.`);
    } finally {
      await prisma.$disconnect();
    }
    return;
  }
  try {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    if (tables.length) {
      const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
      await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
    }

    await syncRolesAndPermissions(prisma);
    await seedCourses(prisma);
    const roles = new Map((await prisma.role.findMany()).map((r) => [r.name, r.id]));
    const courses = await prisma.course.findMany({ orderBy: { id: 'asc' } });
    const passwordHash = await new PasswordsService().hash(password);
    const user = (fullName: string, local: string, role: string, timezone: string) =>
      prisma.user.create({
        data: {
          name: fullName,
          email: `${local}@${QA_DOMAIN}`,
          passwordHash,
          roleId: roles.get(role)!,
          timezone,
        },
      });

    const admin = await user('QA Admin', 'qa-admin', 'admin', 'Africa/Cairo');

    const teacherLogin = await user('QA Teacher', 'qa-teacher', 'teacher', 'Africa/Cairo');
    const teacher = await prisma.teacher.create({
      data: {
        userId: teacherLogin.id,
        firstName: 'QA',
        lastName: 'Teacher',
        gender: 'male',
        timezone: 'Africa/Cairo',
        countryCode: 'EG',
        courses: { create: courses.slice(0, 3).map((c) => ({ courseId: c.id })) },
      },
    });
    await prisma.zoomHost.create({
      data: {
        zoomUserId: QA_ZOOM.hostId,
        email: `qa-teacher-zoom@${QA_DOMAIN}`,
        label: 'QA Teacher',
        teacherId: teacher.id,
        pmiMeetingId: QA_ZOOM.meetingId,
      },
    });

    // J2: a second teacher for the trial (its own day, so it never clashes with J1's class).
    const trialLogin = await user('QA Trial Teacher', 'qa-teacher2', 'teacher', 'Africa/Cairo');
    await prisma.teacher.create({
      data: {
        userId: trialLogin.id,
        firstName: 'QA Trial',
        lastName: 'Teacher',
        gender: 'female',
        timezone: 'Africa/Cairo',
        countryCode: 'EG',
        courses: { create: courses.slice(0, 3).map((c) => ({ courseId: c.id })) },
      },
    });

    const parent = await user('QA Parent', 'qa-parent', 'parent', 'Europe/London');
    const family = await prisma.family.create({
      data: {
        userId: parent.id,
        timezone: 'Europe/London',
        countryCode: 'GB',
        status: 'regular',
        managerId: admin.id,
        startDate: new Date('2026-11-01T00:00:00Z'),
      },
    });
    await prisma.student.create({
      data: {
        familyId: family.id,
        name: 'QA Student',
        gender: 'male',
        age: 9,
        language: 'english',
        regularCourseId: courses[2]?.id ?? null,
        teacherId: teacher.id,
      },
    });
    // J4: a second child of the same family for the leave / make-up journey (J1 never sees it).
    await prisma.student.create({
      data: {
        familyId: family.id,
        name: 'QA Leave Student',
        gender: 'female',
        age: 11,
        language: 'english',
        regularCourseId: courses[2]?.id ?? null,
        teacherId: teacher.id,
      },
    });

    for (const [key, value] of Object.entries(SETTINGS)) {
      await prisma.appSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    }
    console.log(`QA personas seeded on ${name} (fake data on ${QA_DOMAIN}).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
