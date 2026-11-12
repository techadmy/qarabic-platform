import type {
  AdjustmentType,
  AttendanceStatus,
  CreateAdjustmentInput,
  CreateLeaveInput,
  CreatePayRuleSetInput,
  LeaveType,
  MarkAttendanceInput,
  PayoutMethod,
  PayRule,
  RecordPaymentInput,
  SalaryType,
  SavePayProfileInput,
} from '@qarabic/shared';
import { MAX_AMOUNT_MINOR, PAY_RULE_KEY } from '@qarabic/shared';
import { parseAmount, toAmount } from '@/lib/billing/money';
import { isDateKey } from '@/lib/schedule-time';

/**
 * Form rules of the payroll dialogs (docs/21 §5–§7), pure so they are unit tested and the
 * components stay thin. Each returns message keys under `payroll.form` per field and, when valid,
 * the request body in the API's shape: amounts as decimal strings from integer minor units, never
 * floats. The API checks everything again (it is the real check).
 */
export type FormErrors<K extends string> = Partial<Record<K, string>>;
type Result<K extends string, B> = { errors: FormErrors<K>; body: B | null };

export const REASON_MIN = 3;

const done = <K extends string, B>(errors: FormErrors<K>, body: () => B): Result<K, B> =>
  Object.keys(errors).length ? { errors, body: null } : { errors, body: body() };

const reasonError = (text: string) => (text.trim().length < REASON_MIN ? 'reasonRequired' : null);

/** A positive amount (> 0, ≤ the API's limit) → minor units, or the error key. */
function positiveAmount(input: string): { minor: number } | { error: string } {
  const minor = parseAmount(input);
  if (minor === null) return { error: 'amountInvalid' };
  if (minor > MAX_AMOUNT_MINOR) return { error: 'amountMax' };
  return { minor };
}

/** A rate or salary: empty → 0, else ≥ 0 with at most 2 decimals. */
function rateAmount(input: string): { value: string } | { error: string } {
  if (!input.trim()) return { value: '0.00' };
  if (/^\s*0+([.٫]0{1,2})?\s*$/.test(input)) return { value: '0.00' };
  const r = positiveAmount(input);
  return 'error' in r ? r : { value: toAmount(r.minor) };
}

// ------------------------------------------------------------------ leave request

export type LeaveForm = {
  userId: number | null;
  startsOn: string;
  endsOn: string;
  leaveType: LeaveType;
  reason: string;
};

/** Dates in order, a reason of 3+ characters; `userId` only when staff request for someone. */
export function validateLeave(
  v: LeaveForm,
  { maxDays = 31 }: { maxDays?: number } = {},
): Result<'startsOn' | 'endsOn' | 'reason', CreateLeaveInput> {
  const errors: FormErrors<'startsOn' | 'endsOn' | 'reason'> = {};
  if (!isDateKey(v.startsOn)) errors.startsOn = 'dateInvalid';
  if (!isDateKey(v.endsOn)) errors.endsOn = 'dateInvalid';
  else if (isDateKey(v.startsOn) && v.endsOn < v.startsOn) errors.endsOn = 'endBeforeStart';
  else if (isDateKey(v.startsOn) && leaveDays(v.startsOn, v.endsOn) > maxDays) {
    errors.endsOn = 'tooManyDays';
  }
  const reason = reasonError(v.reason);
  if (reason) errors.reason = reason;
  return done(errors, () => ({
    ...(v.userId ? { userId: v.userId } : {}),
    startsOn: v.startsOn,
    endsOn: v.endsOn,
    leaveType: v.leaveType,
    reason: v.reason.trim(),
  }));
}

/** Calendar days from `from` to `to`, both included (`2026-11-03`…`2026-11-05` → 3). */
export function leaveDays(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) + 1 : 0;
}

// ------------------------------------------------------------------ mark a day

export type MarkForm = {
  status: AttendanceStatus;
  paidLeave: boolean;
  note: string;
  reason: string;
};

export function validateMark(v: MarkForm): Result<'reason', MarkAttendanceInput> {
  const errors: FormErrors<'reason'> = {};
  const reason = reasonError(v.reason);
  if (reason) errors.reason = reason;
  return done(errors, () => ({
    status: v.status,
    ...(v.status === 'leave' ? { paidLeave: v.paidLeave } : {}),
    note: v.note.trim() || null,
    reason: v.reason.trim(),
  }));
}

