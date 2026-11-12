import type { AuditService } from '../audit/audit.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { Tx } from '../people/people.common.js';
import { cents, fromCents } from './money.js';

/**
 * A teacher's hourly rate has one source of truth: the pay profile (D89; Laravel
 * `TeacherPayRate` + `PeopleService::syncPayProfile`). The N1 `teachers.hourly_rate` columns moved
 * into `pay_profiles` with the N7 migration; the teacher form still shows and edits the rate.
 */

/** What the teacher form shows: the profile's hourly rate (null when none or 0) and its currency. */
export function teacherRate(
  profile: { hourlyRate: Prisma.Decimal; currency: string | null } | null | undefined,
  defaultCurrency: string,
): { hourlyRate: string | null; hourlyRateCurrency: string } {
  const minor = profile ? cents(profile.hourlyRate) : 0;
  return {
    hourlyRate: minor > 0 ? fromCents(minor) : null,
    hourlyRateCurrency: profile?.currency ?? defaultCurrency,
  };
}

/**
 * The rate edited on the teacher form: an hourly profile is created on the first rate, an existing
 * profile follows the rate (whatever its salary type; only hourly pay uses it). The currency is the
 * profile's (set by payroll) or the default one: People never sets another currency.
 */
export async function syncTeacherPayProfile(
  tx: Tx,
  audit: AuditService,
  teacher: { id: number; userId: number },
  hourlyRate: string | null | undefined,
  defaultCurrency: string,
  actorId: number,
): Promise<void> {
  if (hourlyRate === undefined) return;
  await tx.$queryRaw`SELECT id FROM "pay_profiles" WHERE user_id = ${teacher.userId} FOR UPDATE`;
  const profile = await tx.payProfile.findUnique({ where: { userId: teacher.userId } });
  const rate = hourlyRate === null ? 0 : cents(hourlyRate);
  if (!profile) {
    if (rate <= 0) return;
    const created = await tx.payProfile.create({
      data: {
        userId: teacher.userId,
        teacherId: teacher.id,
        salaryType: 'hourly',
        currency: defaultCurrency,
        hourlyRate: fromCents(rate),
        active: true,
        updatedById: actorId,
      },
    });
    await audit.record(
      {
        actorId,
        action: 'salary_profile_saved',
        subjectType: 'pay_profile',
        subjectId: created.id,
        after: { salaryType: 'hourly', hourlyRate: fromCents(rate), currency: defaultCurrency },
        reason: 'teacher_profile',
      },
      tx,
    );
    return;
  }
  const currency = profile.currency ?? defaultCurrency;
  if (cents(profile.hourlyRate) === rate && profile.currency === currency) return;
  await tx.payProfile.update({
    where: { id: profile.id },
    data: { hourlyRate: fromCents(rate), currency, teacherId: teacher.id, updatedById: actorId },
  });
  await audit.record(
    {
      actorId,
      action: 'salary_profile_saved',
      subjectType: 'pay_profile',
      subjectId: profile.id,
      before: { hourlyRate: profile.hourlyRate.toFixed(2), currency: profile.currency },
      after: { hourlyRate: fromCents(rate), currency },
      reason: 'teacher_profile',
    },
    tx,
  );
}
