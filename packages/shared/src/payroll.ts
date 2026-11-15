import { z } from 'zod';
import { dateOnlySchema, paginatedSchema } from './people.js';
import { SESSION_KINDS, SESSION_STAGES } from './sessions.js';
import { monthSchema } from './tests.js';

/**
 * Payroll (N7; Laravel M6, docs/21, D89–D95): staff attendance and leave, fines and other pay
 * adjustments, salary (pay) profiles, versioned pay rules, monthly payroll runs, payslips and the
 * teacher wallet. `/api/v1/attendance…`, `/leave-requests…`, `/payroll/…`, `/salary-profiles…`,
 * `/payslips…`, `/me/payslips`, `/me/wallet`, `/wallets`, `/pay-rule-sets`.
 *
 * Payroll only computes, records and approves (D140): no money is moved by the API. Recording a
 * payment ("mark paid") stores what Accounts did outside the system.
 *
 * Money is a decimal string with 2 decimals (`"150.00"`) plus its ISO currency; the API computes in
 * integer minor units and rounds half-up once per line (D90). Dates are `YYYY-MM-DD`, instants ISO
 * UTC. A payroll month (`period`, `YYYY-MM`) is a calendar month in the academy zone.
 */

type Labels<T extends string> = Record<T, { ar: string; en: string }>;

const id = z.number().int().positive();
const queryId = z.coerce.number().int().positive().max(2_147_483_647);

/** A decimal amount from 0.01 to 99,999,999.99 (number or string, at most 2 decimals) → `"12.50"`. */
export const payMoneyInputSchema = z
  .union([z.number(), z.string().trim()])
  .transform((v) => String(v))
  .pipe(
    z.string().regex(/^\d{1,8}(\.\d{1,2})?$/, {
      message: 'Use a positive amount with at most 2 decimals.',
    }),
  )
  .transform((v) => Number(v).toFixed(2));

/** Like {@link payMoneyInputSchema} but 0 is allowed (rates and salaries). */
const rateInputSchema = payMoneyInputSchema;
const positiveMoneySchema = payMoneyInputSchema.refine((v) => Number(v) > 0, {
  message: 'The amount must be greater than 0.',
});

const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, { message: 'Use a 3-letter currency code.' });

const reasonText = z.string().trim().min(3).max(2000);

export { monthSchema as periodSchema };

// ------------------------------------------------------------------ catalog

/** Old `profile.Salary` 1–4 (docs/21 §2). */
export const SALARY_TYPES = ['monthly', 'per_class', 'hourly', 'slot'] as const;
export type SalaryType = (typeof SALARY_TYPES)[number];
export const SALARY_TYPE_LABELS: Labels<SalaryType> = {
  monthly: { ar: 'راتب شهري ثابت', en: 'Fixed monthly salary' },
  per_class: { ar: 'بالحصة', en: 'Per class' },
  hourly: { ar: 'بالساعة', en: 'Hourly' },
  slot: { ar: 'بشرائح الحصص', en: 'Per slot (tiers)' },
};

export const ATTENDANCE_STATUSES = ['present', 'absent', 'leave', 'holiday'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];
export const ATTENDANCE_STATUS_LABELS: Labels<AttendanceStatus> = {
  present: { ar: 'حاضر', en: 'Present' },
  absent: { ar: 'غائب', en: 'Absent' },
  leave: { ar: 'إجازة', en: 'Leave' },
  holiday: { ar: 'عطلة رسمية', en: 'Holiday' },
};

/** Who wrote the day: the person (check-in), staff (marking), an approved leave. */
export const ATTENDANCE_SOURCES = ['self', 'staff', 'leave'] as const;
export type AttendanceSource = (typeof ATTENDANCE_SOURCES)[number];
export const ATTENDANCE_SOURCE_LABELS: Labels<AttendanceSource> = {
  self: { ar: 'تسجيل ذاتي', en: 'Self check-in' },
  staff: { ar: 'تسجيل من الإدارة', en: 'Marked by staff' },
  leave: { ar: 'إجازة معتمدة', en: 'Approved leave' },
};

/** B44: only unpaid leave reduces a monthly salary. */
export const LEAVE_TYPES = ['paid', 'unpaid', 'sick'] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];
export const LEAVE_TYPE_LABELS: Labels<LeaveType> = {
  paid: { ar: 'إجازة مدفوعة', en: 'Paid leave' },
  unpaid: { ar: 'إجازة بدون أجر', en: 'Unpaid leave' },
  sick: { ar: 'إجازة مرضية', en: 'Sick leave' },
};

