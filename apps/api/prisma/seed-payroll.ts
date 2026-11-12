import type { PrismaClient } from '../src/generated/prisma/client.js';

const DEMO_DOMAIN = 'demo.qarabic.test';
const day = (d: string) => new Date(`${d}T00:00:00Z`);

/**
 * Development only (fake data, N7): a monthly pay profile for the demo staff, a few attendance
 * days, one pending leave request and one proposed fine for the first demo teacher. No payroll run
 * is created (run `payroll:compute` or use the screen). Skipped when any leave request exists.
 * Nothing here moves money or sends a message.
 */
export async function seedDemoPayroll(prisma: PrismaClient): Promise<boolean> {
  if ((await prisma.leaveRequest.count()) > 0) return false;
  const teachers = await prisma.teacher.findMany({
    where: { user: { email: { endsWith: `@${DEMO_DOMAIN}` } } },
    orderBy: { id: 'asc' },
  });
  if (!teachers.length) return false;
  const staff = await prisma.user.findMany({
    where: {
      email: { endsWith: `@${DEMO_DOMAIN}` },
      role: { kind: 'staff' },
      payProfile: null,
    },
    orderBy: { id: 'asc' },
  });
  for (const u of staff) {
    await prisma.payProfile.create({
      data: {
        userId: u.id,
        salaryType: 'monthly',
        currency: 'EGP',
        monthlySalary: '8000.00',
        hourlyRate: '0',
      },
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  const first = teachers[0]!;
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const checkIn = new Date(`${yesterday}T06:00:00Z`);
  await prisma.staffAttendance.create({
    data: {
      userId: first.userId,
      workDate: day(yesterday),
      status: 'present',
      checkInAt: checkIn,
      checkOutAt: new Date(checkIn.getTime() + 6 * 3_600_000),
      workedMinutes: 360,
      timezone: first.timezone,
      source: 'self',
    },
  });
  const inAWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  await prisma.leaveRequest.create({
    data: {
      userId: first.userId,
      startsOn: day(inAWeek),
      endsOn: day(inAWeek),
      days: 1,
      leaveType: 'paid',
      reason: 'موعد طبي',
      status: 'pending',
      requestedById: first.userId,
    },
  });
  await prisma.payAdjustment.create({
    data: {
      userId: first.userId,
      type: 'fine',
      amount: '25.00',
      currency: 'EGP',
      effectiveOn: day(today),
      reason: 'تأخر عن بداية الحصة أكثر من خمس دقائق',
      status: 'proposed',
    },
  });
  return true;
}
