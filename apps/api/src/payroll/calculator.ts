import { Injectable } from '@nestjs/common';
import { adjustmentSign, type PayslipIssue, type SalaryType } from '@qarabic/shared';
import type { PayProfile } from '../generated/prisma/client.js';
import type { Tx } from '../people/people.common.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { toDbDate } from '../schedule/time.js';
import type { SettingsMap } from '../settings/settings.service.js';
import { centi, cents, divRound, fromCents, hours } from './money.js';
import { Period } from './period.js';
import { isDeductible, slotTiers } from './presenter.js';

type Db = PrismaService | Tx;

/** Stages not decided yet (no pay snapshot). */
const UNDECIDED = ['scheduled', 'activated', 'in_progress', 'ended'];

export interface ComputedLine {
  code: string;
  sign: 1 | -1;
  /** Decimal string (hours, classes, days, conversions) or null. */
  quantity: string | null;
  rateMinor: number | null;
  amountMinor: number;
  payAdjustmentId: number | null;
  position: number;
}

export interface ComputedSession {
  sessionId: number;
  startsAt: Date;
  kind: string;
  stage: string;
  payHours: string;
  payRuleKey: string | null;
}

export interface ComputedSlip {
  userId: number;
  teacherId: number | null;
  currency: string;
  salaryType: SalaryType;
  rates: Record<string, unknown>;
  lines: ComputedLine[];
  sessions: ComputedSession[];
  paidHours: string;
  paidClasses: number;
  deductionDays: number;
  earningsMinor: number;
  deductionsMinor: number;
  netMinor: number;
  warnings: PayslipIssue[];
  errors: PayslipIssue[];
}

/** The rate snapshot stored on a payslip. */
export function ratesOf(p: PayProfile): Record<string, unknown> {
  return {
    monthlySalary: p.monthlySalary.toFixed(2),
    classRate: p.classRate.toFixed(2),
    hourlyRate: p.hourlyRate.toFixed(2),
    csrRate: p.csrRate.toFixed(2),
    allowance: p.allowance.toFixed(2),
    tax: p.tax.toFixed(2),
    slotTiers: slotTiers(p.slotTiers),
  };
}

/** Old per-slot rule: the flat amount of the highest tier whose threshold is reached. */
export function slotTier(
  tiers: Array<{ minSlots: number; amount: string }>,
  centiSlots: number,
): number | null {
  let best: number | null = null;
  let bestMin = -1;
  for (const t of tiers) {
    const min = Math.round(t.minSlots * 100);
    if (min <= centiSlots && min > bestMin) {
      best = cents(t.amount);
      bestMin = min;
    }
  }
  return best;
}

/**
 * Computes one person's payslip for one month (docs/21 §4; Laravel `PayrollCalculator`). Pure read:
 * the caller stores it. Hours and classes come from the pay snapshot every class gets when its
 * stage is decided (`class_sessions.pay_hours`, D41/D56), so declined / trial / extra follow the
 * pay rules (B5, B22, B23). Every line is an integer in minor units; a product is rounded half-up
 * once per line (D90).
 */
