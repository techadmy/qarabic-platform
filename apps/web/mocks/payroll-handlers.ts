import {
  ADJUSTMENT_STATUSES,
  adjustmentListQuerySchema,
  adjustmentSign,
  approveDecisionSchema,
  attendanceListQuerySchema,
  createAdjustmentSchema,
  createLeaveSchema,
  createPayRuleSetSchema,
  createRunSchema,
  fromMinor,
  isFineWorkflow,
  LEAVE_STATUSES,
  leaveListQuerySchema,
  markAttendanceSchema,
  PAYROLL_ERROR_MESSAGES,
  payProfileListQuerySchema,
  reasonDecisionSchema,
  recordPaymentSchema,
  runListQuerySchema,
  runPreviewQuerySchema,
  savePayProfileSchema,
  toMinor,
  type AdjustmentDto,
  type AttendanceDto,
  type LeaveRequestDto,
  type PayProfileDto,
  type PayrollErrorCode,
  type PayrollRunDto,
  type PayslipDto,
} from '@qarabic/shared';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { addDays, dateKeyIn } from '@/lib/schedule-time';
import type { MockUser } from './data';
import {
  academyToday,
  ADMIN_REF,
  approveRun,
  computeSlip,
  isLocked,
  isoNow,
  paySlip,
  pdb,
  periodBounds,
  periodOfDate,
  personOf,
  recompute,
  sessionsFor,
  slipTotals,
  touchPeriod,
  type AdjustmentRow,
  type AttendanceRow,
  type LeaveRow,
  type ProfileRow,
  type RunRow,
  type SlipRow,
} from './payroll-db';
import { paginate, queryOf } from './schedule-handlers';
import { apiError, guard, guardAny, notFound, validationFailed } from './session';

/**
 * MSW handlers for N7 (apps/api README «Endpoints (N7: payroll)»): attendance, leave, fines and
 * adjustments, salary profiles, runs, payslips, wallets and pay rule sets. Same permissions, row
 * scope (own rows without the staff permission; another person's payslip = 404) and refusal codes
 * as the API. Recording a payment only stores it: nothing moves money. Fake data only.
 */
const API = '*/api/v1';
const has = (me: MockUser, p: string) => me.permissions.includes(p);
const payrollStaff = (me: MockUser) =>
  has(me, 'payroll.manage') || has(me, 'payroll.review') || has(me, 'payroll.approve');
const fineStaff = (me: MockUser) =>
  has(me, 'fines.request') || has(me, 'fines.manage') || has(me, 'fines.approve');
const ref = (me: MockUser) => ({ id: me.id, name: me.name });