export const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];
export const LEAVE_STATUS_LABELS: Labels<LeaveStatus> = {
  pending: { ar: 'قيد المراجعة', en: 'Pending' },
  approved: { ar: 'معتمدة', en: 'Approved' },
  rejected: { ar: 'مرفوضة', en: 'Rejected' },
  cancelled: { ar: 'ملغاة', en: 'Cancelled' },
};

/** Old `teacher_fine.type` 1–8 plus CSR conversions (docs/21 §6). */
export const ADJUSTMENT_TYPES = [
  'fine',
  'bonus',
  'advance',
  'arrears',
  'fine_reduction',
  'gift',
  'other_addition',
  'other_deduction',
  'csr_conversions',
] as const;
export type AdjustmentType = (typeof ADJUSTMENT_TYPES)[number];
export const ADJUSTMENT_TYPE_LABELS: Labels<AdjustmentType> = {
  fine: { ar: 'غرامة', en: 'Fine' },
  bonus: { ar: 'مكافأة', en: 'Bonus' },
  advance: { ar: 'سلفة', en: 'Advance' },
  arrears: { ar: 'مستحقات سابقة', en: 'Arrears' },
  fine_reduction: { ar: 'تخفيض غرامة', en: 'Fine reduction' },
  gift: { ar: 'هدية', en: 'Gift' },
  other_addition: { ar: 'إضافة أخرى', en: 'Other addition' },
  other_deduction: { ar: 'خصم آخر', en: 'Other deduction' },
  csr_conversions: { ar: 'عمولة خدمة العملاء', en: 'CSR commission' },
};

/** +1 adds to the net, −1 deducts. */
export function adjustmentSign(type: AdjustmentType): 1 | -1 {
  return type === 'fine' || type === 'advance' || type === 'other_deduction' ? -1 : 1;
}

/** Fines and their reductions belong to the fines workflow (monitor → manager); the rest to payroll. */
export const FINE_TYPES: readonly AdjustmentType[] = ['fine', 'fine_reduction'];
export const isFineWorkflow = (type: AdjustmentType) => FINE_TYPES.includes(type);

export const ADJUSTMENT_STATUSES = ['proposed', 'approved', 'rejected', 'cancelled'] as const;
export type AdjustmentStatus = (typeof ADJUSTMENT_STATUSES)[number];
export const ADJUSTMENT_STATUS_LABELS: Labels<AdjustmentStatus> = {
  proposed: { ar: 'مقترحة', en: 'Proposed' },
  approved: { ar: 'معتمدة', en: 'Approved' },
  rejected: { ar: 'مرفوضة', en: 'Rejected' },
  cancelled: { ar: 'ملغاة', en: 'Cancelled' },
};

/** docs/21 §7: draft → reviewed → approved → paid. */
export const RUN_STATUSES = ['draft', 'reviewed', 'approved', 'paid'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const RUN_STATUS_LABELS: Labels<RunStatus> = {
  draft: { ar: 'مسودة', en: 'Draft' },
  reviewed: { ar: 'تمت المراجعة', en: 'Reviewed' },
  approved: { ar: 'معتمد', en: 'Approved' },
  paid: { ar: 'مصروف', en: 'Paid' },
};
/** Approved or paid: payslips and the month's inputs are locked. */
export const isLockedRun = (status: RunStatus) => status === 'approved' || status === 'paid';

export const PAYSLIP_STATUSES = ['draft', 'approved', 'paid'] as const;
export type PayslipStatus = (typeof PAYSLIP_STATUSES)[number];
export const PAYSLIP_STATUS_LABELS: Labels<PayslipStatus> = {
  draft: { ar: 'مسودة', en: 'Draft' },
  approved: { ar: 'معتمدة', en: 'Approved' },
  paid: { ar: 'مصروفة', en: 'Paid' },
};

/**
 * How Accounts paid a payslip outside the system (D93). Recorded only: the API never moves
 * money. InstaPay (D134) is on hold and not offered.
 */
export const PAYOUT_METHODS = ['vodafone_cash', 'bank_transfer', 'cash', 'other'] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];
export const PAYOUT_METHOD_LABELS: Labels<PayoutMethod> = {
  vodafone_cash: { ar: 'فودافون كاش', en: 'Vodafone Cash' },
  bank_transfer: { ar: 'تحويل بنكي', en: 'Bank transfer' },
  cash: { ar: 'نقدًا', en: 'Cash' },
  other: { ar: 'أخرى', en: 'Other' },
};