@Injectable()
export class PayrollCalculator {
  async compute(
    db: Db,
    profile: PayProfile,
    period: Period,
    st: SettingsMap,
    nowMs: number,
  ): Promise<ComputedSlip> {
    const zone = st['academy.timezone'];
    const lines: Omit<ComputedLine, 'position'>[] = [];
    const warnings: PayslipIssue[] = [];
    const errors: PayslipIssue[] = [];
    const type = profile.salaryType;
    // No currency on the profile → the payroll default (EGP), never a blocking error.
    const currency = profile.currency ?? st['payroll.default_currency'];
    const line = (
      code: string,
      sign: 1 | -1,
      quantity: string | null,
      rateMinor: number | null,
      amountMinor: number,
      payAdjustmentId: number | null = null,
    ) => lines.push({ code, sign, quantity, rateMinor, amountMinor, payAdjustmentId });

    // --- classes -------------------------------------------------------------
    const sessions = profile.teacherId
      ? await this.sessions(db, profile.teacherId, period, zone)
      : [];
    if (!profile.teacherId && type !== 'monthly') warnings.push({ code: 'no_teacher_link' });
    const paid = sessions.filter((s) => centi(s.payHours) > 0);
    const centiHours = paid.reduce((a, s) => a + centi(s.payHours), 0);
    const classes = paid.length;

    const undecided = sessions.filter(
      (s) => UNDECIDED.includes(s.stage) && s.startsAt.getTime() < nowMs,
    ).length;
    if (undecided > 0) warnings.push({ code: 'unmarked_sessions', count: undecided });
    const review = sessions.filter((s) => s.needsReview).length;
    if (review > 0) warnings.push({ code: 'sessions_need_review', count: review });

    // --- earnings ------------------------------------------------------------
    const monthly = cents(profile.monthlySalary);
    if (monthly > 0) line('monthly_salary', 1, null, null, monthly);
    switch (type) {
      case 'per_class': {
        const rate = cents(profile.classRate);
        line('class_earning', 1, `${classes}.00`, rate, classes * rate);
        break;
      }
      case 'hourly': {
        const rate = cents(profile.hourlyRate);
        line('hour_earning', 1, hours(centiHours), rate, divRound(centiHours * rate, 100));
        break;
      }
      case 'slot': {
        const tier = slotTier(slotTiers(profile.slotTiers), centiHours);
        line('slot_earning', 1, hours(centiHours), tier, tier ?? 0);
        break;
      }
      case 'monthly':
        break;
    }
    const allowance = cents(profile.allowance);
    if (allowance > 0) line('allowance', 1, null, null, allowance);

    // --- adjustments (fines, bonuses, advances, CSR …) -----------------------
    const range = { gte: toDbDate(period.startsOn()), lte: toDbDate(period.endsOn()) };
    const adjustments = await db.payAdjustment.findMany({
      where: { userId: profile.userId, status: 'approved', payslipId: null, effectiveOn: range },
      orderBy: [{ effectiveOn: 'asc' }, { id: 'asc' }],
    });
    for (const a of adjustments) {
      if (a.currency !== currency) {
        errors.push({ code: 'currency_mismatch', adjustmentId: a.id });
        continue;
      }
      const amount = cents(a.amount);
      const csr = a.type === 'csr_conversions';
      line(
        a.type,
        adjustmentSign(a.type),
        csr && a.quantity ? `${a.quantity}.00` : null,
        csr && a.quantity ? Math.trunc(amount / Math.max(1, a.quantity)) : null,
        amount,
        a.id,
      );
    }
    const pendingFines = await db.payAdjustment.count({
      where: { userId: profile.userId, status: 'proposed', effectiveOn: range },
    });
    if (pendingFines > 0) warnings.push({ code: 'fines_pending', count: pendingFines });

    // --- deductions ----------------------------------------------------------
    const days = (
      await db.staffAttendance.findMany({
        where: { userId: profile.userId, workDate: range },
        select: { status: true, paidLeave: true },
      })
    ).filter(isDeductible).length;
    if (days > 0 && monthly > 0) {
      const divisor = st['payroll.leave_divisor'];
      line('leave_deduction', -1, `${days}.00`, null, divRound(monthly * days, divisor));
    }
    const tax = cents(profile.tax);
    if (tax > 0) line('tax', -1, null, null, tax);

    // --- totals --------------------------------------------------------------
    let earnings = 0;
    let deductions = 0;
    for (const l of lines) {
      if (l.sign > 0) earnings += l.amountMinor;
      else deductions += l.amountMinor;
    }
    const net = earnings - deductions;
    if (net < 0) errors.push({ code: 'negative_net', net: fromCents(net) });

    if (profile.teacherId) {
      warnings.push(...(await this.priorPeriodChanges(db, profile, period, st)));
    }

    return {
      userId: profile.userId,
      teacherId: profile.teacherId,
      currency,
      salaryType: type,
      rates: ratesOf(profile),
      lines: lines.map((l, position) => ({ ...l, position })),
      sessions: paid.map((s) => ({
        sessionId: s.id,
        startsAt: s.startsAt,
        kind: s.kind,
        stage: s.stage,
        payHours: hours(centi(s.payHours)),
        payRuleKey: s.payRuleKey,
      })),
      paidHours: hours(centiHours),
      paidClasses: classes,
      deductionDays: days,
      earningsMinor: earnings,
      deductionsMinor: deductions,
      netMinor: net,
      warnings,
      errors,
    };
  }

  /** The teacher's live classes that start in the month (academy zone). */
  sessions(db: Db, teacherId: number, period: Period, zone: string) {
    return db.classSession.findMany({
      where: {
        teacherId,
        deletedAt: null,
        startsAt: { gte: period.fromUtc(zone), lt: period.toUtc(zone) },
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        startsAt: true,
        kind: true,
        stage: true,
        payHours: true,
        payRuleKey: true,
        needsReview: true,
      },
    });
  }

  /** Classes of an approved month whose pay snapshot changed after approval (B49). */
  private async priorPeriodChanges(
    db: Db,
    profile: PayProfile,
    period: Period,
    st: SettingsMap,
  ): Promise<PayslipIssue[]> {
    let oldest = period;
    for (let i = 0; i < st['payroll.prior_period_months']; i++) oldest = oldest.previous();
    const slips = await db.payslip.findMany({
      where: {
        userId: profile.userId,
        run: {
          status: { in: ['approved', 'paid'] },
          period: { lt: period.toString(), gte: oldest.toString() },
        },
      },
      select: { paidHours: true, run: { select: { period: true } } },
      orderBy: { run: { period: 'asc' } },
    });
    const out: PayslipIssue[] = [];
    for (const slip of slips) {
      const then = centi(slip.paidHours);
      const rows = await this.sessions(
        db,
        profile.teacherId!,
        Period.parse(slip.run.period),
        st['academy.timezone'],
      );
      const now = rows.reduce((a, s) => a + Math.max(0, centi(s.payHours)), 0);
      if (now !== then) {
        out.push({
          code: 'prior_period_changed',
          period: slip.run.period,
          deltaHours: hours(now - then),
        });
      }
    }
    return out;
  }
}
