import {
  adjustmentSign,
  type AdjustmentDto,
  type AttendanceDto,
  type LeaveRequestDto,
  type PayProfileDto,
  type PayrollPersonDto,
  type PayrollRunDto,
  type PayslipDto,
  type PayslipIssue,
  type PayslipLineDto,
} from '@qarabic/shared';
import type { AuthUser } from '../auth/auth.types.js';
import type { Prisma } from '../generated/prisma/client.js';
import { isoZ } from '../schedule/time.js';
import { cents, fromCents } from './money.js';
import { adjustmentCan, isPayrollStaff, leaveCan } from './policies.js';

/** `{ id, name, teacher }` of a user in payroll payloads (no contact data). */
export const personSelect = {
  select: { id: true, name: true, teacher: { select: { id: true } } },
} as const;
export type PersonRow = { id: number; name: string; teacher: { id: number } | null };

export const nameSelect = { select: { id: true, name: true } } as const;

export function person(u: PersonRow): PayrollPersonDto {
  return { id: u.id, name: u.name, teacherId: u.teacher?.id ?? null };
}

export const dateStr = (d: Date | null | undefined): string | null =>
  d ? d.toISOString().slice(0, 10) : null;

export const money = (d: { toFixed(dp: number): string } | null | undefined): string =>
  fromCents(cents(d ?? null));

// ------------------------------------------------------------------ attendance

export const attendanceInclude = { user: personSelect } satisfies Prisma.StaffAttendanceInclude;
export type AttendanceRow = Prisma.StaffAttendanceGetPayload<{ include: typeof attendanceInclude }>;

/** Counts toward the leave deduction of a monthly salary (old status 2 = absent). */
export const isDeductible = (r: { status: string; paidLeave: boolean }) =>
  r.status === 'absent' || (r.status === 'leave' && !r.paidLeave);

export function attendanceDto(r: AttendanceRow): AttendanceDto {
  return {
    id: r.id,
    user: person(r.user),
    workDate: dateStr(r.workDate)!,
    status: r.status,
    paidLeave: r.paidLeave,
    deductible: isDeductible(r),
    checkInAt: isoZ(r.checkInAt),
    checkOutAt: isoZ(r.checkOutAt),
    workedMinutes: r.workedMinutes,
    timezone: r.timezone,
    source: r.source,
    leaveRequestId: r.leaveRequestId,
    note: r.note,
  };
}

// ------------------------------------------------------------------ leave

export const leaveInclude = {
  user: personSelect,
  decidedBy: nameSelect,
} satisfies Prisma.LeaveRequestInclude;
export type LeaveRow = Prisma.LeaveRequestGetPayload<{ include: typeof leaveInclude }>;

export function leaveDto(r: LeaveRow, viewer: AuthUser): LeaveRequestDto {
  return {
    id: r.id,
    user: person(r.user),
    startsOn: dateStr(r.startsOn)!,
    endsOn: dateStr(r.endsOn)!,
    days: r.days,
    leaveType: r.leaveType,
    reason: r.reason,
    status: r.status,
    decidedBy: r.decidedBy,
    decidedAt: isoZ(r.decidedAt),
    decisionNote: r.decisionNote,
    createdAt: isoZ(r.createdAt)!,
    can: {
      decide: r.status === 'pending' && leaveCan.decide(viewer, r),
      cancel: (r.status === 'pending' || r.status === 'approved') && leaveCan.cancel(viewer, r),
    },
  };
}

// ------------------------------------------------------------------ adjustments

export const adjustmentInclude = {
  user: personSelect,
  createdBy: nameSelect,
} satisfies Prisma.PayAdjustmentInclude;
export type AdjustmentRow = Prisma.PayAdjustmentGetPayload<{ include: typeof adjustmentInclude }>;