export const WALLET_TX_TYPES = ['salary_credit', 'salary_payment', 'reversal'] as const;
export type WalletTxType = (typeof WALLET_TX_TYPES)[number];
export const WALLET_TX_TYPE_LABELS: Labels<WalletTxType> = {
  salary_credit: { ar: 'إضافة راتب معتمد', en: 'Approved salary' },
  salary_payment: { ar: 'صرف راتب', en: 'Salary paid' },
  reversal: { ar: 'عكس اعتماد', en: 'Approval reversed' },
};

/** Payslip line codes (earnings, adjustments, deductions). */
export const PAYSLIP_LINE_CODES = [
  'monthly_salary',
  'class_earning',
  'hour_earning',
  'slot_earning',
  'allowance',
  ...ADJUSTMENT_TYPES,
  'leave_deduction',
  'tax',
] as const;
export type PayslipLineCode = (typeof PAYSLIP_LINE_CODES)[number];
export const PAYSLIP_LINE_LABELS: Labels<PayslipLineCode> = {
  monthly_salary: { ar: 'الراتب الأساسي', en: 'Base salary' },
  class_earning: { ar: 'أجر الحصص', en: 'Class pay' },
  hour_earning: { ar: 'أجر الساعات', en: 'Hourly pay' },
  slot_earning: { ar: 'أجر الشرائح', en: 'Slot pay' },
  allowance: { ar: 'بدل', en: 'Allowance' },
  ...ADJUSTMENT_TYPE_LABELS,
  leave_deduction: { ar: 'خصم الغياب والإجازات بدون أجر', en: 'Absence and unpaid leave' },
  tax: { ar: 'ضريبة', en: 'Tax' },
};

/** Payslip warnings (do not block) and errors (block the review and the approval). */
export const PAYSLIP_ISSUE_LABELS: Labels<
  | 'unmarked_sessions'
  | 'sessions_need_review'
  | 'fines_pending'
  | 'no_teacher_link'
  | 'prior_period_changed'
  | 'currency_mismatch'
  | 'negative_net'
  | 'no_active_profile'
> = {
  unmarked_sessions: { ar: 'حصص لم تُحسم حالتها', en: 'Classes not marked yet' },
  sessions_need_review: { ar: 'حصص تحتاج مراجعة', en: 'Classes need review' },
  fines_pending: { ar: 'غرامات بانتظار الاعتماد', en: 'Fines waiting for approval' },
  no_teacher_link: { ar: 'ملف الراتب غير مرتبط بمعلم', en: 'Profile not linked to a teacher' },
  prior_period_changed: {
    ar: 'تغيّرت حصص شهر معتمد سابق',
    en: 'Classes of an approved month changed',
  },
  currency_mismatch: { ar: 'عملة البند لا تطابق ملف الراتب', en: 'Item currency mismatch' },
  negative_net: { ar: 'صافي الراتب بالسالب', en: 'Negative net pay' },
  no_active_profile: { ar: 'لم يعد للشخص ملف راتب نشط', en: 'No active salary profile any more' },
};