async function body(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function payrollError(code: PayrollErrorCode, status: number, field?: string, data?: object) {
  const message = PAYROLL_ERROR_MESSAGES[code].en;
  return apiError(
    status,
    code,
    message,
    field ? { [field]: [message] } : undefined,
    data as Record<string, unknown> | undefined,
  );
}

const person = (userId: number) => {
  const p = personOf(userId);
  return { id: p.id, name: p.name, teacherId: p.teacherId };
};

// ------------------------------------------------------------------ DTOs

function attendanceDto(r: AttendanceRow): AttendanceDto {
  return {
    id: r.id,
    user: person(r.userId),
    workDate: r.workDate,
    status: r.status,
    paidLeave: r.paidLeave,
    deductible: r.status === 'absent' || (r.status === 'leave' && !r.paidLeave),
    checkInAt: r.checkInAt,
    checkOutAt: r.checkOutAt,
    workedMinutes: r.workedMinutes,
    timezone: r.timezone,
    source: r.source,
    leaveRequestId: r.leaveRequestId,
    note: r.note,
  };
}

const leaveDays = (r: Pick<LeaveRow, 'startsOn' | 'endsOn'>) =>
  Math.round((Date.parse(r.endsOn) - Date.parse(r.startsOn)) / 86_400_000) + 1;

function leaveDto(r: LeaveRow, me: MockUser, detail = false): LeaveRequestDto {
  const manage = has(me, 'attendance.manage');
  const own = r.userId === me.id;
  const p = personOf(r.userId);
  return {
    id: r.id,
    user: person(r.userId),
    startsOn: r.startsOn,
    endsOn: r.endsOn,
    days: leaveDays(r),
    leaveType: r.leaveType,
    reason: r.reason,
    status: r.status,
    decidedBy: r.decidedBy,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    createdAt: r.createdAt,
    can: {
      decide: manage && r.status === 'pending',
      cancel:
        (own && r.status === 'pending') ||
        (manage && (r.status === 'pending' || r.status === 'approved')),
    },
    ...(detail
      ? {
          affectedSessions: p.teacherId
            ? sessionsFor(p.teacherId, periodOfDate(r.startsOn), '9999-12-31')
                .filter((s) => {
                  const day = dateKeyIn('Africa/Cairo', new Date(s.startsAt));
                  return day >= r.startsOn && day <= r.endsOn;
                })
                .map((s) => ({
                  id: s.sessionId,
                  startsAt: s.startsAt,
                  durationMinutes: 30,
                  stage: 'scheduled',
                }))
            : [],
        }
      : {}),
  };
}

function canDecideAdjustment(me: MockUser, a: AdjustmentRow) {
  if (a.status !== 'proposed') return false;
  return isFineWorkflow(a.type) ? has(me, 'fines.approve') : has(me, 'payroll.manage');
}

function canCancelAdjustment(me: MockUser, a: AdjustmentRow) {
  if (a.status !== 'proposed' && a.status !== 'approved') return false;
  if (a.payslipId !== null) {
    const waived = pdb.adjustments.some((x) => x.reversesId === a.id && x.status !== 'cancelled');
    return a.type === 'fine' && !waived && (has(me, 'fines.manage') || has(me, 'payroll.manage'));
  }
  if (isFineWorkflow(a.type)) {
    return (
      has(me, 'fines.manage') ||
      has(me, 'fines.approve') ||
      has(me, 'payroll.manage') ||
      (a.status === 'proposed' && a.createdBy?.id === me.id)
    );
  }
  return has(me, 'payroll.manage');
}

function adjustmentDto(a: AdjustmentRow, me: MockUser): AdjustmentDto {
  return {
    id: a.id,
    user: person(a.userId),
    type: a.type,
    sign: adjustmentSign(a.type),
    amount: fromMinor(a.amount),
    quantity: a.quantity,
    currency: a.currency,
    effectiveOn: a.effectiveOn,
    reason: a.reason,
    status: a.status,
    sessionId: a.sessionId,
    locked: a.payslipId !== null,
    reversesId: a.reversesId,
    createdBy: a.createdBy,
    decidedAt: a.decidedAt,
    decisionNote: a.decisionNote,
    createdAt: a.createdAt,
    can: { decide: canDecideAdjustment(me, a), cancel: canCancelAdjustment(me, a) },
  };
}

function profileDto(p: ProfileRow): PayProfileDto {
  const who = person(p.userId);
  return {
    id: p.id,
    user: who,
    teacherId: who.teacherId,
    salaryType: p.salaryType,
    currency: p.currency,
    monthlySalary: fromMinor(p.monthly),
    classRate: fromMinor(p.classRate),
    hourlyRate: fromMinor(p.hourlyRate),
    csrRate: fromMinor(p.csrRate),
    allowance: fromMinor(p.allowance),
    tax: fromMinor(p.tax),
    slotTiers: p.slotTiers.map((t) => ({ minSlots: t.minSlots, amount: fromMinor(t.amount) })),
    active: p.active,
    notes: p.notes,
    updatedAt: p.updatedAt,
  };
}

type SlipLike = Omit<
  SlipRow,
  'id' | 'runId' | 'status' | 'paidAt' | 'paidOn' | 'paymentMethod' | 'paymentReference' | 'userId'
> & { userId: number };

function slipBody(s: SlipLike, staff: boolean, detail: boolean) {
  const t = slipTotals(s);
  return {
    user: person(s.userId),
    teacherId: personOf(s.userId).teacherId,
    currency: s.currency,
    salaryType: s.salaryType,
    rates: s.rates,
    paidHours: fromMinor(s.paidCenti),
    paidClasses: s.paidClasses,
    deductionDays: s.deductionDays,
    earnings: fromMinor(t.earnings),
    deductions: fromMinor(t.deductions),
    net: fromMinor(t.net),
    warnings: staff ? s.warnings : [],
    errors: staff ? s.errors : [],
    ...(detail
      ? {
          lines: s.lines.map((l) => ({
            code: l.code,
            sign: l.sign,
            quantity: l.quantity,
            rate: l.rate === null ? null : fromMinor(l.rate),
            amount: fromMinor(l.amount),
            adjustment: l.adjustment,
          })),
          sessions: s.sessions.map((x) => ({
            sessionId: x.sessionId,
            startsAt: x.startsAt,
            kind: x.kind,
            stage: x.stage,
            payHours: fromMinor(x.payCenti),
            payRuleKey: x.payRuleKey,
          })),
        }
      : {}),
  };
}

function slipDto(s: SlipRow, me: MockUser, detail = false): PayslipDto {
  const run = pdb.runs.find((r) => r.id === s.runId)!;
  return {
    id: s.id,
    period: run.period,
    runId: run.id,
    runStatus: run.status,
    status: s.status,
    paidAt: s.paidAt,
    paidOn: s.paidOn,
    paymentMethod: s.paymentMethod,
    paymentReference: s.paymentReference,
    ...slipBody(s, payrollStaff(me), detail),
  };
}

function totalsOf(slips: SlipLike[]) {
  const by = new Map<
    string,
    { people: number; earnings: number; deductions: number; net: number; paid: number }
  >();
  for (const s of slips) {
    const t = slipTotals(s);
    const row = by.get(s.currency) ?? { people: 0, earnings: 0, deductions: 0, net: 0, paid: 0 };
    row.people += 1;
    row.earnings += t.earnings;
    row.deductions += t.deductions;
    row.net += t.net;
    if ((s as Partial<SlipRow>).status === 'paid') row.paid += t.net;
    by.set(s.currency, row);
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, r]) => ({
      currency,
      people: r.people,
      earnings: fromMinor(r.earnings),
      deductions: fromMinor(r.deductions),
      net: fromMinor(r.net),
      paid: fromMinor(r.paid),
    }));
}

function runDto(run: RunRow, me: MockUser): PayrollRunDto {
  const slips = pdb.slips.filter((s) => s.runId === run.id);
  const open = run.status === 'draft' || run.status === 'reviewed';
  const anyPaid = slips.some(
    (s) => s.status === 'paid' && s.paidOn !== null && s.paymentMethod !== null,
  );
  return {
    id: run.id,
    period: run.period,
    startsOn: periodBounds(run.period).start,
    endsOn: periodBounds(run.period).end,
    status: run.status,
    computedAt: run.computedAt,
    createdBy: run.createdBy,
    reviewedBy: run.reviewedBy,
    reviewedAt: run.reviewedAt,
    approvedBy: run.approvedBy,
    approvedAt: run.approvedAt,
    paidAt: run.paidAt,
    // The API's version stamp (sent back as `expectedUpdatedAt`); the mocks never refuse a stale one.
    updatedAt:
      run.paidAt ??
      run.approvedAt ??
      run.reviewedAt ??
      run.computedAt ??
      '2026-01-01T00:00:00.000Z',
    people: slips.length,
    paidPeople: slips.filter((s) => s.status === 'paid').length,
    errorCount: slips.reduce((a, s) => a + s.errors.length, 0),
    warningCount: slips.reduce((a, s) => a + s.warnings.length, 0),
    totals: totalsOf(slips),
    can: {
      recompute: has(me, 'payroll.manage') && open,
      review: has(me, 'payroll.review') && run.status === 'draft',
      approve: has(me, 'payroll.approve') && run.status === 'reviewed',
      reopen: has(me, 'payroll.approve') && run.status === 'approved' && !anyPaid,
      pay: has(me, 'payroll.manage') && run.status === 'approved',
      adjust: has(me, 'payroll.manage') && open,
    },
  };
}