export function adjustmentDto(a: AdjustmentRow, viewer: AuthUser): AdjustmentDto {
  const open = a.status === 'proposed' || a.status === 'approved';
  return {
    id: a.id,
    user: person(a.user),
    type: a.type,
    sign: adjustmentSign(a.type),
    amount: money(a.amount),
    quantity: a.quantity,
    currency: a.currency,
    effectiveOn: dateStr(a.effectiveOn)!,
    reason: a.reason,
    status: a.status,
    sessionId: a.sessionId,
    locked: a.payslipId !== null,
    reversesId: a.reversesId,
    createdBy: a.createdBy,
    decidedAt: isoZ(a.decidedAt),
    decisionNote: a.decisionNote,
    createdAt: isoZ(a.createdAt)!,
    can: {
      decide: a.status === 'proposed' && adjustmentCan.decide(viewer, a),
      cancel: open && adjustmentCan.cancel(viewer, a),
    },
  };
}

// ------------------------------------------------------------------ pay profiles

export const profileInclude = { user: personSelect } satisfies Prisma.PayProfileInclude;
export type ProfileRow = Prisma.PayProfileGetPayload<{ include: typeof profileInclude }>;

export interface SlotTier {
  minSlots: number;
  amount: string;
}

/** Stored tiers, tolerant of a malformed row. */
export function slotTiers(value: unknown): SlotTier[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (t): t is { minSlots: number; amount: string } =>
        typeof t === 'object' &&
        t !== null &&
        typeof (t as { minSlots?: unknown }).minSlots === 'number' &&
        typeof (t as { amount?: unknown }).amount === 'string',
    )
    .map((t) => ({ minSlots: t.minSlots, amount: t.amount }));
}

export function profileDto(p: ProfileRow, defaultCurrency: string): PayProfileDto {
  return {
    id: p.id,
    user: person(p.user),
    teacherId: p.teacherId,
    salaryType: p.salaryType,
    currency: p.currency ?? defaultCurrency,
    monthlySalary: money(p.monthlySalary),
    classRate: money(p.classRate),
    hourlyRate: money(p.hourlyRate),
    csrRate: money(p.csrRate),
    allowance: money(p.allowance),
    tax: money(p.tax),
    slotTiers: slotTiers(p.slotTiers),
    active: p.active,
    notes: p.notes,
    updatedAt: isoZ(p.updatedAt)!,
  };
}

// ------------------------------------------------------------------ payslips and runs

export const payslipInclude = {
  run: { select: { id: true, period: true, status: true } },
  user: personSelect,
} satisfies Prisma.PayslipInclude;
export type PayslipRow = Prisma.PayslipGetPayload<{ include: typeof payslipInclude }>;