/** Refusal codes with their messages (Laravel `lang/{en,ar}/payroll.php`). */
export const PAYROLL_ERROR_MESSAGES = {
  run_exists: {
    ar: 'يوجد مسيّر رواتب لهذا الشهر بالفعل.',
    en: 'A payroll run already exists for this month.',
  },
  period_not_started: { ar: 'لم يبدأ هذا الشهر بعد.', en: 'This month has not started yet.' },
  stale_run: {
    ar: 'تغيّر مسيّر الرواتب منذ فتحه. أعد تحميل الصفحة ثم حاول مرة أخرى.',
    en: 'The payroll run changed since you opened it. Reload and try again.',
  },
  invalid_run_status: {
    ar: 'لا يمكن تنفيذ هذا الإجراء على المسيّر في حالته الحالية.',
    en: 'This action is not allowed for the payroll run in its current status.',
  },
  payroll_blocked: {
    ar: 'توجد أخطاء في بعض قسائم الرواتب. صحّحها قبل المتابعة.',
    en: 'Some payslips have errors. Fix them before continuing.',
  },
  payslips_paid: {
    ar: 'صُرفت قسائم من هذا المسيّر؛ أضف تسوية في الشهر التالي بدلًا من ذلك.',
    en: 'Payslips of this run were already paid; add a correction next month instead.',
  },
  period_locked: {
    ar: 'رواتب هذا الشهر معتمدة ومقفلة.',
    en: "This month's payroll is approved and locked.",
  },
  payslip_already_paid: { ar: 'صُرفت هذه القسيمة بالفعل.', en: 'This payslip is already paid.' },
  no_pay_profile: {
    ar: 'لا يوجد ملف راتب لهذا الشخص بعد.',
    en: 'This person has no salary profile yet.',
  },
  no_csr_rate: {
    ar: 'ملف الراتب بلا سعر لعمولة خدمة العملاء.',
    en: 'The salary profile has no CSR commission rate.',
  },
  already_checked_in: {
    ar: 'سجّلت حضورك اليوم بالفعل.',
    en: 'You have already checked in today.',
  },
  not_checked_in: { ar: 'لم تسجّل حضورك بعد.', en: 'You have not checked in.' },
  on_leave: { ar: 'لديك إجازة معتمدة اليوم.', en: 'You are on approved leave today.' },
  leave_overlap: {
    ar: 'تتداخل هذه الإجازة مع إجازة أخرى قيد المراجعة أو معتمدة.',
    en: 'This leave overlaps another pending or approved leave.',
  },
  invalid_leave_status: {
    ar: 'لم يعد بالإمكان تعديل طلب الإجازة هذا.',
    en: 'This leave request can no longer be changed.',
  },
  invalid_adjustment_status: {
    ar: 'لم يعد بالإمكان تعديل هذا البند.',
    en: 'This item can no longer be changed.',
  },
  already_waived: { ar: 'أُعفي من هذه الغرامة بالفعل.', en: 'This fine has already been waived.' },
  forbidden_type: {
    ar: 'لا يمكنك إضافة هذا النوع من البنود.',
    en: 'You cannot add this type of item.',
  },
  /** P0-3 / B116: nobody decides anything about themselves (owner included). */
  self_decision: {
    ar: 'لا يمكنك اتخاذ قرار في أمر يخصك. يتولاه مسؤول آخر.',
    en: 'You cannot decide on something about yourself. Another approver must do it.',
  },
  same_reviewer: {
    ar: 'من راجع مسير الرواتب لا يعتمده. يعتمده مسؤول آخر.',
    en: 'The person who reviewed the payroll run cannot approve it. Another approver must.',
  },
  own_payslip_in_run: {
    ar: 'هذا المسير يتضمن قسيمة راتبك، فيعتمده مسؤول آخر.',
    en: 'This run includes your own payslip, so another approver must approve it.',
  },
  pay_rule_from_past: {
    ar: 'تبدأ قواعد الأجر الجديدة من اليوم أو بعده.',
    en: 'New pay rules start today or later.',
  },
} as const;
export type PayrollErrorCode = keyof typeof PAYROLL_ERROR_MESSAGES;

// ------------------------------------------------------------------ pay rules (D41)

/**
 * Pay rule key: `default`, a stage (`taken`), `stage:reason` (`cancelled:holiday`),
 * `kind:stage`, `kind:*` or `kind:stage:reason`. Most specific first:
 * `kind:stage:reason` → `kind:stage` → `kind:*` → `stage:reason` → `stage` → `default`.
 */
export const PAY_RULE_KEY = /^(default|[a-z_]+(:[a-z_*]+){0,2})$/;

export const payRuleSchema = z.object({
  /** pay hours = factor × duration / 60. */
  factor: z.number().min(0).max(5),
  /** The class is charged to the family (billing reads it). */
  billable: z.boolean(),
  /** The factor applies only when the holiday of the class day is paid, else 0. */
  paidHolidayOnly: z.boolean().optional(),
});
export type PayRule = z.infer<typeof payRuleSchema>;

/** Seeded set #1 (old rules page + B5 + old hourly code: trial unpaid). docs/14 §2.9. */
export const DEFAULT_PAY_RULES: Record<string, PayRule> = {
  taken: { factor: 1, billable: true },
  absent: { factor: 1, billable: true },
  declined: { factor: 1, billable: true },
  leave: { factor: 0, billable: false },
  'cancelled:holiday': { factor: 1, billable: false, paidHolidayOnly: true },
  cancelled: { factor: 0, billable: false },
  moved_out: { factor: 0, billable: false },
  'trial:*': { factor: 0, billable: false },
  default: { factor: 0, billable: false },
};

/** The rule keys tried for a class, most specific first. */
export function payRuleCandidates(kind: string, stage: string, reason: string | null): string[] {
  return [
    reason ? `${kind}:${stage}:${reason}` : null,
    `${kind}:${stage}`,
    `${kind}:*`,
    reason ? `${stage}:${reason}` : null,
    stage,
    'default',
  ].filter((k): k is string => k !== null);
}

