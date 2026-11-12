import {
  adjustmentSign,
  DEFAULT_PAY_RULES,
  fromMinor,
  type AdjustmentStatus,
  type AdjustmentType,
  type AttendanceSource,
  type AttendanceStatus,
  type LeaveStatus,
  type LeaveType,
  type PayoutMethod,
  type PayRule,
  type PayslipLineCode,
  type PayslipStatus,
  type RunStatus,
  type SalaryType,
  type SessionStage,
  type WalletTxType,
} from '@qarabic/shared';
import { addDays, dateKeyIn, isoWeekday } from '@/lib/schedule-time';

/**
 * Fake payroll data for the mocks (N7): salary profiles for some teachers and staff (EGP and one
 * USD), the current and the previous month's attendance, leave requests and fines in every status,
 * two runs (two months ago paid, last month approved with one payslip paid) and the wallet ledger
 * they made. The current month has no run, so a run can always be created. Everything is built
 * from today's academy date when the data is (re)built. Amounts are integer minor units inside, as
 * the API; nothing here moves money. Made-up people only.
 */
export const ACADEMY_TZ = 'Africa/Cairo';
export const ADMIN_REF = { id: 1, name: 'مدير النظام' };
const MONITOR_REF = { id: 12, name: 'Rana Monitor' };

/** Payroll people (user id → name, teacher id); names match people-db. */
export const PAY_PEOPLE: { id: number; name: string; teacherId: number | null }[] = [
  { id: 2, name: 'معلم تجريبي', teacherId: 1 },
  { id: 102, name: 'Ahmed Fathy', teacherId: 2 },
  { id: 103, name: 'Mahmoud Saeed', teacherId: 3 },
  { id: 104, name: 'Nour Adel', teacherId: 4 },
  { id: 105, name: 'Huda Mostafa', teacherId: 5 },
  { id: 106, name: 'Mostafa Kamal', teacherId: 6 },
  { id: 12, name: 'Rana Monitor', teacherId: null },
  { id: 13, name: 'Mona CSR', teacherId: null },
  { id: 15, name: 'Laila Accounts', teacherId: null },
];
export const personOf = (userId: number) => {
  const p = PAY_PEOPLE.find((x) => x.id === userId);
  return p ?? { id: userId, name: userId === 1 ? ADMIN_REF.name : `#${userId}`, teacherId: null };
};

export interface ProfileRow {
  id: number;
  userId: number;
  salaryType: SalaryType;
  currency: string;
  monthly: number;
  classRate: number;
  hourlyRate: number;
  csrRate: number;
  allowance: number;
  tax: number;
  slotTiers: { minSlots: number; amount: number }[];
  active: boolean;
  notes: string | null;
  updatedAt: string;
}

export interface AttendanceRow {
  id: number;
  userId: number;
  workDate: string;
  status: AttendanceStatus;
  paidLeave: boolean;
  checkInAt: string | null;
  checkOutAt: string | null;
  workedMinutes: number | null;
  timezone: string;
  source: AttendanceSource;
  leaveRequestId: number | null;
  note: string | null;
}