export const payslipDetailInclude = {
  ...payslipInclude,
  lines: {
    orderBy: { position: 'asc' },
    include: { adjustment: { select: { id: true, reason: true, effectiveOn: true } } },
  },
  sessions: { orderBy: [{ startsAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.PayslipInclude;
export type PayslipDetailRow = Prisma.PayslipGetPayload<{ include: typeof payslipDetailInclude }>;

export const issues = (value: unknown): PayslipIssue[] =>
  Array.isArray(value) ? (value as PayslipIssue[]) : [];

export function lineDto(l: PayslipDetailRow['lines'][number]): PayslipLineDto {
  return {
    code: l.code as PayslipLineDto['code'],
    sign: l.sign === -1 ? -1 : 1,
    quantity: l.quantity ? l.quantity.toFixed(2) : null,
    rate: l.rate ? money(l.rate) : null,
    amount: money(l.amount),
    adjustment: l.adjustment
      ? {
          id: l.adjustment.id,
          reason: l.adjustment.reason,
          effectiveOn: dateStr(l.adjustment.effectiveOn)!,
        }
      : null,
  };
}

export function payslipDto(s: PayslipRow | PayslipDetailRow, viewer: AuthUser): PayslipDto {
  const staff = isPayrollStaff(viewer);
  const detail = 'lines' in s;
  return {
    id: s.id,
    period: s.run.period,
    runId: s.runId,
    runStatus: s.run.status,
    user: person(s.user),
    teacherId: s.teacherId,
    currency: s.currency,
    salaryType: s.salaryType,
    rates: (s.rates ?? {}) as Record<string, unknown>,
    paidHours: s.paidHours.toFixed(2),
    paidClasses: s.paidClasses,
    deductionDays: s.deductionDays,
    earnings: money(s.earnings),
    deductions: money(s.deductions),
    net: money(s.net),
    status: s.status,
    warnings: staff ? issues(s.warnings) : [],
    errors: staff ? issues(s.errors) : [],
    paidAt: isoZ(s.paidAt),
    paidOn: dateStr(s.paidOn),
    paymentMethod: s.paymentMethod,
    paymentReference: s.paymentReference,
    ...(detail
      ? {
          lines: s.lines.map(lineDto),
          sessions: s.sessions.map((x) => ({
            sessionId: x.sessionId,
            startsAt: isoZ(x.startsAt),
            kind: x.kind as never,
            stage: x.stage as never,
            payHours: x.payHours.toFixed(2),
            payRuleKey: x.payRuleKey,
          })),
        }
      : {}),
  };
}

type DecimalLike = { toFixed(dp: number): string } | string;
interface SlipTotals {
  currency: string;
  earnings: DecimalLike;
  deductions: DecimalLike;
  net: DecimalLike;
  status: string;
}

export function totals(slips: SlipTotals[]): PayrollRunDto['totals'] {
  const by = new Map<string, { people: number; e: number; d: number; n: number; p: number }>();
  for (const s of slips) {
    const t = by.get(s.currency) ?? { people: 0, e: 0, d: 0, n: 0, p: 0 };
    t.people += 1;
    t.e += cents(s.earnings);
    t.d += cents(s.deductions);
    t.n += cents(s.net);
    if (s.status === 'paid') t.p += cents(s.net);
    by.set(s.currency, t);
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, t]) => ({
      currency,
      people: t.people,
      earnings: fromCents(t.e),
      deductions: fromCents(t.d),
      net: fromCents(t.n),
      paid: fromCents(t.p),
    }));
}

export const runInclude = {
  createdBy: nameSelect,
  reviewedBy: nameSelect,
  approvedBy: nameSelect,
  payslips: {
    select: {
      currency: true,
      earnings: true,
      deductions: true,
      net: true,
      status: true,
      errors: true,
      warnings: true,
    },
  },
} satisfies Prisma.PayrollRunInclude;
export type RunRow = Prisma.PayrollRunGetPayload<{ include: typeof runInclude }>;

export function runDto(r: RunRow, viewer: AuthUser): PayrollRunDto {
  const slips = r.payslips;
  const p = viewer.permissions;
  const status = r.status;
  const open = status === 'draft' || status === 'reviewed';
  return {
    id: r.id,
    period: r.period,
    startsOn: dateStr(r.startsOn)!,
    endsOn: dateStr(r.endsOn)!,
    status,
    computedAt: isoZ(r.computedAt),
    createdBy: r.createdBy,
    reviewedBy: r.reviewedBy,
    reviewedAt: isoZ(r.reviewedAt),
    approvedBy: r.approvedBy,
    approvedAt: isoZ(r.approvedAt),
    paidAt: isoZ(r.paidAt),
    updatedAt: r.updatedAt.toISOString(),
    people: slips.length,
    paidPeople: slips.filter((s) => s.status === 'paid').length,
    errorCount: slips.filter((s) => issues(s.errors).length > 0).length,
    warningCount: slips.filter((s) => issues(s.warnings).length > 0).length,
    totals: totals(slips),
    can: {
      recompute: open && p.has('payroll.manage'),
      review: status === 'draft' && p.has('payroll.review'),
      approve: status === 'reviewed' && p.has('payroll.approve'),
      reopen: status === 'approved' && p.has('payroll.approve'),
      pay: status === 'approved' && p.has('payroll.manage'),
      adjust: open && p.has('payroll.manage'),
    },
  };
}