export const createPayRuleSetSchema = z.object({
  /** When the set starts to apply (an instant, today or later). */
  effectiveFrom: z.iso.datetime({ offset: true }),
  rules: z
    .record(z.string().regex(PAY_RULE_KEY, 'Invalid rule key.'), payRuleSchema)
    .refine((r) => Object.keys(r).length > 0, { message: 'Add at least one rule.' }),
  note: z.string().trim().max(255).nullish(),
});
export type CreatePayRuleSetInput = z.input<typeof createPayRuleSetSchema>;

export const payRuleSetSchema = z.object({
  id: z.number().int(),
  effectiveFrom: z.string(),
  rules: z.record(z.string(), payRuleSchema),
  note: z.string().nullable(),
  createdBy: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  createdAt: z.string(),
});
export type PayRuleSetDto = z.infer<typeof payRuleSetSchema>;

// ------------------------------------------------------------------ shared blocks

/** A person in payroll payloads (no contact data). */
export const payrollPersonSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  teacherId: z.number().int().nullable(),
});
export type PayrollPersonDto = z.infer<typeof payrollPersonSchema>;

const refSchema = z.object({ id: z.number().int(), name: z.string() }).nullable();

// ------------------------------------------------------------------ attendance (D94)

export const attendanceSchema = z.object({
  id: z.number().int(),
  user: payrollPersonSchema,
  workDate: z.string(),
  status: z.enum(ATTENDANCE_STATUSES),
  paidLeave: z.boolean(),
  /** Counts toward the leave deduction of a monthly salary. */
  deductible: z.boolean(),
  checkInAt: z.string().nullable(),
  checkOutAt: z.string().nullable(),
  workedMinutes: z.number().int().nullable(),
  /** The zone the work day was counted in. */
  timezone: z.string().nullable(),
  source: z.enum(ATTENDANCE_SOURCES),
  leaveRequestId: z.number().int().nullable(),
  note: z.string().nullable(),
});
export type AttendanceDto = z.infer<typeof attendanceSchema>;

export const attendanceTodaySchema = z.object({
  date: z.string(),
  timezone: z.string(),
  record: attendanceSchema.nullable(),
  /** Leave approved for today (check-in is refused). */
  onLeave: z.boolean(),
});
export type AttendanceTodayDto = z.infer<typeof attendanceTodaySchema>;

export const attendanceListQuerySchema = z.object({
  month: monthSchema.optional(),
  /** Staff with `attendance.manage` only; ignored for everyone else. */
  userId: queryId.optional(),
});
export type AttendanceListQuery = z.input<typeof attendanceListQuerySchema>;

export const attendanceSummaryRowSchema = z.object({
  user: payrollPersonSchema,
  present: z.number().int(),
  absent: z.number().int(),
  leave: z.number().int(),
  holiday: z.number().int(),
  deductibleDays: z.number().int(),
  workedMinutes: z.number().int(),
});

export const attendanceListSchema = z.object({
  data: z.array(attendanceSchema),
  meta: z.object({
    month: z.string(),
    summary: z.array(attendanceSummaryRowSchema),
    /** `own` without `attendance.manage`. */
    scope: z.enum(['all', 'own']),
  }),
});
export type AttendanceListDto = z.infer<typeof attendanceListSchema>;

export const markAttendanceSchema = z.object({
  status: z.enum(ATTENDANCE_STATUSES),
  /** Leave only: false = unpaid (deducted from a monthly salary). */
  paidLeave: z.boolean().optional(),
  note: z.string().trim().max(1000).nullish(),
  /** Why the day is set or corrected (audited). */
  reason: z.string().trim().min(3).max(1000),
});
export type MarkAttendanceInput = z.input<typeof markAttendanceSchema>;

// ------------------------------------------------------------------ leave requests

export const leaveRequestSchema = z.object({
  id: z.number().int(),
  user: payrollPersonSchema,
  startsOn: z.string(),
  endsOn: z.string(),
  days: z.number().int(),
  leaveType: z.enum(LEAVE_TYPES),
  reason: z.string(),
  status: z.enum(LEAVE_STATUSES),
  decidedBy: refSchema,
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  createdAt: z.string(),
  can: z.object({ decide: z.boolean(), cancel: z.boolean() }),
  /** On a single request: the person's scheduled classes inside the leave (B43, max 100). */
  affectedSessions: z
    .array(
      z.object({
        id: z.number().int(),
        startsAt: z.string(),
        durationMinutes: z.number().int(),
        stage: z.string(),
      }),
    )
    .optional(),
});
export type LeaveRequestDto = z.infer<typeof leaveRequestSchema>;

