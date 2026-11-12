import type { SessionKind, SessionStage, SalaryType } from '../src/generated/prisma/enums.js';
import { PayRuleEngine } from '../src/payroll/pay-rules.js';
import {
  clock,
  createUser,
  m2Enrollment,
  m2Session,
  m2Student,
  m2Teacher,
  signInAs,
  type TestContext,
} from './helpers.js';

/*
| N7 helpers (port of Laravel tests/Feature/M6/Helpers.php). The academy zone is Africa/Cairo; a
| payroll month is a Cairo calendar month, so boundary tests compute instants from the zone.
| Money is a decimal string: Laravel `30000` minor = `"300.00"`.
*/

export interface ProfileAttrs {
  salaryType?: SalaryType;
  currency?: string | null;
  hourlyRate?: string;
  monthlySalary?: string;
  classRate?: string;
  csrRate?: string;
  allowance?: string;
  tax?: string;
  slotTiers?: Array<{ minSlots: number; amount: string }>;
  active?: boolean;
  teacherId?: number | null;
}

/** A pay profile (Laravel `m6Profile`): hourly, PKR, 300.00 per hour by default. */
export function m6Profile(ctx: TestContext, userId: number, attrs: ProfileAttrs = {}) {
  const data = {
    salaryType: attrs.salaryType ?? 'hourly',
    currency: attrs.currency === undefined ? 'PKR' : attrs.currency,
    hourlyRate: attrs.hourlyRate ?? '300.00',
    monthlySalary: attrs.monthlySalary ?? '0',
    classRate: attrs.classRate ?? '0',
    csrRate: attrs.csrRate ?? '0',
    allowance: attrs.allowance ?? '0',
    tax: attrs.tax ?? '0',
    slotTiers: attrs.slotTiers ?? [],
    active: attrs.active ?? true,
    ...(attrs.teacherId !== undefined ? { teacherId: attrs.teacherId } : {}),
  };
  return ctx.prisma.payProfile.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
}

/** A teacher (with login) and a pay profile linked to it. */
export async function m6Teacher(
  ctx: TestContext,
  profile: ProfileAttrs = {},
  zone = 'Africa/Cairo',
) {
  const teacher = await m2Teacher(ctx, zone);
  await m6Profile(ctx, teacher.userId, { teacherId: teacher.id, ...profile });
  return teacher;
}

export async function m6Enrollment(ctx: TestContext, teacher: { id: number }) {
  return m2Enrollment(ctx, await m2Student(ctx, 'Europe/London'), teacher);
}

/** A class in a stage, with its pay snapshot taken by the real rule engine when decided. */
export async function m6Session(
  ctx: TestContext,
  enrollment: { id: number; studentId: number; teacherId: number; courseId: number },
  startsAtUtc: string,
  stage: SessionStage,
  attrs: { stageReason?: string | null; kind?: SessionKind; durationMinutes?: number } = {},
) {
  const s = await m2Session(ctx, enrollment, startsAtUtc, { stage, ...attrs });
  if (['scheduled', 'activated', 'in_progress', 'ended'].includes(stage)) return s;
  const snap = await ctx.app.get(PayRuleEngine).snapshot(s);
  return ctx.prisma.classSession.update({ where: { id: s.id }, data: snap });
}

export const m6At = (ctx: TestContext, utc: string) => clock(ctx).set(utc);

/** A user of a system role (Laravel `userWithRole`) and a signed-in client for them. */
export async function userWithRole(ctx: TestContext, role: string, name?: string) {
  const user = await createUser(ctx, role, name ? { name } : {});
  return { user, client: await signInAs(ctx, user) };
}

/** The payslip of a user for a month, with lines. */
export function m6Slip(ctx: TestContext, userId: number, period = '2026-10') {
  return ctx.prisma.payslip.findFirstOrThrow({
    where: { userId, run: { period } },
    include: { lines: { orderBy: { position: 'asc' } } },
  });
}

/** `{ code: signed amount }` of a payslip (Laravel `m6Lines`). */
export function m6Lines(slip: {
  lines: Array<{ code: string; sign: number; amount: { toFixed(n: number): string } }>;
}) {
  return Object.fromEntries(
    slip.lines.map((l) => [l.code, (l.sign < 0 ? '-' : '') + l.amount.toFixed(2)]),
  );
}
