import { randomBytes } from 'node:crypto';
import { PasswordsService } from '../src/auth/passwords.service.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';

/**
 * Reference courses (every environment). The old system's tracks: Noorani Qaida, Nazra (reading
 * from the mushaf) and Hifz (docs/27: course 1 Qaida / 2 Nazra / 3 Hifz), plus the additional
 * subjects. The live list (with its ids) comes over in the N8 data move; this only fills an empty
 * database. Matched on the English name, so a rerun never duplicates or renames anything.
 */
export const COURSES = [
  { nameEn: 'Noorani Qaida', nameAr: 'القاعدة النورانية', category: 'regular' },
  { nameEn: 'Quran Reading (Nazra)', nameAr: 'تلاوة القرآن نظرًا', category: 'regular' },
  { nameEn: 'Quran Hifz', nameAr: 'حفظ القرآن الكريم', category: 'regular' },
  { nameEn: 'Tajweed', nameAr: 'التجويد', category: 'additional' },
  { nameEn: 'Arabic Language', nameAr: 'اللغة العربية', category: 'additional' },
  { nameEn: 'Islamic Studies', nameAr: 'الدراسات الإسلامية', category: 'additional' },
] as const;

export async function seedCourses(prisma: PrismaClient): Promise<void> {
  for (const course of COURSES) {
    await prisma.course.upsert({ where: { nameEn: course.nameEn }, create: course, update: {} });
  }
}

const DEMO_DOMAIN = 'demo.qarabic.test';

/**
 * Development only: a few made-up staff, teachers, families and students so the People screens
 * have something to show. Every name is invented and every email is on `demo.qarabic.test`
 * (no real people). Logins get a random password; use «نسيت كلمة المرور» or set one in SQL.
 * Skipped when the demo data is already there.
 */
export async function seedDemoPeople(prisma: PrismaClient): Promise<boolean> {
  if (await prisma.user.findFirst({ where: { email: { endsWith: `@${DEMO_DOMAIN}` } } })) {
    return false;
  }
  const passwords = new PasswordsService();
  const passwordHash = await passwords.hash(randomBytes(32).toString('base64url'));
  const roles = new Map((await prisma.role.findMany()).map((r) => [r.name, r.id]));
  const courses = await prisma.course.findMany({ orderBy: { id: 'asc' } });
  const user = (name: string, local: string, role: string, phone: string, timezone: string) =>
    prisma.user.create({
      data: {
        name,
        email: `${local}@${DEMO_DOMAIN}`,
        phone,
        passwordHash,
        roleId: roles.get(role)!,
        timezone,
      },
    });

  const manager = await user('Demo Manager', 'manager', 'manager', '+201000000101', 'Africa/Cairo');
  await user('Demo Monitor', 'monitor', 'monitor', '+201000000102', 'Africa/Cairo');
  await user('Demo CSR', 'csr', 'csr', '+201000000103', 'Africa/Cairo');

  const teachers = [];
  for (const [i, [first, last, gender]] of (
    [
      ['Demo', 'Teacher One', 'male'],
      ['Demo', 'Teacher Two', 'female'],
    ] as const
  ).entries()) {
    const login = await user(
      `${first} ${last}`,
      `teacher${i + 1}`,
      'teacher',
      `+20100000020${i + 1}`,
      'Africa/Cairo',
    );
    teachers.push(
      await prisma.teacher.create({
        data: {
          userId: login.id,
          firstName: first,
          lastName: last,
          gender,
          timezone: 'Africa/Cairo',
          countryCode: 'EG',
          hourlyRate: '100.00',
          courses: { create: courses.slice(0, 3).map((c) => ({ courseId: c.id })) },
        },
      }),
    );
  }

  const families = [
    { parent: 'Demo Parent London', zone: 'Europe/London', country: 'GB', status: 'regular' },
    { parent: 'Demo Parent Toronto', zone: 'America/Toronto', country: 'CA', status: 'regular' },
    { parent: 'Demo Parent Sydney', zone: 'Australia/Sydney', country: 'AU', status: 'trial' },
  ] as const;
  for (const [i, f] of families.entries()) {
    const login = await user(f.parent, `parent${i + 1}`, 'parent', `+1555000030${i + 1}`, f.zone);
    const family = await prisma.family.create({
      data: {
        userId: login.id,
        timezone: f.zone,
        countryCode: f.country,
        status: f.status,
        managerId: manager.id,
        startDate: new Date('2026-11-01T00:00:00Z'),
      },
    });
    for (const [j, child] of ['Child A', 'Child B'].entries()) {
      await prisma.student.create({
        data: {
          familyId: family.id,
          name: `Demo ${child} ${i + 1}`,
          gender: j === 0 ? 'male' : 'female',
          age: 7 + j * 3,
          language: 'english',
          regularCourseId: courses[j]?.id ?? null,
          teacherId: teachers[(i + j) % teachers.length]!.id,
        },
      });
    }
  }
  return true;
}