// ------------------------------------------------------------------ helpers

function findRun(id: unknown) {
  return pdb.runs.find((r) => r.id === Number(id)) ?? null;
}

function visibleAdjustment(me: MockUser, a: AdjustmentRow) {
  if (payrollStaff(me)) return true;
  if (fineStaff(me)) return isFineWorkflow(a.type);
  return a.userId === me.id && a.status === 'approved';
}

/** Writes one attendance row per leave day (worked days kept; unpaid = deductible). */
function writeLeaveDays(leave: LeaveRow) {
  for (let day = leave.startsOn; day <= leave.endsOn; day = addDays(day, 1)) {
    const existing = pdb.attendance.find((r) => r.userId === leave.userId && r.workDate === day);
    if (existing?.checkInAt) continue;
    const row: AttendanceRow = existing ?? {
      id: pdb.next.attendance++,
      userId: leave.userId,
      workDate: day,
      status: 'leave',
      paidLeave: true,
      checkInAt: null,
      checkOutAt: null,
      workedMinutes: null,
      timezone: 'Africa/Cairo',
      source: 'leave',
      leaveRequestId: leave.id,
      note: null,
    };
    row.status = 'leave';
    row.paidLeave = leave.leaveType !== 'unpaid';
    row.source = 'leave';
    row.leaveRequestId = leave.id;
    if (!existing) pdb.attendance.push(row);
  }
}

function periodsOf(from: string, to: string): string[] {
  const out = new Set<string>();
  for (let day = from; day <= to; day = addDays(day, 1)) out.add(periodOfDate(day));
  return [...out];
}

/** The first month without an approved / paid run (where a waived fine is reduced). */
function firstOpenDate(): string {
  let period = periodOfDate(academyToday());
  while (isLocked(pdb, period)) {
    const [y, m] = period.split('-').map(Number) as [number, number];
    period = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }
  return period === periodOfDate(academyToday()) ? academyToday() : `${period}-01`;
}