export const leaveListQuerySchema = z.object({
  status: z.enum(LEAVE_STATUSES).optional(),
  userId: queryId.optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});
export type LeaveListQuery = z.input<typeof leaveListQuerySchema>;
export const leaveListResponseSchema = paginatedSchema(leaveRequestSchema);

export const createLeaveSchema = z
  .object({
    /** Someone else (staff with `attendance.manage`); default = yourself. */
    userId: id.optional(),
    startsOn: dateOnlySchema,
    endsOn: dateOnlySchema,
    leaveType: z.enum(LEAVE_TYPES),
    reason: reasonText,
  })
  .superRefine((v, ctx) => {
    if (v.endsOn < v.startsOn) {
      ctx.addIssue({
        code: 'custom',
        path: ['endsOn'],
        message: 'The end date must be on or after the start date.',
      });
    }
  });
export type CreateLeaveInput = z.input<typeof createLeaveSchema>;

/**
 * Approve: the note is optional (docs/21). Blank = no note; a note, when given, has 3+ characters
 * (a clear message instead of a bare length error).
 */
export const approveDecisionSchema = z.object({
  note: z
    .string()
    .trim()
    .max(2000)
    .nullish()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || v.length >= 3, {
      message: 'Write at least 3 characters, or leave the note empty.',
    }),
});
/** Reject, cancel, reopen: a reason is required (D31). */
export const reasonDecisionSchema = z.object({ note: reasonText });

/**
 * A payroll run transition (recompute, review, approve, reopen). `expectedUpdatedAt` is the run's
 * `updatedAt` the client last saw: when the run changed since, the API answers 409 `stale_run`
 * (docs/21 §7) instead of acting on a run the person has not seen. Optional for old clients.
 */
export const runTransitionSchema = z.object({
  expectedUpdatedAt: z.iso.datetime({ offset: true }).optional(),
});
export const reopenRunSchema = reasonDecisionSchema.extend(runTransitionSchema.shape);
export type DecisionInput = z.input<typeof reasonDecisionSchema>;

// ------------------------------------------------------------------ pay adjustments (D91)

export const adjustmentSchema = z.object({
  id: z.number().int(),
  user: payrollPersonSchema,
  type: z.enum(ADJUSTMENT_TYPES),
  sign: z.union([z.literal(1), z.literal(-1)]),
  amount: z.string(),
  quantity: z.number().int().nullable(),
  currency: z.string(),
  effectiveOn: z.string(),
  reason: z.string(),
  status: z.enum(ADJUSTMENT_STATUSES),
  sessionId: z.number().int().nullable(),
  /** Already on an approved payslip. */
  locked: z.boolean(),
  reversesId: z.number().int().nullable(),
  createdBy: refSchema,
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  createdAt: z.string(),
  can: z.object({ decide: z.boolean(), cancel: z.boolean() }),
});
export type AdjustmentDto = z.infer<typeof adjustmentSchema>;

const typeList = z
  .union([z.enum(ADJUSTMENT_TYPES), z.array(z.enum(ADJUSTMENT_TYPES))])
  .transform((v) => (Array.isArray(v) ? v : [v]));

export const adjustmentListQuerySchema = z.object({
  type: typeList.optional(),
  status: z.enum(ADJUSTMENT_STATUSES).optional(),
  userId: queryId.optional(),
  month: monthSchema.optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});
export type AdjustmentListQuery = z.input<typeof adjustmentListQuerySchema>;
export const adjustmentListResponseSchema = paginatedSchema(adjustmentSchema);

export const createAdjustmentSchema = z
  .object({
    userId: id,
    type: z.enum(ADJUSTMENT_TYPES),
    /** Required except for `csr_conversions` (= quantity × the profile's CSR rate). */
    amount: positiveMoneySchema.optional(),
    /** `csr_conversions` only: how many families converted. */
    quantity: z.number().int().min(1).max(1000).optional(),
    effectiveOn: dateOnlySchema,
    reason: reasonText,
    sessionId: id.nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'csr_conversions') {
      if (v.quantity === undefined) {
        ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'The quantity is required.' });
      }
    } else if (v.amount === undefined) {
      ctx.addIssue({ code: 'custom', path: ['amount'], message: 'The amount is required.' });
    }
  });
export type CreateAdjustmentInput = z.input<typeof createAdjustmentSchema>;

export const cancelAdjustmentResultSchema = z.object({
  adjustment: adjustmentSchema,
  /** A fine locked in an approved month is waived with this fine reduction (201). */
  reduction: adjustmentSchema.nullable(),
});
export type CancelAdjustmentResultDto = z.infer<typeof cancelAdjustmentResultSchema>;

