import {
  asText,
  bool,
  camelizeJson,
  dateOnly,
  floatToDecimal,
  int,
  json,
  minorToDecimal,
  oneOf,
  type Row,
  str,
  text,
} from '../convert.js';
import {
  batch,
  type MapContext,
  type ModuleMapper,
  type SelfRef,
  type TargetBatch,
} from '../plan.js';
import { fit, stamps, t } from './people.js';

const money = (r: Row, col: string): string => minorToDecimal(int(r, col) ?? 0)!;
/** Pay profile money must be >= 0 (CHECK): a negative value is reported and set to 0. */
const nonNeg = (ctx: MapContext, r: Row, col: string): string => {
  const v = int(r, col) ?? 0;
  if (v < 0) ctx.report.change('pay_profiles', r.id, `${col} negative: 0`);
  return minorToDecimal(Math.max(0, v))!;
};
const user = (ctx: MapContext, r: Row, col: string): number | null =>
  ctx.has('users', int(r, col)) ? int(r, col) : null;

/** Laravel `[{min_slots, amount_minor}]` → `[{minSlots, amount: "100.00"}]`. */
export function slotTiers(value: unknown): Array<{ minSlots: number; amount: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((x) => ({
      minSlots: Number(x.min_slots ?? x.minSlots ?? 0),
      amount: minorToDecimal(asText(x.amount_minor ?? 0)) ?? '0.00',
    }))
    .sort((a, b) => a.minSlots - b.minSlots);
}

/** Payslip rate snapshot (`*_minor` → decimal strings, camelCase), as `ratesOf()` writes it. */
export function rates(value: unknown): Record<string, unknown> {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const out = camelizeJson({ ...v, slot_tiers: undefined }) as Record<string, unknown>;
  delete out.slotTiers;
  return { ...out, slotTiers: slotTiers(v.slot_tiers) };
}