export const payrollHandlers: HttpHandler[] = [
  // ---------------------------------------------------------------- attendance
  http.get(`${API}/attendance/today`, ({ request }) => {
    const g = guard(request, 'attendance.request');
    if ('error' in g) return g.error;
    const tz = g.me.timezone ?? 'Africa/Cairo';
    const date = dateKeyIn(tz);
    const record = pdb.attendance.find((r) => r.userId === g.me.id && r.workDate === date) ?? null;
    const onLeave = pdb.leave.some(
      (l) =>
        l.userId === g.me.id && l.status === 'approved' && l.startsOn <= date && l.endsOn >= date,
    );
    return HttpResponse.json({
      data: { date, timezone: tz, record: record ? attendanceDto(record) : null, onLeave },
    });
  }),

  http.post(`${API}/attendance/check-in`, ({ request }) => {
    const g = guard(request, 'attendance.request');
    if ('error' in g) return g.error;
    const tz = g.me.timezone ?? 'Africa/Cairo';
    const date = dateKeyIn(tz);
    const onLeave = pdb.leave.some(
      (l) =>
        l.userId === g.me.id && l.status === 'approved' && l.startsOn <= date && l.endsOn >= date,
    );
    if (onLeave) return payrollError('on_leave', 409);
    const existing = pdb.attendance.find((r) => r.userId === g.me.id && r.workDate === date);
    if (existing?.checkInAt) return payrollError('already_checked_in', 409);
    const row: AttendanceRow = existing ?? {
      id: pdb.next.attendance++,
      userId: g.me.id,
      workDate: date,
      status: 'present',
      paidLeave: false,
      checkInAt: null,
      checkOutAt: null,
      workedMinutes: null,
      timezone: tz,
      source: 'self',
      leaveRequestId: null,
      note: null,
    };
    row.status = 'present';
    row.checkInAt = isoNow();
    row.source = 'self';
    if (!existing) pdb.attendance.push(row);
    return HttpResponse.json({ data: attendanceDto(row) });
  }),

  http.post(`${API}/attendance/check-out`, ({ request }) => {
    const g = guard(request, 'attendance.request');
    if ('error' in g) return g.error;
    const now = Date.now();
    const open = pdb.attendance
      .filter((r) => r.userId === g.me.id && r.checkInAt && !r.checkOutAt)
      .filter((r) => now - Date.parse(r.checkInAt!) < 24 * 3_600_000)
      .sort((a, b) => b.workDate.localeCompare(a.workDate))[0];
    if (!open) return payrollError('not_checked_in', 409);
    open.checkOutAt = new Date(now).toISOString();
    open.workedMinutes = Math.max(0, Math.floor((now - Date.parse(open.checkInAt!)) / 60_000));
    return HttpResponse.json({ data: attendanceDto(open) });
  }),

  http.get(`${API}/attendance`, ({ request }) => {
    const g = guardAny(request, 'attendance.request', 'attendance.view');
    if ('error' in g) return g.error;
    const parsed = attendanceListQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const month = parsed.data.month ?? periodOfDate(academyToday());
    const manage = has(g.me, 'attendance.manage');
    const userId = manage ? parsed.data.userId : g.me.id;
    const { start, end } = periodBounds(month);
    const rows = pdb.attendance
      .filter((r) => r.workDate >= start && r.workDate <= end)
      .filter((r) => (userId ? r.userId === userId : true))
      .sort((a, b) => b.workDate.localeCompare(a.workDate) || a.userId - b.userId);
    const people =
      manage && !userId ? pdb.profiles.filter((p) => p.active).map((p) => p.userId) : [userId!];
    const summary = people.map((id) => {
      const mine = rows.filter((r) => r.userId === id);
      const count = (s: AttendanceRow['status']) => mine.filter((r) => r.status === s).length;
      return {
        user: person(id),
        present: count('present'),
        absent: count('absent'),
        leave: count('leave'),
        holiday: count('holiday'),
        deductibleDays: mine.filter(
          (r) => r.status === 'absent' || (r.status === 'leave' && !r.paidLeave),
        ).length,
        workedMinutes: mine.reduce((a, r) => a + (r.workedMinutes ?? 0), 0),
      };
    });
    return HttpResponse.json({
      data: rows.map(attendanceDto),
      meta: { month, summary, scope: manage ? 'all' : 'own' },
    });
  }),

  http.put(`${API}/attendance/:userId/:date`, async ({ request, params }) => {
    const g = guard(request, 'attendance.manage');
    if ('error' in g) return g.error;
    const userId = Number(params.userId);
    const date = String(params.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !pdb.profiles.some((p) => p.userId === userId)) {
      return notFound();
    }
    const parsed = markAttendanceSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    if (isLocked(pdb, periodOfDate(date))) return payrollError('period_locked', 409);
    const v = parsed.data;
    let row = pdb.attendance.find((r) => r.userId === userId && r.workDate === date);
    if (!row) {
      row = {
        id: pdb.next.attendance++,
        userId,
        workDate: date,
        status: v.status,
        paidLeave: false,
        checkInAt: null,
        checkOutAt: null,
        workedMinutes: null,
        timezone: 'Africa/Cairo',
        source: 'staff',
        leaveRequestId: null,
        note: null,
      };
      pdb.attendance.push(row);
    }
    row.status = v.status;
    row.paidLeave = v.status === 'leave' ? (v.paidLeave ?? true) : false;
    row.note = v.note ?? null;
    row.source = 'staff';
    touchPeriod(pdb, periodOfDate(date));
    return HttpResponse.json({ data: attendanceDto(row) });
  }),

  // ---------------------------------------------------------------- leave requests
  http.get(`${API}/leave-requests`, ({ request }) => {
    const g = guardAny(request, 'attendance.request', 'attendance.manage');
    if ('error' in g) return g.error;
    const parsed = leaveListQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const q = parsed.data;
    const manage = has(g.me, 'attendance.manage');
    const scoped = pdb.leave
      .filter((l) => (manage ? true : l.userId === g.me.id))
      .filter((l) => (q.userId && manage ? l.userId === q.userId : true));
    const counts: Record<string, number> = { all: scoped.length };
    for (const s of LEAVE_STATUSES) counts[s] = scoped.filter((l) => l.status === s).length;
    const rows = scoped
      .filter((l) => (q.status ? l.status === q.status : true))
      .sort(
        (a, b) =>
          Number(b.status === 'pending') - Number(a.status === 'pending') ||
          b.startsOn.localeCompare(a.startsOn) ||
          b.id - a.id,
      )
      .map((l) => leaveDto(l, g.me));
    return HttpResponse.json(paginate(rows, q.page, q.perPage, counts));
  }),

  http.get(`${API}/leave-requests/:id`, ({ request, params }) => {
    const g = guardAny(request, 'attendance.request', 'attendance.manage');
    if ('error' in g) return g.error;
    const l = pdb.leave.find((x) => x.id === Number(params.id));
    if (!l || (!has(g.me, 'attendance.manage') && l.userId !== g.me.id)) return notFound();
    return HttpResponse.json({ data: leaveDto(l, g.me, true) });
  }),

  http.post(`${API}/leave-requests`, async ({ request }) => {
    const g = guardAny(request, 'attendance.request', 'attendance.manage');
    if ('error' in g) return g.error;
    const parsed = createLeaveSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const v = parsed.data;
    if (v.userId && v.userId !== g.me.id && !has(g.me, 'attendance.manage')) {
      return apiError(403, 'forbidden', 'Forbidden.');
    }
    const userId = v.userId ?? g.me.id;
    const days = leaveDays(v);
    if (days > 31) {
      return apiError(422, 'validation_failed', 'The given data was invalid.', {
        endsOn: ['The leave is longer than allowed.'],
      });
    }
    const overlap = pdb.leave.some(
      (l) =>
        l.userId === userId &&
        (l.status === 'pending' || l.status === 'approved') &&
        l.startsOn <= v.endsOn &&
        l.endsOn >= v.startsOn,
    );
    if (overlap) return payrollError('leave_overlap', 422, 'startsOn');
    const row: LeaveRow = {
      id: pdb.next.leave++,
      userId,
      startsOn: v.startsOn,
      endsOn: v.endsOn,
      leaveType: v.leaveType,
      reason: v.reason,
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      createdAt: isoNow(),
    };
    pdb.leave.push(row);
    return HttpResponse.json({ data: leaveDto(row, g.me) }, { status: 201 });
  }),

  http.post(`${API}/leave-requests/:id/:action`, async ({ request, params }) => {
    const action = String(params.action);
    if (!['approve', 'reject', 'cancel'].includes(action)) return notFound();
    const g =
      action === 'cancel'
        ? guardAny(request, 'attendance.request', 'attendance.manage')
        : guard(request, 'attendance.manage');
    if ('error' in g) return g.error;
    const l = pdb.leave.find((x) => x.id === Number(params.id));
    const manage = has(g.me, 'attendance.manage');
    if (!l || (!manage && l.userId !== g.me.id)) return notFound();
    const schema = action === 'approve' ? approveDecisionSchema : reasonDecisionSchema;
    const parsed = schema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const note = parsed.data.note ?? null;
    const allowed =
      action === 'cancel'
        ? l.status === 'pending' || (manage && l.status === 'approved')
        : l.status === 'pending';
    if (!allowed) return payrollError('invalid_leave_status', 409);
    const months = periodsOf(l.startsOn, l.endsOn);
    if ((action === 'approve' || l.status === 'approved') && months.some((m) => isLocked(pdb, m))) {
      return payrollError('period_locked', 409);
    }
    if (action === 'approve') writeLeaveDays(l);
    if (action === 'cancel' && l.status === 'approved') {
      pdb.attendance = pdb.attendance.filter((r) => r.leaveRequestId !== l.id || r.checkInAt);
    }
    l.status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled';
    l.decidedBy = ref(g.me);
    l.decidedAt = isoNow();
    l.decisionNote = note;
    for (const m of months) touchPeriod(pdb, m);
    return HttpResponse.json({ data: leaveDto(l, g.me, action === 'approve') });
  }),

  // ---------------------------------------------------------------- adjustments
  http.get(`${API}/payroll/adjustments`, ({ request }) => {
    const g = guardAny(request, 'fines.view', 'payroll.view');
    if ('error' in g) return g.error;
    const raw = queryOf(request);
    const parsed = adjustmentListQuerySchema.safeParse({
      ...raw,
      ...(raw.type ? { type: raw.type.split(',') } : {}),
    });
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const q = parsed.data;
    const scoped = pdb.adjustments
      .filter((a) => visibleAdjustment(g.me, a))
      .filter((a) => (q.type ? q.type.includes(a.type) : true))
      .filter((a) => (q.userId ? a.userId === q.userId : true))
      .filter((a) => (q.month ? a.effectiveOn.startsWith(q.month) : true));
    const counts: Record<string, number> = { all: scoped.length };
    for (const s of ADJUSTMENT_STATUSES) counts[s] = scoped.filter((a) => a.status === s).length;
    const rows = scoped
      .filter((a) => (q.status ? a.status === q.status : true))
      .sort(
        (a, b) =>
          Number(b.status === 'proposed') - Number(a.status === 'proposed') ||
          b.effectiveOn.localeCompare(a.effectiveOn) ||
          b.id - a.id,
      )
      .map((a) => adjustmentDto(a, g.me));
    return HttpResponse.json(paginate(rows, q.page, q.perPage, counts));
  }),

  http.get(`${API}/payroll/adjustments/:id`, ({ request, params }) => {
    const g = guardAny(request, 'fines.view', 'payroll.view');
    if ('error' in g) return g.error;
    const a = pdb.adjustments.find((x) => x.id === Number(params.id));
    if (!a || !visibleAdjustment(g.me, a)) return notFound();
    return HttpResponse.json({ data: adjustmentDto(a, g.me) });
  }),

  http.post(`${API}/payroll/adjustments`, async ({ request }) => {
    const g = guardAny(request, 'fines.request', 'fines.manage', 'fines.approve', 'payroll.manage');
    if ('error' in g) return g.error;
    const parsed = createAdjustmentSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const v = parsed.data;
    const me = g.me;
    const fineOk = fineStaff(me) || has(me, 'payroll.manage');
    if (v.type === 'fine' && !fineOk) return payrollError('forbidden_type', 403);
    if (v.type === 'fine_reduction' && !has(me, 'fines.manage') && !has(me, 'payroll.manage')) {
      return payrollError('forbidden_type', 403);
    }
    if (!isFineWorkflow(v.type) && !has(me, 'payroll.manage'))
      return payrollError('forbidden_type', 403);
    const profile = pdb.profiles.find((p) => p.userId === v.userId && p.active);
    if (!profile) return payrollError('no_pay_profile', 422, 'userId');
    if (v.type === 'csr_conversions' && profile.csrRate <= 0)
      return payrollError('no_csr_rate', 422, 'type');
    if (isLocked(pdb, periodOfDate(v.effectiveOn)))
      return payrollError('period_locked', 409, 'effectiveOn');
    const proposed =
      v.type === 'fine' &&
      !has(me, 'fines.manage') &&
      !has(me, 'fines.approve') &&
      !has(me, 'payroll.manage');
    const row: AdjustmentRow = {
      id: pdb.next.adjustment++,
      userId: v.userId,
      type: v.type,
      amount:
        v.type === 'csr_conversions' ? (v.quantity ?? 0) * profile.csrRate : toMinor(v.amount!),
      quantity: v.type === 'csr_conversions' ? (v.quantity ?? null) : null,
      currency: profile.currency,
      effectiveOn: v.effectiveOn,
      reason: v.reason,
      status: proposed ? 'proposed' : 'approved',
      sessionId: v.sessionId ?? null,
      payslipId: null,
      reversesId: null,
      createdBy: ref(me),
      decidedAt: proposed ? null : isoNow(),
      decisionNote: null,
      createdAt: isoNow(),
    };
    pdb.adjustments.push(row);
    touchPeriod(pdb, periodOfDate(row.effectiveOn));
    return HttpResponse.json({ data: adjustmentDto(row, me) }, { status: 201 });
  }),

  http.post(`${API}/payroll/adjustments/:id/:action`, async ({ request, params }) => {
    const action = String(params.action);
    if (!['approve', 'reject', 'cancel'].includes(action)) return notFound();
    const g =
      action === 'cancel'
        ? guardAny(request, 'fines.request', 'fines.manage', 'fines.approve', 'payroll.manage')
        : guardAny(request, 'fines.approve', 'payroll.manage');
    if ('error' in g) return g.error;
    const a = pdb.adjustments.find((x) => x.id === Number(params.id));
    if (!a || !visibleAdjustment(g.me, a)) return notFound();
    const parsed = (action === 'approve' ? approveDecisionSchema : reasonDecisionSchema).safeParse(
      await body(request),
    );
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const note = parsed.data.note ?? null;
    if (action !== 'cancel') {
      if (a.status !== 'proposed') return payrollError('invalid_adjustment_status', 409);
      if (!canDecideAdjustment(g.me, a)) return apiError(403, 'forbidden', 'Forbidden.');
      if (isLocked(pdb, periodOfDate(a.effectiveOn))) return payrollError('period_locked', 409);
      a.status = action === 'approve' ? 'approved' : 'rejected';
      a.decidedAt = isoNow();
      a.decisionNote = note;
      touchPeriod(pdb, periodOfDate(a.effectiveOn));
      return HttpResponse.json({ data: adjustmentDto(a, g.me) });
    }
    if (a.status !== 'proposed' && a.status !== 'approved') {
      return payrollError('invalid_adjustment_status', 409);
    }
    if (a.payslipId !== null) {
      if (a.type !== 'fine') return payrollError('period_locked', 409);
      if (pdb.adjustments.some((x) => x.reversesId === a.id && x.status !== 'cancelled')) {
        return payrollError('already_waived', 409);
      }
      if (!canCancelAdjustment(g.me, a)) return apiError(403, 'forbidden', 'Forbidden.');
      const reduction: AdjustmentRow = {
        ...a,
        id: pdb.next.adjustment++,
        type: 'fine_reduction',
        effectiveOn: firstOpenDate(),
        reason: note ?? a.reason,
        status: 'approved',
        payslipId: null,
        reversesId: a.id,
        createdBy: ref(g.me),
        decidedAt: isoNow(),
        decisionNote: null,
        createdAt: isoNow(),
      };
      pdb.adjustments.push(reduction);
      touchPeriod(pdb, periodOfDate(reduction.effectiveOn));
      return HttpResponse.json(
        { data: { adjustment: adjustmentDto(a, g.me), reduction: adjustmentDto(reduction, g.me) } },
        { status: 201 },
      );
    }
    if (!canCancelAdjustment(g.me, a)) return apiError(403, 'forbidden', 'Forbidden.');
    if (isLocked(pdb, periodOfDate(a.effectiveOn))) return payrollError('period_locked', 409);
    a.status = 'cancelled';
    a.decidedAt = isoNow();
    a.decisionNote = note;
    touchPeriod(pdb, periodOfDate(a.effectiveOn));
    return HttpResponse.json({ data: { adjustment: adjustmentDto(a, g.me), reduction: null } });
  }),

  http.get(`${API}/payroll/people`, ({ request }) => {
    const g = guardAny(
      request,
      'fines.request',
      'fines.manage',
      'fines.approve',
      'payroll.manage',
      'attendance.manage',
    );
    if ('error' in g) return g.error;
    const q = (queryOf(request).q ?? '').trim().toLowerCase();
    const rows = pdb.profiles
      .filter((p) => p.active)
      .map((p) => ({ ...person(p.userId), currency: p.currency }))
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return HttpResponse.json({ data: rows });
  }),

  // ---------------------------------------------------------------- salary profiles
  http.get(`${API}/salary-profiles`, ({ request }) => {
    const g = guard(request, 'payroll.manage');
    if ('error' in g) return g.error;
    const parsed = payProfileListQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const q = (parsed.data.q ?? '').toLowerCase();
    const rows = pdb.profiles
      .filter((p) => !q || personOf(p.userId).name.toLowerCase().includes(q))
      .sort((a, b) => personOf(a.userId).name.localeCompare(personOf(b.userId).name))
      .map(profileDto);
    return HttpResponse.json(
      paginate(rows, parsed.data.page, parsed.data.perPage, { all: rows.length }),
    );
  }),

  http.get(`${API}/salary-profiles/:userId`, ({ request, params }) => {
    const g = guard(request, 'payroll.manage');
    if ('error' in g) return g.error;
    const p = pdb.profiles.find((x) => x.userId === Number(params.userId));
    return HttpResponse.json({ data: p ? profileDto(p) : null });
  }),

  http.put(`${API}/salary-profiles/:userId`, async ({ request, params }) => {
    const g = guard(request, 'payroll.manage');
    if ('error' in g) return g.error;
    const parsed = savePayProfileSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const v = parsed.data;
    const userId = Number(params.userId);
    const minor = (s: string | undefined) => (s ? toMinor(s) : 0);
    let row = pdb.profiles.find((x) => x.userId === userId);
    if (!row) {
      row = {
        id: pdb.next.profile++,
        userId,
        salaryType: v.salaryType,
        currency: v.currency,
        monthly: 0,
        classRate: 0,
        hourlyRate: 0,
        csrRate: 0,
        allowance: 0,
        tax: 0,
        slotTiers: [],
        active: true,
        notes: null,
        updatedAt: isoNow(),
      };
      pdb.profiles.push(row);
    }
    Object.assign(row, {
      salaryType: v.salaryType,
      currency: v.currency,
      monthly: minor(v.monthlySalary),
      classRate: minor(v.classRate),
      hourlyRate: minor(v.hourlyRate),
      csrRate: minor(v.csrRate),
      allowance: minor(v.allowance),
      tax: minor(v.tax),
      slotTiers: (v.slotTiers ?? []).map((t) => ({
        minSlots: t.minSlots,
        amount: toMinor(t.amount),
      })),
      active: v.active ?? row.active,
      notes: v.notes ?? null,
      updatedAt: isoNow(),
    });
    touchPeriod(pdb, periodOfDate(academyToday()));
    return HttpResponse.json({ data: profileDto(row) });
  }),

  // ---------------------------------------------------------------- runs
  http.get(`${API}/payroll/runs/preview`, ({ request }) => {
    const g = guardAny(request, 'payroll.manage', 'payroll.review', 'payroll.approve');
    if ('error' in g) return g.error;
    const parsed = runPreviewQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const today = academyToday();
    const slips = pdb.profiles
      .filter((p) => p.active && (!parsed.data.userId || p.userId === parsed.data.userId))
      .map((p) => ({ userId: p.userId, ...computeSlip(pdb, p, parsed.data.period, today) }));
    return HttpResponse.json({
      data: {
        period: parsed.data.period,
        computedAt: isoNow(),
        payslips: slips.map((s) => ({
          period: parsed.data.period,
          status: 'draft' as const,
          paidAt: null,
          paidOn: null,
          paymentMethod: null,
          paymentReference: null,
          ...slipBody(s, true, false),
        })),
        totals: totalsOf(slips),
      },
    });
  }),

  http.get(`${API}/payroll/runs`, ({ request }) => {
    const g = guardAny(request, 'payroll.manage', 'payroll.review', 'payroll.approve');
    if ('error' in g) return g.error;
    const parsed = runListQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const rows = [...pdb.runs]
      .sort((a, b) => b.period.localeCompare(a.period))
      .map((r) => runDto(r, g.me));
    return HttpResponse.json(
      paginate(rows, parsed.data.page, parsed.data.perPage, { all: rows.length }),
    );
  }),

  http.post(`${API}/payroll/runs`, async ({ request }) => {
    const g = guard(request, 'payroll.manage');
    if ('error' in g) return g.error;
    const parsed = createRunSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const period = parsed.data.period;
    if (pdb.runs.some((r) => r.period === period)) return payrollError('run_exists', 409, 'period');
    if (period > periodOfDate(academyToday()))
      return payrollError('period_not_started', 422, 'period');
    const run: RunRow = {
      id: pdb.next.run++,
      period,
      status: 'draft',
      computedAt: null,
      createdBy: ref(g.me),
      reviewedBy: null,
      reviewedAt: null,
      approvedBy: null,
      approvedAt: null,
      paidAt: null,
    };
    pdb.runs.push(run);
    recompute(pdb, run);
    return HttpResponse.json({ data: runDto(run, g.me) }, { status: 201 });
  }),

  http.get(`${API}/payroll/runs/:id`, ({ request, params }) => {
    const g = guardAny(request, 'payroll.manage', 'payroll.review', 'payroll.approve');
    if ('error' in g) return g.error;
    const run = findRun(params.id);
    if (!run) return notFound();
    const slips = pdb.slips
      .filter((s) => s.runId === run.id)
      .sort((a, b) => personOf(a.userId).name.localeCompare(personOf(b.userId).name))
      .map((s) => slipDto(s, g.me));
    return HttpResponse.json({ data: { ...runDto(run, g.me), payslips: slips } });
  }),

  http.post(`${API}/payroll/runs/:id/:action`, async ({ request, params }) => {
    const action = String(params.action);
    const perm: Record<string, string> = {
      recompute: 'payroll.manage',
      review: 'payroll.review',
      approve: 'payroll.approve',
      reopen: 'payroll.approve',
    };
    if (!perm[action]) return notFound();
    const g = guard(request, perm[action]);
    if ('error' in g) return g.error;
    const run = findRun(params.id);
    if (!run) return notFound();
    const open = run.status === 'draft' || run.status === 'reviewed';
    if (action === 'recompute') {
      if (!open) return payrollError('invalid_run_status', 409);
      recompute(pdb, run);
      run.status = 'draft';
    } else if (action === 'review') {
      if (run.status !== 'draft') return payrollError('invalid_run_status', 409);
      recompute(pdb, run);
      const blocked = pdb.slips.filter((s) => s.runId === run.id && s.errors.length);
      if (blocked.length) {
        return payrollError('payroll_blocked', 422, undefined, {
          payslips: blocked.map((s) => slipDto(s, g.me)),
        });
      }
      run.status = 'reviewed';
      run.reviewedBy = ref(g.me);
      run.reviewedAt = isoNow();
    } else if (action === 'approve') {
      if (run.status !== 'reviewed') return payrollError('invalid_run_status', 409);
      approveRun(pdb, run, ref(g.me));
    } else {
      const parsed = reasonDecisionSchema.safeParse(await body(request));
      if (!parsed.success) return validationFailed(parsed.error.issues);
      if (run.status !== 'approved') return payrollError('invalid_run_status', 409);
      const slips = pdb.slips.filter((s) => s.runId === run.id);
      if (slips.some((s) => s.paymentMethod !== null)) return payrollError('payslips_paid', 409);
      for (const s of slips) {
        pdb.wallet.push({
          id: pdb.next.wallet++,
          userId: s.userId,
          currency: s.currency,
          amount: -slipTotals(s).net,
          type: 'reversal',
          payslipId: s.id,
          period: run.period,
          reference: null,
          occurredAt: isoNow(),
        });
        s.status = 'draft';
        s.paidAt = null;
        s.paidOn = null;
      }
      for (const a of pdb.adjustments) {
        if (slips.some((s) => s.id === a.payslipId)) a.payslipId = null;
      }
      run.status = 'draft';
      run.approvedBy = null;
      run.approvedAt = null;
      run.reviewedBy = null;
      run.reviewedAt = null;
      recompute(pdb, run);
    }
    return HttpResponse.json({ data: runDto(run, g.me) });
  }),

  // ---------------------------------------------------------------- payslips and wallets
  http.get(`${API}/payslips/:id`, ({ request, params }) => {
    const g = guardAny(
      request,
      'payroll.view',
      'payroll.manage',
      'payroll.review',
      'payroll.approve',
    );
    if ('error' in g) return g.error;
    const s = pdb.slips.find((x) => x.id === Number(params.id));
    if (!s) return notFound();
    if (!payrollStaff(g.me) && (s.userId !== g.me.id || s.status === 'draft')) return notFound();
    return HttpResponse.json({ data: slipDto(s, g.me, true) });
  }),

  http.post(`${API}/payslips/:id/payments`, async ({ request, params }) => {
    const g = guard(request, 'payroll.manage');
    if ('error' in g) return g.error;
    const s = pdb.slips.find((x) => x.id === Number(params.id));
    if (!s) return notFound();
    const parsed = recordPaymentSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    if (s.status === 'paid') return payrollError('payslip_already_paid', 409);
    if (s.status !== 'approved') return payrollError('invalid_run_status', 409);
    paySlip(pdb, s, {
      method: parsed.data.method,
      reference: parsed.data.reference ?? null,
      paidOn: parsed.data.paidOn,
    });
    return HttpResponse.json({ data: slipDto(s, g.me, true) });
  }),

  http.get(`${API}/me/payslips`, ({ request }) => {
    const g = guard(request, 'payroll.view');
    if ('error' in g) return g.error;
    const rows = pdb.slips
      .filter((s) => s.userId === g.me.id && s.status !== 'draft')
      .map((s) => slipDto(s, g.me))
      .sort((a, b) => b.period.localeCompare(a.period))
      .slice(0, 36);
    return HttpResponse.json({ data: rows });
  }),

  http.get(`${API}/me/wallet`, ({ request }) => {
    const g = guard(request, 'wallet.view');
    if ('error' in g) return g.error;
    const mine = pdb.wallet.filter((w) => w.userId === g.me.id);
    const by = new Map<string, number>();
    for (const w of mine) by.set(w.currency, (by.get(w.currency) ?? 0) + w.amount);
    return HttpResponse.json({
      data: {
        balances: [...by.entries()].map(([currency, b]) => ({ currency, balance: fromMinor(b) })),
        transactions: [...mine]
          .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id - a.id)
          .slice(0, 50)
          .map((w) => ({
            id: w.id,
            type: w.type,
            currency: w.currency,
            amount: fromMinor(w.amount),
            payslipId: w.payslipId,
            period: w.period,
            reference: w.reference,
            occurredAt: w.occurredAt,
          })),
      },
    });
  }),

  http.get(`${API}/wallets`, ({ request }) => {
    const g = guard(request, 'wallet.manage');
    if ('error' in g) return g.error;
    const by = new Map<
      string,
      { userId: number; currency: string; balance: number; lastAt: string | null }
    >();
    for (const w of pdb.wallet) {
      const key = `${w.userId}:${w.currency}`;
      const row = by.get(key) ?? {
        userId: w.userId,
        currency: w.currency,
        balance: 0,
        lastAt: null,
      };
      row.balance += w.amount;
      if (!row.lastAt || w.occurredAt > row.lastAt) row.lastAt = w.occurredAt;
      by.set(key, row);
    }
    return HttpResponse.json({
      data: [...by.values()]
        .sort((a, b) => personOf(a.userId).name.localeCompare(personOf(b.userId).name))
        .map((r) => ({
          user: person(r.userId),
          currency: r.currency,
          balance: fromMinor(r.balance),
          lastAt: r.lastAt,
        })),
    });
  }),

  // ---------------------------------------------------------------- pay rule sets
  http.get(`${API}/pay-rule-sets`, ({ request }) => {
    const g = guard(request, 'settings.view');
    if ('error' in g) return g.error;
    return HttpResponse.json({
      data: [...pdb.ruleSets].sort(
        (a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.id - a.id,
      ),
    });
  }),

  http.post(`${API}/pay-rule-sets`, async ({ request }) => {
    const g = guard(request, 'settings.manage');
    if ('error' in g) return g.error;
    const parsed = createPayRuleSetSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const from = new Date(parsed.data.effectiveFrom);
    const todayStart = Date.parse(`${academyToday()}T00:00:00+02:00`) - 3_600_000;
    if (from.getTime() < todayStart) {
      return apiError(422, 'validation_failed', 'The given data was invalid.', {
        effectiveFrom: ['The rules must start today or later.'],
      });
    }
    const rules = { ...parsed.data.rules };
    rules.default ??= { factor: 0, billable: false };
    const row = {
      id: pdb.next.ruleSet++,
      effectiveFrom: from.toISOString(),
      rules,
      note: parsed.data.note ?? null,
      createdBy: ref(g.me),
      createdAt: isoNow(),
    };
    pdb.ruleSets.push(row);
    return HttpResponse.json({ data: row }, { status: 201 });
  }),
];

export { ADMIN_REF };