// ------------------------------------------------------------------ salary (pay) profiles (D89)

export const slotTierSchema = z.object({
  /** Paid hours from which the tier applies (hundredths allowed). */
  minSlots: z.number().min(0).max(1000),
  amount: rateInputSchema,
});
export type SlotTierInput = z.input<typeof slotTierSchema>;

export const payProfileSchema = z.object({
  id: z.number().int(),
  user: payrollPersonSchema,
  teacherId: z.number().int().nullable(),
  salaryType: z.enum(SALARY_TYPES),
  /** The profile's currency, else the payroll default (EGP). */
  currency: z.string(),
  monthlySalary: z.string(),
  classRate: z.string(),
  hourlyRate: z.string(),
  csrRate: z.string(),
  allowance: z.string(),
  tax: z.string(),
  slotTiers: z.array(z.object({ minSlots: z.number(), amount: z.string() })),
  active: z.boolean(),
  notes: z.string().nullable(),
  updatedAt: z.string(),
});
export type PayProfileDto = z.infer<typeof payProfileSchema>;

export const payProfileListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50),
});
export const payProfileListResponseSchema = paginatedSchema(payProfileSchema);

export const savePayProfileSchema = z
  .object({
    salaryType: z.enum(SALARY_TYPES),
    currency: currencySchema,
    monthlySalary: rateInputSchema.optional(),
    classRate: rateInputSchema.optional(),
    hourlyRate: rateInputSchema.optional(),
    csrRate: rateInputSchema.optional(),
    allowance: rateInputSchema.optional(),
    tax: rateInputSchema.optional(),
    slotTiers: z.array(slotTierSchema).max(20).optional(),
    active: z.boolean().optional(),
    notes: z.string().trim().max(500).nullish(),
    /** Why the profile changed (audited). */
    reason: z.string().trim().max(500).nullish(),
  })
  .superRefine((v, ctx) => {
    const need = (field: 'classRate' | 'hourlyRate' | 'slotTiers' | 'monthlySalary') =>
      ctx.addIssue({ code: 'custom', path: [field], message: `The ${field} field is required.` });
    if (v.salaryType === 'per_class' && v.classRate === undefined) need('classRate');
    if (v.salaryType === 'hourly' && v.hourlyRate === undefined) need('hourlyRate');
    if (v.salaryType === 'slot' && !v.slotTiers?.length) need('slotTiers');
    if (v.salaryType === 'monthly' && v.monthlySalary === undefined) need('monthlySalary');
  });
export type SavePayProfileInput = z.input<typeof savePayProfileSchema>;

/** The person picker for fines, adjustments and attendance (people with an active profile). */
export const payrollPeopleQuerySchema = z.object({ q: z.string().trim().max(100).optional() });
export const payrollPickerPersonSchema = payrollPersonSchema.extend({ currency: z.string() });
export type PayrollPickerPersonDto = z.infer<typeof payrollPickerPersonSchema>;

// ------------------------------------------------------------------ runs and payslips (D92)

export const payslipLineSchema = z.object({
  code: z.enum(PAYSLIP_LINE_CODES),
  sign: z.union([z.literal(1), z.literal(-1)]),
  quantity: z.string().nullable(),
  rate: z.string().nullable(),
  amount: z.string(),
  adjustment: z
    .object({ id: z.number().int(), reason: z.string(), effectiveOn: z.string() })
    .nullable(),
});
export type PayslipLineDto = z.infer<typeof payslipLineSchema>;

export const payslipIssueSchema = z
  .object({ code: z.string() })
  .catchall(z.union([z.string(), z.number(), z.null()]));
export type PayslipIssue = z.infer<typeof payslipIssueSchema>;

export const payslipSessionSchema = z.object({
  sessionId: z.number().int(),
  startsAt: z.string().nullable(),
  kind: z.enum(SESSION_KINDS),
  stage: z.enum(SESSION_STAGES),
  payHours: z.string(),
  payRuleKey: z.string().nullable(),
});