export const payrollMapper: ModuleMapper = {
  name: 'payroll',
  sources: [
    'pay_profiles',
    'teachers',
    'leave_requests',
    'staff_attendance',
    'payroll_runs',
    'payslips',
    'pay_adjustments',
    'payslip_lines',
    'payslip_sessions',
    'wallet_transactions',
    'payroll_events',
    'teacher_transactions',
    'expenses',
  ],
  dependsOn: ['people', 'sessions'],
  tables: [
    'pay_profiles',
    'leave_requests',
    'staff_attendance',
    'payroll_runs',
    'payslips',
    'pay_adjustments',
    'payslip_lines',
    'payslip_sessions',
    'wallet_transactions',
    'payroll_events',
  ],
  map(ctx: MapContext): TargetBatch[] {
    const out: TargetBatch[] = [];

    // Pay profiles, plus the legacy `teachers.amount_per_hour` of teachers without one (D89,
    // same rule as the N7 migration and Laravel `TeacherPayRate`).
    const profiles: Row[] = [];
    const byUser = new Set<number>();
    const byTeacher = new Set<number>();
    for (const r of ctx.rows('pay_profiles')) {
      const id = int(r, 'id')!;
      const userId = int(r, 'user_id');
      if (!ctx.has('users', userId) || byUser.has(userId!)) {
        ctx.report.skip('pay_profiles', id, `user ${userId} not imported or already has a profile`);
        continue;
      }
      let teacherId = int(r, 'teacher_id');
      if (teacherId !== null && (!ctx.has('teachers', teacherId) || byTeacher.has(teacherId)))
        teacherId = null;
      byUser.add(userId!);
      if (teacherId !== null) byTeacher.add(teacherId);
      profiles.push({
        id,
        userId,
        teacherId,
        salaryType:
          oneOf(str(r, 'salary_type'), ['monthly', 'per_class', 'hourly', 'slot'] as const) ??
          'hourly',
        currency: text(r, 'currency')?.toUpperCase() ?? null,
        monthlySalary: nonNeg(ctx, r, 'monthly_salary_minor'),
        classRate: nonNeg(ctx, r, 'class_rate_minor'),
        hourlyRate: nonNeg(ctx, r, 'hourly_rate_minor'),
        csrRate: nonNeg(ctx, r, 'csr_rate_minor'),
        allowance: nonNeg(ctx, r, 'allowance_minor'),
        tax: nonNeg(ctx, r, 'tax_minor'),
        slotTiers: slotTiers(json(r, 'slot_tiers')),
        active: bool(r, 'active') ?? true,
        notes: fit(ctx, 'pay_profiles', id, 'notes', text(r, 'notes'), 500),
        updatedById: user(ctx, r, 'updated_by'),
        ...stamps(ctx, r),
      });
    }
    let nextId = Math.max(0, ...profiles.map((p) => p.id as number)) + 1;
    for (const r of ctx.rows('teachers')) {
      const teacherId = int(r, 'id')!;
      const userId = int(r, 'user_id');
      const rate =
        typeof r.amount_per_hour === 'number'
          ? r.amount_per_hour
          : Number(r.amount_per_hour ?? NaN);
      if (
        !ctx.has('teachers', teacherId) ||
        byUser.has(userId!) ||
        byTeacher.has(teacherId) ||
        !(rate > 0)
      )
        continue;
      ctx.report.change(
        'teachers',
        teacherId,
        `legacy amount_per_hour ${rate} moved to a new hourly pay profile #${nextId}`,
      );
      byUser.add(userId!);
      profiles.push({
        id: nextId++,
        userId,
        teacherId,
        salaryType: 'hourly',
        currency: text(r, 'salary_currency')?.toUpperCase() ?? null,
        hourlyRate: floatToDecimal(rate),
        slotTiers: [],
        active: true,
        ...stamps(ctx, r),
      });
    }
    out.push(
      batch(
        'pay_profiles',
        'payProfile',
        'pay_profiles+teachers',
        ctx.rows('pay_profiles').length,
        profiles,
      ),
    );

    const leaves: Row[] = [];
    for (const r of ctx.rows('leave_requests')) {
      const leaveType = oneOf(str(r, 'leave_type'), ['paid', 'unpaid', 'sick'] as const);
      const status = oneOf(str(r, 'status'), [
        'pending',
        'approved',
        'rejected',
        'cancelled',
      ] as const);
      const s = dateOnly(r.starts_on);
      const e = dateOnly(r.ends_on);
      if (
        !ctx.has('users', int(r, 'user_id')) ||
        !leaveType ||
        !status ||
        !s ||
        !e ||
        e < s ||
        (int(r, 'days') ?? 0) < 1
      ) {
        ctx.report.skip(
          'leave_requests',
          r.id,
          'user not imported, type/status unknown or dates/days invalid',
        );
        continue;
      }
      leaves.push({
        id: int(r, 'id')!,
        userId: int(r, 'user_id'),
        startsOn: dateOnly(r.starts_on),
        endsOn: dateOnly(r.ends_on),
        days: int(r, 'days') ?? 1,
        leaveType,
        reason: fit(ctx, 'leave_requests', r.id, 'reason', str(r, 'reason') ?? '', 2000),
        status,
        requestedById: user(ctx, r, 'requested_by'),
        decidedById: user(ctx, r, 'decided_by'),
        decidedAt: t(ctx, r.decided_at),
        decisionNote: fit(
          ctx,
          'leave_requests',
          r.id,
          'decision_note',
          text(r, 'decision_note'),
          2000,
        ),
        ...stamps(ctx, r),
      });
    }
    ctx.remember(
      'leave_requests',
      leaves.map((l) => l.id as number),
    );
    out.push(
      batch(
        'leave_requests',
        'leaveRequest',
        'leave_requests',
        ctx.rows('leave_requests').length,
        leaves,
      ),
    );

    const attendance: Row[] = [];
    for (const r of ctx.rows('staff_attendance')) {
      const status = oneOf(str(r, 'status'), ['present', 'absent', 'leave', 'holiday'] as const);
      if (!ctx.has('users', int(r, 'user_id')) || !status) {
        ctx.report.skip('staff_attendance', r.id, 'user not imported or status unknown');
        continue;
      }
      const checkInAt = t(ctx, r.check_in_at);
      let checkOutAt = t(ctx, r.check_out_at);
      if (checkOutAt && (!checkInAt || checkOutAt < checkInAt)) {
        ctx.report.change(
          'staff_attendance',
          r.id,
          'check-out without a check-in or before it: cleared',
        );
        checkOutAt = null;
      }
      attendance.push({
        id: int(r, 'id')!,
        userId: int(r, 'user_id'),
        workDate: dateOnly(r.work_date),
        status,
        paidLeave: bool(r, 'paid_leave') ?? true,
        checkInAt,
        checkOutAt,
        workedMinutes: int(r, 'worked_minutes'),
        timezone: text(r, 'timezone'),
        source: oneOf(str(r, 'source'), ['self', 'staff', 'leave'] as const) ?? 'staff',
        leaveRequestId: ctx.has('leave_requests', int(r, 'leave_request_id'))
          ? int(r, 'leave_request_id')
          : null,
        note: fit(ctx, 'staff_attendance', r.id, 'note', text(r, 'note'), 1000),
        recordedById: user(ctx, r, 'recorded_by'),
        ...stamps(ctx, r),
      });
    }
    out.push(
      batch(
        'staff_attendance',
        'staffAttendance',
        'staff_attendance',
        ctx.rows('staff_attendance').length,
        attendance,
      ),
    );

    const runs = ctx
      .rows('payroll_runs')
      .filter((r) => {
        if (/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(str(r, 'period') ?? '')) return true;
        ctx.report.skip('payroll_runs', r.id, `period "${str(r, 'period')}" is not YYYY-MM`);
        return false;
      })
      .map((r) => ({
        id: int(r, 'id')!,
        period: str(r, 'period'),
        startsOn: dateOnly(r.starts_on),
        endsOn: dateOnly(r.ends_on),
        status:
          oneOf(str(r, 'status'), ['draft', 'reviewed', 'approved', 'paid'] as const) ?? 'draft',
        computedAt: t(ctx, r.computed_at),
        createdById: user(ctx, r, 'created_by'),
        reviewedById: user(ctx, r, 'reviewed_by'),
        reviewedAt: t(ctx, r.reviewed_at),
        approvedById: user(ctx, r, 'approved_by'),
        approvedAt: t(ctx, r.approved_at),
        paidAt: t(ctx, r.paid_at),
        ...stamps(ctx, r),
      }));
    ctx.remember(
      'payroll_runs',
      runs.map((r) => r.id),
    );
    out.push(
      batch('payroll_runs', 'payrollRun', 'payroll_runs', ctx.rows('payroll_runs').length, runs),
    );

    const slips: Row[] = [];
    for (const r of ctx.rows('payslips')) {
      const id = int(r, 'id')!;
      const salaryType = oneOf(str(r, 'salary_type'), [
        'monthly',
        'per_class',
        'hourly',
        'slot',
      ] as const);
      if (
        !ctx.has('payroll_runs', int(r, 'payroll_run_id')) ||
        !ctx.has('users', int(r, 'user_id')) ||
        !salaryType
      ) {
        ctx.report.skip('payslips', id, 'run/user not imported or salary type unknown');
        continue;
      }
      const currency = text(r, 'currency')?.toUpperCase();
      if (!currency)
        ctx.report.change(
          'payslips',
          id,
          `no currency: ${ctx.opts.payrollCurrency} (payroll default)`,
        );
      slips.push({
        id,
        runId: int(r, 'payroll_run_id'),
        userId: int(r, 'user_id'),
        teacherId: ctx.has('teachers', int(r, 'teacher_id')) ? int(r, 'teacher_id') : null,
        currency: currency ?? ctx.opts.payrollCurrency,
        salaryType,
        rates: rates(json(r, 'rates')),
        paidHours: str(r, 'paid_hours') ?? '0',
        paidClasses: int(r, 'paid_classes') ?? 0,
        deductionDays: int(r, 'deduction_days') ?? 0,
        earnings: money(r, 'earnings_minor'),
        deductions: money(r, 'deductions_minor'),
        net: money(r, 'net_minor'),
        status: oneOf(str(r, 'status'), ['draft', 'approved', 'paid'] as const) ?? 'draft',
        warnings: camelizeJson(json(r, 'warnings') ?? []),
        errors: camelizeJson(json(r, 'errors') ?? []),
        paidAt: t(ctx, r.paid_at),
        paidOn: dateOnly(r.paid_on),
        paidById: user(ctx, r, 'paid_by'),
        paymentMethod: oneOf(str(r, 'payment_method'), [
          'vodafone_cash',
          'bank_transfer',
          'cash',
          'other',
        ] as const),
        paymentReference: fit(
          ctx,
          'payslips',
          id,
          'payment_reference',
          text(r, 'payment_reference'),
          120,
        ),
        ...stamps(ctx, r),
      });
    }
    ctx.remember(
      'payslips',
      slips.map((s) => s.id as number),
    );
    out.push(batch('payslips', 'payslip', 'payslips', ctx.rows('payslips').length, slips));

    const adjustments: Row[] = [];
    const reverses: SelfRef = { column: 'reverses_id', pairs: [] };
    for (const r of ctx.rows('pay_adjustments')) {
      const id = int(r, 'id')!;
      const type = oneOf(str(r, 'type'), [
        'fine',
        'bonus',
        'advance',
        'arrears',
        'fine_reduction',
        'gift',
        'other_addition',
        'other_deduction',
        'csr_conversions',
      ] as const);
      const status = oneOf(str(r, 'status'), [
        'proposed',
        'approved',
        'rejected',
        'cancelled',
      ] as const);
      if (!ctx.has('users', int(r, 'user_id')) || !type || !status) {
        ctx.report.skip('pay_adjustments', id, 'user not imported or type/status unknown');
        continue;
      }
      const rev = int(r, 'reverses_id');
      if (rev !== null) reverses.pairs.push([id, rev]);
      const minor = int(r, 'amount_minor') ?? 0;
      if (minor < 0)
        ctx.report.change(
          'pay_adjustments',
          id,
          'negative amount: stored positive (the type decides the sign)',
        );
      adjustments.push({
        id,
        userId: int(r, 'user_id'),
        type,
        amount: minorToDecimal(Math.abs(minor)),
        quantity: int(r, 'quantity'),
        currency: str(r, 'currency')?.toUpperCase(),
        effectiveOn: dateOnly(r.effective_on),
        reason: fit(ctx, 'pay_adjustments', id, 'reason', str(r, 'reason') ?? '', 2000),
        status,
        sessionId: ctx.has('class_sessions', int(r, 'session_id')) ? int(r, 'session_id') : null,
        payslipId: ctx.has('payslips', int(r, 'payslip_id')) ? int(r, 'payslip_id') : null,
        reversesId: null,
        createdById: user(ctx, r, 'created_by'),
        decidedById: user(ctx, r, 'decided_by'),
        decidedAt: t(ctx, r.decided_at),
        decisionNote: fit(
          ctx,
          'pay_adjustments',
          id,
          'decision_note',
          text(r, 'decision_note'),
          2000,
        ),
        ...stamps(ctx, r),
      });
    }
    ctx.remember(
      'pay_adjustments',
      adjustments.map((a) => a.id as number),
    );
    reverses.pairs = reverses.pairs.filter(([, ref]) => ctx.has('pay_adjustments', ref));
    out.push(
      batch(
        'pay_adjustments',
        'payAdjustment',
        'pay_adjustments',
        ctx.rows('pay_adjustments').length,
        adjustments,
        true,
        [reverses],
      ),
    );

    const lines: Row[] = [];
    for (const r of ctx.rows('payslip_lines')) {
      if (!ctx.has('payslips', int(r, 'payslip_id'))) {
        ctx.report.skip('payslip_lines', r.id, 'payslip not imported');
        continue;
      }
      const rate = int(r, 'rate_minor');
      let sign = int(r, 'sign') ?? 1;
      let amount = int(r, 'amount_minor') ?? 0;
      if (amount < 0) {
        ctx.report.change(
          'payslip_lines',
          r.id,
          'negative amount: stored positive with the sign flipped',
        );
        amount = -amount;
        sign = -sign;
      }
      sign = sign < 0 ? -1 : 1;
      lines.push({
        id: int(r, 'id')!,
        payslipId: int(r, 'payslip_id'),
        code: fit(ctx, 'payslip_lines', r.id, 'code', str(r, 'code') ?? '-', 24),
        sign,
        quantity: str(r, 'quantity'),
        rate: rate !== null ? minorToDecimal(rate) : null,
        amount: minorToDecimal(amount),
        payAdjustmentId: ctx.has('pay_adjustments', int(r, 'pay_adjustment_id'))
          ? int(r, 'pay_adjustment_id')
          : null,
        position: int(r, 'position') ?? 0,
      });
    }
    out.push(
      batch(
        'payslip_lines',
        'payslipLine',
        'payslip_lines',
        ctx.rows('payslip_lines').length,
        lines,
      ),
    );

    const sessions: Row[] = [];
    for (const r of ctx.rows('payslip_sessions')) {
      if (!ctx.has('payslips', int(r, 'payslip_id'))) {
        ctx.report.skip('payslip_sessions', r.id, 'payslip not imported');
        continue;
      }
      sessions.push({
        id: int(r, 'id')!,
        payslipId: int(r, 'payslip_id'),
        sessionId: int(r, 'session_id'),
        startsAt: t(ctx, r.starts_at),
        kind: str(r, 'kind') ?? 'regular',
        stage: str(r, 'stage') ?? 'taken',
        payHours: str(r, 'pay_hours') ?? '0',
        payRuleKey: text(r, 'pay_rule_key'),
      });
    }
    out.push(
      batch(
        'payslip_sessions',
        'payslipSession',
        'payslip_sessions',
        ctx.rows('payslip_sessions').length,
        sessions,
      ),
    );

    const wallet: Row[] = [];
    for (const r of ctx.rows('wallet_transactions')) {
      const type = oneOf(str(r, 'type'), ['salary_credit', 'salary_payment', 'reversal'] as const);
      if (!ctx.has('users', int(r, 'user_id')) || !type) {
        ctx.report.skip('wallet_transactions', r.id, 'user not imported or type unknown');
        continue;
      }
      wallet.push({
        id: int(r, 'id')!,
        userId: int(r, 'user_id'),
        currency: str(r, 'currency')?.toUpperCase(),
        amount: money(r, 'amount_minor'),
        type,
        payslipId: ctx.has('payslips', int(r, 'payslip_id')) ? int(r, 'payslip_id') : null,
        reference: fit(ctx, 'wallet_transactions', r.id, 'reference', text(r, 'reference'), 190),
        createdById: user(ctx, r, 'created_by'),
        occurredAt: t(ctx, r.occurred_at),
        createdAt: stamps(ctx, r).createdAt,
      });
    }
    out.push(
      batch(
        'wallet_transactions',
        'walletTransaction',
        'wallet_transactions',
        ctx.rows('wallet_transactions').length,
        wallet,
      ),
    );

    const events = ctx.rows('payroll_events').map((r) => ({
      id: int(r, 'id')!,
      type: str(r, 'type'),
      aggregateType: str(r, 'aggregate_type'),
      aggregateId: int(r, 'aggregate_id'),
      payload: camelizeJson(json(r, 'payload') ?? {}),
      occurredAt: t(ctx, r.occurred_at),
      consumedAt: t(ctx, r.consumed_at),
      createdAt: stamps(ctx, r).createdAt,
    }));
    out.push(
      batch(
        'payroll_events',
        'payrollEvent',
        'payroll_events',
        ctx.rows('payroll_events').length,
        events,
      ),
    );

    if (ctx.rows('teacher_transactions').length) {
      ctx.report.noCounterpart(
        'teacher_transactions',
        ctx.rows('teacher_transactions').length,
        'pre-M6 per-class teacher pay rows (payslips replace them)',
      );
    }
    if (ctx.rows('expenses').length) {
      ctx.report.noCounterpart(
        'expenses',
        ctx.rows('expenses').length,
        'expenses belong to the accounting module (Phase 2), not N1–N7',
      );
    }
    return out;
  },
};