export interface LeaveRow {
  id: number;
  userId: number;
  startsOn: string;
  endsOn: string;
  leaveType: LeaveType;
  reason: string;
  status: LeaveStatus;
  decidedBy: { id: number; name: string } | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface AdjustmentRow {
  id: number;
  userId: number;
  type: AdjustmentType;
  amount: number;
  quantity: number | null;
  currency: string;
  effectiveOn: string;
  reason: string;
  status: AdjustmentStatus;
  sessionId: number | null;
  payslipId: number | null;
  reversesId: number | null;
  createdBy: { id: number; name: string } | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface LineRow {
  code: PayslipLineCode;
  sign: 1 | -1;
  quantity: string | null;
  rate: number | null;
  amount: number;
  adjustment: { id: number; reason: string; effectiveOn: string } | null;
}

export interface SessionRow {
  sessionId: number;
  startsAt: string;
  kind: 'regular' | 'extra';
  stage: SessionStage;
  payCenti: number;
  payRuleKey: string;
}

export type Issue = { code: string } & Record<string, string | number | null>;

export interface SlipRow {
  id: number;
  runId: number;
  userId: number;
  currency: string;
  salaryType: SalaryType;
  rates: Record<string, unknown>;
  paidCenti: number;
  paidClasses: number;
  deductionDays: number;
  lines: LineRow[];
  sessions: SessionRow[];
  warnings: Issue[];
  errors: Issue[];
  status: PayslipStatus;
  paidAt: string | null;
  paidOn: string | null;
  paymentMethod: PayoutMethod | null;
  paymentReference: string | null;
}

export interface RunRow {
  id: number;
  period: string;
  status: RunStatus;
  computedAt: string | null;
  createdBy: { id: number; name: string } | null;
  reviewedBy: { id: number; name: string } | null;
  reviewedAt: string | null;
  approvedBy: { id: number; name: string } | null;
  approvedAt: string | null;
  paidAt: string | null;
}

export interface WalletRow {
  id: number;
  userId: number;
  currency: string;
  amount: number;
  type: WalletTxType;
  payslipId: number | null;
  period: string | null;
  reference: string | null;
  occurredAt: string;
}

export interface RuleSetRow {
  id: number;
  effectiveFrom: string;
  rules: Record<string, PayRule>;
  note: string | null;
  createdBy: { id: number; name: string } | null;
  createdAt: string;
}

export interface PayrollDb {
  profiles: ProfileRow[];
  attendance: AttendanceRow[];
  leave: LeaveRow[];
  adjustments: AdjustmentRow[];
  runs: RunRow[];
  slips: SlipRow[];
  wallet: WalletRow[];
  ruleSets: RuleSetRow[];
  next: {
    profile: number;
    attendance: number;
    leave: number;
    adjustment: number;
    run: number;
    slip: number;
    wallet: number;
    ruleSet: number;
  };
}

export const academyToday = () => dateKeyIn(ACADEMY_TZ);
export const isoNow = () => new Date().toISOString();
export const periodOfDate = (key: string) => key.slice(0, 7);

export function previousPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export function periodBounds(period: string): { start: string; end: string } {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${period}-01`, end: `${period}-${String(last).padStart(2, '0')}` };
}

/** The UTC instant of `HH:MM` Cairo time on `key` (Cairo is UTC+2 in winter, +3 in summer). */
function cairoInstant(key: string, hour: number, minute = 0): string {
  const guess = new Date(
    `${key}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`,
  );
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: ACADEMY_TZ,
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(guess);
  const offset = Number(local) - hour;
  return new Date(guess.getTime() - offset * 3_600_000).toISOString();
}

/** Classes behind a teacher's hours in a month (deterministic; future days never count). */
export function sessionsFor(teacherId: number, period: string, today: string): SessionRow[] {
  const { start, end } = periodBounds(period);
  const out: SessionRow[] = [];
  for (let day = start; day <= end && day < today; day = addDays(day, 1)) {
    const d = Number(day.slice(8));
    if ((d + teacherId) % 3 === 2 || isoWeekday(day) === 5) continue;
    const stage: SessionStage =
      d % 11 === 0 ? 'leave' : d % 7 === 0 ? 'absent' : d % 13 === 0 ? 'declined' : 'taken';
    out.push({
      sessionId: teacherId * 1000 + d + Number(period.slice(5)) * 40,
      startsAt: cairoInstant(day, 17),
      kind: d % 10 === 0 ? 'extra' : 'regular',
      stage,
      payCenti: stage === 'leave' ? 0 : 50,
      payRuleKey: stage,
    });
  }
  return out;
}

const SLOT_TIERS = [
  { minSlots: 0, amount: 150_000 },
  { minSlots: 5, amount: 250_000 },
  { minSlots: 10, amount: 400_000 },
];

function buildProfiles(): ProfileRow[] {
  const at = '2026-10-01T08:00:00.000Z';
  const base = { classRate: 0, hourlyRate: 0, csrRate: 0, allowance: 0, tax: 0, monthly: 0 };
  const row = (
    id: number,
    userId: number,
    p: Partial<ProfileRow> & Pick<ProfileRow, 'salaryType' | 'currency'>,
  ): ProfileRow => ({
    id,
    userId,
    ...base,
    slotTiers: [],
    active: true,
    notes: null,
    updatedAt: at,
    ...p,
  });
  return [
    row(1, 2, { salaryType: 'hourly', currency: 'EGP', hourlyRate: 9_500 }),
    row(2, 102, { salaryType: 'hourly', currency: 'EGP', hourlyRate: 10_000 }),
    row(3, 103, { salaryType: 'hourly', currency: 'EGP', hourlyRate: 10_500 }),
    row(4, 104, { salaryType: 'hourly', currency: 'EGP', hourlyRate: 11_000, allowance: 20_000 }),
    row(5, 105, { salaryType: 'per_class', currency: 'EGP', classRate: 6_000 }),
    row(6, 106, { salaryType: 'slot', currency: 'EGP', slotTiers: SLOT_TIERS }),
    row(7, 12, {
      salaryType: 'monthly',
      currency: 'EGP',
      monthly: 900_000,
      allowance: 50_000,
      tax: 15_000,
    }),
    row(8, 13, { salaryType: 'monthly', currency: 'USD', monthly: 40_000, csrRate: 1_000 }),
    row(9, 15, {
      salaryType: 'monthly',
      currency: 'EGP',
      monthly: 1_100_000,
      tax: 20_000,
      notes: 'Accounts team',
    }),
  ];
}

function buildAttendance(db: PayrollDb, today: string) {
  const current = periodOfDate(today);
  const from = periodBounds(previousPeriod(current)).start;
  for (const p of db.profiles) {
    for (let day = from; day < today; day = addDays(day, 1)) {
      if (isoWeekday(day) === 5) continue;
      const d = Number(day.slice(8));
      const absent = (d + p.userId) % 9 === 0;
      const late = (d + p.userId) % 5 === 0 ? 20 : 0;
      db.attendance.push({
        id: db.next.attendance++,
        userId: p.userId,
        workDate: day,
        status: absent ? 'absent' : 'present',
        paidLeave: false,
        checkInAt: absent ? null : cairoInstant(day, 9, late),
        checkOutAt: absent ? null : cairoInstant(day, 15),
        workedMinutes: absent ? null : 360 - late,
        timezone: ACADEMY_TZ,
        source: absent ? 'staff' : 'self',
        leaveRequestId: null,
        note: absent ? 'No show, no notice' : null,
      });
    }
  }
  // The monitor already checked in today (the board shows someone at work).
  db.attendance.push({
    id: db.next.attendance++,
    userId: 12,
    workDate: today,
    status: 'present',
    paidLeave: false,
    checkInAt: cairoInstant(today, 8, 50),
    checkOutAt: null,
    workedMinutes: null,
    timezone: ACADEMY_TZ,
    source: 'self',
    leaveRequestId: null,
    note: null,
  });
}

function buildLeave(db: PayrollDb, today: string) {
  const at = `${addDays(today, -2)}T09:00:00.000Z`;
  const row = (
    r: Omit<LeaveRow, 'id' | 'createdAt' | 'decidedBy' | 'decidedAt' | 'decisionNote'> &
      Partial<LeaveRow>,
  ) =>
    db.leave.push({
      id: db.next.leave++,
      createdAt: at,
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      ...r,
    });
  row({
    userId: 103,
    startsOn: addDays(today, 3),
    endsOn: addDays(today, 4),
    leaveType: 'paid',
    reason: 'Family wedding in Alexandria',
    status: 'pending',
  });
  row({
    userId: 15,
    startsOn: addDays(today, 10),
    endsOn: addDays(today, 10),
    leaveType: 'unpaid',
    reason: 'Personal errand',
    status: 'pending',
  });
  row({
    userId: 12,
    startsOn: addDays(today, -20),
    endsOn: addDays(today, -19),
    leaveType: 'sick',
    reason: 'Flu, doctor note sent',
    status: 'approved',
    decidedBy: ADMIN_REF,
    decidedAt: at,
    decisionNote: null,
  });
  row({
    userId: 2,
    startsOn: addDays(today, -12),
    endsOn: addDays(today, -12),
    leaveType: 'paid',
    reason: 'Travel for a family matter',
    status: 'rejected',
    decidedBy: ADMIN_REF,
    decidedAt: at,
    decisionNote: 'Classes could not be covered that day',
  });
}

function adjustment(
  db: PayrollDb,
  r: Pick<AdjustmentRow, 'userId' | 'type' | 'amount' | 'effectiveOn' | 'reason' | 'status'> &
    Partial<AdjustmentRow>,
): AdjustmentRow {
  const profile = db.profiles.find((p) => p.userId === r.userId);
  const row: AdjustmentRow = {
    id: db.next.adjustment++,
    quantity: null,
    currency: profile?.currency ?? 'EGP',
    sessionId: null,
    payslipId: null,
    reversesId: null,
    createdBy: ADMIN_REF,
    decidedAt: r.status === 'proposed' ? null : `${r.effectiveOn}T12:00:00.000Z`,
    decisionNote: null,
    createdAt: `${r.effectiveOn}T10:00:00.000Z`,
    ...r,
  };
  db.adjustments.push(row);
  return row;
}

function buildAdjustments(db: PayrollDb, today: string) {
  const current = periodOfDate(today);
  const last = previousPeriod(current);
  const day = (period: string, d: number) => `${period}-${String(d).padStart(2, '0')}`;
  const firstDay = `${current}-01`;
  adjustment(db, {
    userId: 103,
    type: 'fine',
    amount: 5_000,
    effectiveOn: firstDay,
    reason: 'Late to class by 10 minutes',
    status: 'proposed',
    createdBy: MONITOR_REF,
    sessionId: 3021,
  });
  adjustment(db, {
    userId: 102,
    type: 'fine',
    amount: 7_500,
    effectiveOn: firstDay,
    reason: 'Class ended 15 minutes early',
    status: 'proposed',
    createdBy: MONITOR_REF,
  });
  adjustment(db, {
    userId: 2,
    type: 'fine',
    amount: 2_500,
    effectiveOn: firstDay,
    reason: 'Lesson report sent late',
    status: 'approved',
  });
  adjustment(db, {
    userId: 12,
    type: 'bonus',
    amount: 30_000,
    effectiveOn: firstDay,
    reason: 'Covered the evening shift all week',
    status: 'approved',
  });
  adjustment(db, {
    userId: 104,
    type: 'fine',
    amount: 5_000,
    effectiveOn: day(last, 10),
    reason: 'Missed a class without notice',
    status: 'approved',
  });
  adjustment(db, {
    userId: 15,
    type: 'advance',
    amount: 100_000,
    effectiveOn: day(last, 5),
    reason: 'Salary advance, agreed with the manager',
    status: 'approved',
  });
  adjustment(db, {
    userId: 105,
    type: 'fine',
    amount: 2_000,
    effectiveOn: day(last, 8),
    reason: 'Camera off during class',
    status: 'rejected',
    decisionNote: 'Network problem, confirmed by the family',
  });
}

function buildRuleSets(db: PayrollDb) {
  db.ruleSets.push({
    id: db.next.ruleSet++,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    rules: { ...DEFAULT_PAY_RULES },
    note: 'Seeded set: old rules page, B5 declined paid, trial unpaid',
    createdBy: ADMIN_REF,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
}

// ------------------------------------------------------------------ the calculator

const round = (n: number) => Math.round(n);

/** True while a run of that month is approved or paid. */
export function isLocked(db: PayrollDb, period: string): boolean {
  const run = db.runs.find((r) => r.period === period);
  return !!run && (run.status === 'approved' || run.status === 'paid');
}

/** Payslip lines, totals and issues of one person for one month (docs/21 §4). */
export function computeSlip(db: PayrollDb, profile: ProfileRow, period: string, today: string) {
  const person = personOf(profile.userId);
  const { start, end } = periodBounds(period);
  const sessions = person.teacherId ? sessionsFor(person.teacherId, period, today) : [];
  const centi = sessions.reduce((a, s) => a + s.payCenti, 0);
  const classes = sessions.filter((s) => s.payCenti > 0).length;
  const lines: LineRow[] = [];
  const add = (
    code: PayslipLineCode,
    sign: 1 | -1,
    amount: number,
    quantity: string | null = null,
    rate: number | null = null,
    adj: AdjustmentRow | null = null,
  ) => {
    if (amount !== 0) {
      lines.push({
        code,
        sign,
        quantity,
        rate,
        amount,
        adjustment: adj ? { id: adj.id, reason: adj.reason, effectiveOn: adj.effectiveOn } : null,
      });
    }
  };
  if (profile.monthly > 0) add('monthly_salary', 1, profile.monthly);
  if (profile.salaryType === 'per_class')
    add('class_earning', 1, classes * profile.classRate, String(classes), profile.classRate);
  if (profile.salaryType === 'hourly')
    add(
      'hour_earning',
      1,
      round((centi * profile.hourlyRate) / 100),
      fromMinor(centi),
      profile.hourlyRate,
    );
  if (profile.salaryType === 'slot') {
    const tier = [...profile.slotTiers].reverse().find((t) => t.minSlots * 100 <= centi);
    if (tier) add('slot_earning', 1, tier.amount, fromMinor(centi), null);
  }
  add('allowance', 1, profile.allowance);
  const adjs = db.adjustments.filter(
    (a) =>
      a.userId === profile.userId &&
      a.status === 'approved' &&
      a.effectiveOn >= start &&
      a.effectiveOn <= end,
  );
  for (const a of adjs) {
    if (a.type === 'csr_conversions')
      add('csr_conversions', 1, a.amount, String(a.quantity ?? 0), profile.csrRate, a);
    else add(a.type, adjustmentSign(a.type), a.amount, null, null, a);
  }
  const days = db.attendance.filter(
    (r) =>
      r.userId === profile.userId &&
      r.workDate >= start &&
      r.workDate <= end &&
      (r.status === 'absent' || (r.status === 'leave' && !r.paidLeave)),
  ).length;
  if (profile.monthly > 0 && days > 0)
    add('leave_deduction', -1, round((profile.monthly * days) / 30), String(days), null);
  add('tax', -1, profile.tax);
  const earnings = lines.filter((l) => l.sign === 1).reduce((a, l) => a + l.amount, 0);
  const deductions = lines.filter((l) => l.sign === -1).reduce((a, l) => a + l.amount, 0);
  const warnings: Issue[] = [];
  const errors: Issue[] = [];
  const pendingFines = db.adjustments.filter(
    (a) =>
      a.userId === profile.userId &&
      a.type === 'fine' &&
      a.status === 'proposed' &&
      a.effectiveOn >= start &&
      a.effectiveOn <= end,
  ).length;
  if (pendingFines) warnings.push({ code: 'fines_pending', count: pendingFines });
  if (person.teacherId === 3 && period === periodOfDate(today))
    warnings.push({ code: 'unmarked_sessions', count: 2 });
  if (earnings - deductions < 0)
    errors.push({ code: 'negative_net', net: fromMinor(earnings - deductions) });
  return {
    currency: profile.currency,
    salaryType: profile.salaryType,
    rates: {
      monthlySalary: fromMinor(profile.monthly),
      classRate: fromMinor(profile.classRate),
      hourlyRate: fromMinor(profile.hourlyRate),
      allowance: fromMinor(profile.allowance),
      tax: fromMinor(profile.tax),
    },
    paidCenti: centi,
    paidClasses: classes,
    deductionDays: profile.monthly > 0 ? days : 0,
    lines,
    sessions,
    warnings,
    errors,
  };
}

export const slipTotals = (slip: Pick<SlipRow, 'lines'>) => {
  const earnings = slip.lines.filter((l) => l.sign === 1).reduce((a, l) => a + l.amount, 0);
  const deductions = slip.lines.filter((l) => l.sign === -1).reduce((a, l) => a + l.amount, 0);
  return { earnings, deductions, net: earnings - deductions };
};

/** Rebuilds the payslips of a draft or reviewed run in place (idempotent, like the API). */
export function recompute(db: PayrollDb, run: RunRow, today = academyToday()) {
  const active = db.profiles.filter((p) => p.active);
  for (const profile of active) {
    const computed = computeSlip(db, profile, run.period, today);
    const slip = db.slips.find((s) => s.runId === run.id && s.userId === profile.userId);
    if (slip) Object.assign(slip, computed);
    else {
      db.slips.push({
        id: db.next.slip++,
        runId: run.id,
        userId: profile.userId,
        status: 'draft',
        paidAt: null,
        paidOn: null,
        paymentMethod: null,
        paymentReference: null,
        ...computed,
      });
    }
  }
  db.slips = db.slips.filter(
    (s) => s.runId !== run.id || active.some((p) => p.userId === s.userId),
  );
  run.computedAt = isoNow();
}

/** An input of an open month changed: its run goes back to draft and is recomputed (API rule). */
export function touchPeriod(db: PayrollDb, period: string) {
  const run = db.runs.find((r) => r.period === period);
  if (!run || run.status === 'approved' || run.status === 'paid') return;
  run.status = 'draft';
  run.reviewedBy = null;
  run.reviewedAt = null;
  recompute(db, run);
}

/** Approve: lock payslips and the month's approved adjustments, credit wallets (net 0 = paid). */
export function approveRun(
  db: PayrollDb,
  run: RunRow,
  by: { id: number; name: string },
  at = isoNow(),
) {
  const { start, end } = periodBounds(run.period);
  run.status = 'approved';
  run.approvedBy = by;
  run.approvedAt = at;
  for (const slip of db.slips.filter((s) => s.runId === run.id)) {
    const { net } = slipTotals(slip);
    slip.status = net === 0 ? 'paid' : 'approved';
    if (net === 0) {
      slip.paidAt = at;
      slip.paidOn = at.slice(0, 10);
    }
    for (const a of db.adjustments) {
      if (
        a.userId === slip.userId &&
        a.status === 'approved' &&
        a.effectiveOn >= start &&
        a.effectiveOn <= end
      )
        a.payslipId = slip.id;
    }
    db.wallet.push({
      id: db.next.wallet++,
      userId: slip.userId,
      currency: slip.currency,
      amount: net,
      type: 'salary_credit',
      payslipId: slip.id,
      period: run.period,
      reference: null,
      occurredAt: at,
    });
  }
  settleRun(db, run, at);
}

export function paySlip(
  db: PayrollDb,
  slip: SlipRow,
  body: { method: PayoutMethod; reference: string | null; paidOn: string },
  at = isoNow(),
) {
  slip.status = 'paid';
  slip.paidAt = at;
  slip.paidOn = body.paidOn;
  slip.paymentMethod = body.method;
  slip.paymentReference = body.reference;
  const run = db.runs.find((r) => r.id === slip.runId)!;
  db.wallet.push({
    id: db.next.wallet++,
    userId: slip.userId,
    currency: slip.currency,
    amount: -slipTotals(slip).net,
    type: 'salary_payment',
    payslipId: slip.id,
    period: run.period,
    reference: body.reference,
    occurredAt: at,
  });
  settleRun(db, run, at);
}

function settleRun(db: PayrollDb, run: RunRow, at: string) {
  const slips = db.slips.filter((s) => s.runId === run.id);
  if (run.status === 'approved' && slips.length > 0 && slips.every((s) => s.status === 'paid')) {
    run.status = 'paid';
    run.paidAt = at;
  }
}

function buildRuns(db: PayrollDb, today: string) {
  const current = periodOfDate(today);
  const last = previousPeriod(current);
  const before = previousPeriod(last);
  for (const period of [before, last]) {
    const { end } = periodBounds(period);
    const run: RunRow = {
      id: db.next.run++,
      period,
      status: 'draft',
      computedAt: null,
      createdBy: { id: 15, name: 'Laila Accounts' },
      reviewedBy: { id: 1, name: ADMIN_REF.name },
      reviewedAt: `${addDays(end, 2)}T09:00:00.000Z`,
      approvedBy: null,
      approvedAt: null,
      paidAt: null,
    };
    db.runs.push(run);
    recompute(db, run, today);
    run.computedAt = `${addDays(end, 1)}T08:00:00.000Z`;
    approveRun(db, run, { id: 15, name: 'Laila Accounts' }, `${addDays(end, 3)}T10:00:00.000Z`);
    const paidAt = `${addDays(end, 5)}T11:00:00.000Z`;
    for (const slip of db.slips.filter((s) => s.runId === run.id && s.status === 'approved')) {
      if (period === before || slip.userId === 2) {
        paySlip(
          db,
          slip,
          {
            method: slip.currency === 'USD' ? 'bank_transfer' : 'vodafone_cash',
            reference: `VC-${period}-${slip.userId}`,
            paidOn: addDays(end, 5),
          },
          paidAt,
        );
      }
    }
  }
}

function build(): PayrollDb {
  const today = academyToday();
  const db: PayrollDb = {
    profiles: buildProfiles(),
    attendance: [],
    leave: [],
    adjustments: [],
    runs: [],
    slips: [],
    wallet: [],
    ruleSets: [],
    next: {
      profile: 50,
      attendance: 1,
      leave: 1,
      adjustment: 1,
      run: 1,
      slip: 1,
      wallet: 1,
      ruleSet: 1,
    },
  };
  buildAttendance(db, today);
  buildLeave(db, today);
  buildAdjustments(db, today);
  buildRuleSets(db);
  buildRuns(db, today);
  return db;
}

export let pdb: PayrollDb = build();

export function resetPayrollDb() {
  pdb = build();
}