// ------------------------------------------------------------------ fine / pay adjustment

export type AdjustmentForm = {
  userId: number | null;
  type: AdjustmentType;
  amount: string;
  quantity: string;
  effectiveOn: string;
  sessionId: string;
  reason: string;
};

type AdjustmentField = 'userId' | 'amount' | 'quantity' | 'effectiveOn' | 'sessionId' | 'reason';

/** Person, amount (or the count for CSR conversions), a date, an optional class, a reason. */
export function validateAdjustment(
  v: AdjustmentForm,
): Result<AdjustmentField, CreateAdjustmentInput> {
  const errors: FormErrors<AdjustmentField> = {};
  if (!v.userId) errors.userId = 'personRequired';
  let amount: string | undefined;
  let quantity: number | undefined;
  if (v.type === 'csr_conversions') {
    const n = Number(v.quantity.trim());
    if (!/^\d{1,4}$/.test(v.quantity.trim()) || n < 1 || n > 1000)
      errors.quantity = 'quantityInvalid';
    else quantity = n;
  } else {
    const r = positiveAmount(v.amount);
    if ('error' in r) errors.amount = r.error;
    else amount = toAmount(r.minor);
  }
  if (!isDateKey(v.effectiveOn)) errors.effectiveOn = 'dateInvalid';
  let sessionId: number | null = null;
  if (v.sessionId.trim()) {
    const n = Number(v.sessionId.trim());
    if (!Number.isInteger(n) || n < 1 || n > 2_147_483_647) errors.sessionId = 'classInvalid';
    else sessionId = n;
  }
  const reason = reasonError(v.reason);
  if (reason) errors.reason = reason;
  return done(errors, () => ({
    userId: v.userId!,
    type: v.type,
    ...(amount !== undefined ? { amount } : {}),
    ...(quantity !== undefined ? { quantity } : {}),
    effectiveOn: v.effectiveOn,
    reason: v.reason.trim(),
    sessionId,
  }));
}

/** Which adjustment types this viewer may add (docs/21 §6: the type decides who). */
export function creatableTypes(permissions: readonly string[]): AdjustmentType[] {
  const fines =
    permissions.includes('fines.request') ||
    permissions.includes('fines.manage') ||
    permissions.includes('fines.approve');
  const payroll = permissions.includes('payroll.manage');
  const out: AdjustmentType[] = [];
  if (fines || payroll) out.push('fine');
  if (payroll) {
    out.push(
      'bonus',
      'advance',
      'arrears',
      'gift',
      'other_addition',
      'other_deduction',
      'csr_conversions',
    );
  }
  if (permissions.includes('fines.manage') || payroll) out.push('fine_reduction');
  return out;
}

/** A fine from someone without `fines.manage`/`fines.approve` waits for approval. */
export function finesNeedApproval(permissions: readonly string[]): boolean {
  return !permissions.includes('fines.manage') && !permissions.includes('fines.approve');
}

// ------------------------------------------------------------------ record a payment

export type PaymentForm = { method: PayoutMethod; reference: string; paidOn: string };

/** Method, date not after today; the reference is required except for cash (D93). */
export function validatePayment(
  v: PaymentForm,
  { today }: { today: string },
): Result<'reference' | 'paidOn', RecordPaymentInput> {
  const errors: FormErrors<'reference' | 'paidOn'> = {};
  if (v.method !== 'cash' && !v.reference.trim()) errors.reference = 'referenceRequired';
  else if (v.reference.trim().length > 120) errors.reference = 'tooLong';
  if (!isDateKey(v.paidOn) || v.paidOn > today) errors.paidOn = 'dateNotFuture';
  return done(errors, () => ({
    method: v.method,
    reference: v.reference.trim() || null,
    paidOn: v.paidOn,
  }));
}

// ------------------------------------------------------------------ salary profile

export type ProfileForm = {
  salaryType: SalaryType;
  currency: string;
  monthlySalary: string;
  classRate: string;
  hourlyRate: string;
  csrRate: string;
  allowance: string;
  tax: string;
  slotTiers: { minSlots: string; amount: string }[];
  active: boolean;
  notes: string;
  reason: string;
};