export const payslipSchema = z.object({
  id: z.number().int(),
  period: z.string(),
  runId: z.number().int(),
  runStatus: z.enum(RUN_STATUSES),
  user: payrollPersonSchema,
  teacherId: z.number().int().nullable(),
  currency: z.string(),
  salaryType: z.enum(SALARY_TYPES),
  /** The rates used (snapshot of the profile at compute time). */
  rates: z.record(z.string(), z.unknown()),
  paidHours: z.string(),
  paidClasses: z.number().int(),
  deductionDays: z.number().int(),
  earnings: z.string(),
  deductions: z.string(),
  net: z.string(),
  status: z.enum(PAYSLIP_STATUSES),
  /** Payroll staff only (empty for the payslip's owner). */
  warnings: z.array(payslipIssueSchema),
  errors: z.array(payslipIssueSchema),
  paidAt: z.string().nullable(),
  paidOn: z.string().nullable(),
  paymentMethod: z.enum(PAYOUT_METHODS).nullable(),
  paymentReference: z.string().nullable(),
  /** Detail only. */
  lines: z.array(payslipLineSchema).optional(),
  sessions: z.array(payslipSessionSchema).optional(),
});
export type PayslipDto = z.infer<typeof payslipSchema>;

export const runTotalsSchema = z.object({
  currency: z.string(),
  people: z.number().int(),
  earnings: z.string(),
  deductions: z.string(),
  net: z.string(),
  paid: z.string(),
});

export const payrollRunSchema = z.object({
  id: z.number().int(),
  period: z.string(),
  startsOn: z.string(),
  endsOn: z.string(),
  status: z.enum(RUN_STATUSES),
  computedAt: z.string().nullable(),
  createdBy: refSchema,
  reviewedBy: refSchema,
  reviewedAt: z.string().nullable(),
  approvedBy: refSchema,
  approvedAt: z.string().nullable(),
  paidAt: z.string().nullable(),
  /** Send back as `expectedUpdatedAt` on a transition (409 `stale_run` when it moved on). */
  updatedAt: z.string(),
  people: z.number().int(),
  paidPeople: z.number().int(),
  errorCount: z.number().int(),
  warningCount: z.number().int(),
  totals: z.array(runTotalsSchema),
  can: z.object({
    recompute: z.boolean(),
    review: z.boolean(),
    approve: z.boolean(),
    reopen: z.boolean(),
    pay: z.boolean(),
    adjust: z.boolean(),
  }),
});
export type PayrollRunDto = z.infer<typeof payrollRunSchema>;

export const payrollRunDetailSchema = payrollRunSchema.extend({
  payslips: z.array(payslipSchema),
});
export type PayrollRunDetailDto = z.infer<typeof payrollRunDetailSchema>;

export const runListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  perPage: z.coerce.number().int().min(1).max(60).default(24),
});
export const runListResponseSchema = paginatedSchema(payrollRunSchema);

export const createRunSchema = z.object({ period: monthSchema });
export type CreateRunInput = z.input<typeof createRunSchema>;

/** `GET /payroll/runs/preview?period=`: what a run would hold, computed now, nothing stored. */
export const runPreviewQuerySchema = z.object({
  period: monthSchema,
  userId: queryId.optional(),
});
export const runPreviewSchema = z.object({
  period: z.string(),
  computedAt: z.string(),
  payslips: z.array(payslipSchema.omit({ id: true, runId: true, runStatus: true })),
  totals: z.array(runTotalsSchema),
});
export type RunPreviewDto = z.infer<typeof runPreviewSchema>;

export const recordPaymentSchema = z
  .object({
    method: z.enum(PAYOUT_METHODS),
    /** Transfer / wallet reference; required except for cash. */
    reference: z.string().trim().max(120).nullish(),
    paidOn: dateOnlySchema,
  })
  .superRefine((v, ctx) => {
    if (v.method !== 'cash' && !v.reference) {
      ctx.addIssue({ code: 'custom', path: ['reference'], message: 'The reference is required.' });
    }
  });
export type RecordPaymentInput = z.input<typeof recordPaymentSchema>;

// ------------------------------------------------------------------ wallet (D93)

export const walletTxSchema = z.object({
  id: z.number().int(),
  type: z.enum(WALLET_TX_TYPES),
  currency: z.string(),
  amount: z.string(),
  payslipId: z.number().int().nullable(),
  period: z.string().nullable(),
  reference: z.string().nullable(),
  occurredAt: z.string(),
});
export const walletBalanceSchema = z.object({ currency: z.string(), balance: z.string() });
export const myWalletSchema = z.object({
  balances: z.array(walletBalanceSchema),
  transactions: z.array(walletTxSchema),
});
export type MyWalletDto = z.infer<typeof myWalletSchema>;
export const walletRowSchema = z.object({
  user: payrollPersonSchema,
  currency: z.string(),
  balance: z.string(),
  lastAt: z.string().nullable(),
});
export type WalletRowDto = z.infer<typeof walletRowSchema>;