type ProfileField =
  | 'currency'
  | 'monthlySalary'
  | 'classRate'
  | 'hourlyRate'
  | 'csrRate'
  | 'allowance'
  | 'tax'
  | 'slotTiers'
  | 'notes';

const MONEY_FIELDS = [
  'monthlySalary',
  'classRate',
  'hourlyRate',
  'csrRate',
  'allowance',
  'tax',
] as const;

/** The rate the salary type needs is required and above 0; the rest default to 0. */
export function validateProfile(v: ProfileForm): Result<ProfileField, SavePayProfileInput> {
  const errors: FormErrors<ProfileField> = {};
  if (!/^[A-Z]{3}$/.test(v.currency.trim().toUpperCase())) errors.currency = 'currencyInvalid';
  const values: Partial<Record<(typeof MONEY_FIELDS)[number], string>> = {};
  for (const field of MONEY_FIELDS) {
    const r = rateAmount(v[field]);
    if ('error' in r) errors[field] = r.error;
    else values[field] = r.value;
  }
  const needed =
    v.salaryType === 'monthly'
      ? 'monthlySalary'
      : v.salaryType === 'per_class'
        ? 'classRate'
        : v.salaryType === 'hourly'
          ? 'hourlyRate'
          : null;
  if (needed && !errors[needed] && values[needed] === '0.00') errors[needed] = 'rateRequired';
  const tiers: { minSlots: number; amount: string }[] = [];
  if (v.salaryType === 'slot') {
    for (const tier of v.slotTiers) {
      const min = Number(tier.minSlots.trim());
      const amount = parseAmount(tier.amount);
      if (!/^\d{1,4}(\.\d{1,2})?$/.test(tier.minSlots.trim()) || min > 1000 || amount === null) {
        errors.slotTiers = 'tiersInvalid';
        break;
      }
      tiers.push({ minSlots: min, amount: toAmount(amount) });
    }
    if (!tiers.length && !errors.slotTiers) errors.slotTiers = 'tiersRequired';
  }
  if (v.notes.length > 500) errors.notes = 'tooLong';
  return done(errors, () => ({
    salaryType: v.salaryType,
    currency: v.currency.trim().toUpperCase(),
    ...(values as Record<(typeof MONEY_FIELDS)[number], string>),
    slotTiers: v.salaryType === 'slot' ? tiers.sort((a, b) => a.minSlots - b.minSlots) : [],
    active: v.active,
    notes: v.notes.trim() || null,
    reason: v.reason.trim() || null,
  }));
}

// ------------------------------------------------------------------ pay rule set

export type RuleRow = { key: string; factor: string; billable: boolean; paidHolidayOnly: boolean };

/** Keys in the engine's syntax, unique, factors 0–5 (two decimals); starts today or later. */
export function validateRuleSet(
  v: { effectiveOn: string; rows: RuleRow[]; note: string },
  { today, zoneOffset }: { today: string; zoneOffset: string },
): Result<'effectiveOn' | 'rows' | 'note', CreatePayRuleSetInput> {
  const errors: FormErrors<'effectiveOn' | 'rows' | 'note'> = {};
  if (!isDateKey(v.effectiveOn) || v.effectiveOn < today) errors.effectiveOn = 'dateFromToday';
  const rules: Record<string, PayRule> = {};
  for (const row of v.rows) {
    const key = row.key.trim();
    const factor = Number(row.factor.trim());
    if (
      !PAY_RULE_KEY.test(key) ||
      key in rules ||
      !/^\d(\.\d{1,2})?$/.test(row.factor.trim()) ||
      factor > 5
    ) {
      errors.rows = 'rulesInvalid';
      break;
    }
    rules[key] = {
      factor,
      billable: row.billable,
      ...(row.paidHolidayOnly ? { paidHolidayOnly: true } : {}),
    };
  }
  if (!errors.rows && !Object.keys(rules).length) errors.rows = 'rulesRequired';
  if (v.note.length > 255) errors.note = 'tooLong';
  return done(errors, () => ({
    effectiveFrom: `${v.effectiveOn}T00:00:00${zoneOffset}`,
    rules,
    note: v.note.trim() || null,
  }));
}
