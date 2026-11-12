import type {
  AddInvoiceLineInput,
  CreateFeePackageInput,
  CreateInvoiceInput,
  Currency,
  ManualPaymentInput,
  ManualPaymentMethod,
  SplitInvoiceInput,
  UpdateFamilyBillingInput,
} from '@qarabic/shared';
import { MAX_AMOUNT_MINOR } from '@qarabic/shared';
import { isDateKey } from '@/lib/schedule-time';
import { parseAmount, toAmount } from './money';

/**
 * Form rules of the billing dialogs (docs/20 §4, §7.4), as pure functions so they are unit tested
 * and the components stay thin. Each returns message keys under `billing.form` per field (the
 * component translates them) and, when valid, the request body in the API's shape: amounts as
 * decimal strings built from integer minor units, never floats. The API checks everything again.
 */
export type FormErrors<K extends string> = Partial<Record<K, string>>;
type Result<K extends string, B> = { errors: FormErrors<K>; body: B | null };

const REASON_MIN = 3;

function amountError(minor: number | null): string | null {
  if (minor === null) return 'amountInvalid';
  if (Math.abs(minor) > MAX_AMOUNT_MINOR) return 'amountMax';
  return null;
}

const done = <K extends string, B>(errors: FormErrors<K>, body: () => B): Result<K, B> =>
  Object.keys(errors).length ? { errors, body: null } : { errors, body: body() };

// ------------------------------------------------------------------ manual payment

export type PaymentForm = {
  method: ManualPaymentMethod;
  amount: string;
  receivedOn: string;
  reference: string;
  note: string;
};

/** Amount > 0 and ≤ the balance, date received not after today (academy), reference optional. */
export function validatePayment(
  v: PaymentForm,
  { balanceMinor, today }: { balanceMinor: number; today: string },
): Result<'amount' | 'receivedOn', ManualPaymentInput> & { overBalance: boolean } {
  const errors: FormErrors<'amount' | 'receivedOn'> = {};
  const minor = parseAmount(v.amount);
  const bad = amountError(minor);
  const overBalance = !bad && minor! > balanceMinor;
  if (bad) errors.amount = bad;
  else if (overBalance) errors.amount = 'overBalance';
  if (!isDateKey(v.receivedOn) || v.receivedOn > today) errors.receivedOn = 'dateNotFuture';
  return {
    overBalance,
    ...done(errors, () => ({
      method: v.method,
      amount: toAmount(minor!),
      receivedOn: v.receivedOn,
      reference: v.reference.trim() || null,
      note: v.note.trim() || null,
    })),
  };
}

// ------------------------------------------------------------------ adjustment / discount

export type LineForm = {
  /** Discount only: an amount or a percent of the current total. */
  mode: 'amount' | 'percent';
  /** Adjustment only: a charge (+) or a credit (−). */
  sign: 'add' | 'subtract';
  value: string;
  reason: string;
};

export function validateLine(
  kind: 'adjustment' | 'discount',
  v: LineForm,
): Result<'value' | 'reason', AddInvoiceLineInput> {
  const errors: FormErrors<'value' | 'reason'> = {};
  const percent = kind === 'discount' && v.mode === 'percent';
  const minor = parseAmount(v.value);
  if (percent) {
    if (minor === null || minor > 10_000) errors.value = 'percentInvalid';
  } else {
    const bad = amountError(minor);
    if (bad) errors.value = bad;
  }
  if (v.reason.trim().length < REASON_MIN) errors.reason = 'reasonRequired';
  return done(errors, () => {
    const reason = v.reason.trim();
    if (percent) return { type: 'discount', percent: toAmount(minor!), reason };
    if (kind === 'discount') return { type: 'discount', amount: toAmount(minor!), reason };
    return {
      type: 'adjustment',
      amount: toAmount(v.sign === 'subtract' ? -minor! : minor!),
      reason,
    };
  });
}

// ------------------------------------------------------------------ split

export type SplitPart = { amount: string; dueDate: string };

/** 2–6 parts, each > 0 with a due date from today, adding up to the invoice total exactly. */
export function validateSplit(
  parts: SplitPart[],
  reason: string,
  { totalMinor, today }: { totalMinor: number; today: string },
): Result<'parts' | 'reason', SplitInvoiceInput> & {
  sumMinor: number;
  partErrors: { amount?: string; dueDate?: string }[];
} {
  const errors: FormErrors<'parts' | 'reason'> = {};
  const minors = parts.map((p) => parseAmount(p.amount));
  const partErrors = parts.map((p, i) => ({
    ...(amountError(minors[i] ?? null) ? { amount: 'amountInvalid' } : {}),
    ...(!isDateKey(p.dueDate) || p.dueDate < today ? { dueDate: 'dateFromToday' } : {}),
  }));
  const sumMinor = minors.reduce<number>((s, m) => s + (m ?? 0), 0);
  if (parts.length < 2 || parts.length > 6) errors.parts = 'splitCount';
  else if (partErrors.some((e) => Object.keys(e).length)) errors.parts = 'splitParts';
  else if (sumMinor !== totalMinor) errors.parts = 'splitSum';
  if (reason.trim().length < REASON_MIN) errors.reason = 'reasonRequired';
  return {
    sumMinor,
    partErrors,
    ...done(errors, () => ({
      reason: reason.trim(),
      parts: parts.map((p, i) => ({ amount: toAmount(minors[i]!), dueDate: p.dueDate })),
    })),
  };
}

// ------------------------------------------------------------------ manual invoice

export type ManualInvoiceForm = { description: string; amount: string; dueDate: string };

export function validateManualInvoice(
  familyId: number,
  v: ManualInvoiceForm,
  { today, issue }: { today: string; issue: boolean },
): Result<'description' | 'amount' | 'dueDate', CreateInvoiceInput> {
  const errors: FormErrors<'description' | 'amount' | 'dueDate'> = {};
  if (!v.description.trim()) errors.description = 'required';
  const minor = parseAmount(v.amount);
  const bad = amountError(minor);
  if (bad) errors.amount = bad;
  if (!isDateKey(v.dueDate) || v.dueDate < today) errors.dueDate = 'dateFromToday';
  return done(errors, () => ({
    familyId,
    dueDate: v.dueDate,
    issue,
    lines: [{ description: v.description.trim(), amount: toAmount(minor!) }],
  }));
}

// ------------------------------------------------------------------ fee package

export type PackageForm = {
  name: string;
  classesPerWeek: string;
  sessionMinutes: number;
  description: string;
  isActive: boolean;
  prices: { currency: Currency; amount: string }[];
};

export function validatePackage(v: PackageForm): Result<
  'name' | 'classesPerWeek' | 'prices',
  CreateFeePackageInput
> & {
  priceErrors: (string | undefined)[];
} {
  const errors: FormErrors<'name' | 'classesPerWeek' | 'prices'> = {};
  if (!v.name.trim()) errors.name = 'required';
  else if (v.name.trim().length > 120) errors.name = 'tooLong';
  const perWeek = Number(v.classesPerWeek);
  if (!/^\d{1,2}$/.test(v.classesPerWeek.trim()) || perWeek < 1 || perWeek > 14) {
    errors.classesPerWeek = 'perWeekInvalid';
  }
  const priceErrors = v.prices.map((p) => amountError(parseAmount(p.amount)) ?? undefined);
  if (!v.prices.length) errors.prices = 'pricesRequired';
  else if (new Set(v.prices.map((p) => p.currency)).size !== v.prices.length) {
    errors.prices = 'duplicateCurrency';
  } else if (priceErrors.some(Boolean)) errors.prices = 'amountInvalid';
  return {
    priceErrors,
    ...done(errors, () => ({
      name: v.name.trim(),
      classesPerWeek: perWeek,
      sessionMinutes: v.sessionMinutes,
      description: v.description.trim() || null,
      isActive: v.isActive,
      prices: v.prices.map((p) => ({
        currency: p.currency,
        monthlyAmount: toAmount(parseAmount(p.amount)!),
      })),
    })),
  };
}

// ------------------------------------------------------------------ family billing profile

export type FamilyBillingForm = {
  currency: Currency | '';
  billingDay: 1 | 15;
  enabled: boolean;
  customFee: string;
  startsOn: string;
  students: { id: number; feePackageId: number | null }[];
};

export function validateFamilyBilling(
  v: FamilyBillingForm,
): Result<'currency' | 'customFee' | 'startsOn', UpdateFamilyBillingInput> {
  const errors: FormErrors<'currency' | 'customFee' | 'startsOn'> = {};
  if (!v.currency) errors.currency = 'required';
  const fee = v.customFee.trim();
  // A fixed fee of 0 is allowed (a free family); an empty field means "sum the packages".
  const feeMinor = fee === '' ? null : /^0+([.٫]0{1,2})?$/.test(fee) ? 0 : parseAmount(fee);
  if (fee !== '' && feeMinor === null) errors.customFee = 'amountInvalid';
  else if (feeMinor !== null && feeMinor > MAX_AMOUNT_MINOR) errors.customFee = 'amountMax';
  if (v.startsOn && !isDateKey(v.startsOn)) errors.startsOn = 'dateInvalid';
  return done(errors, () => ({
    billingCurrency: v.currency as Currency,
    billingDay: v.billingDay,
    billingEnabled: v.enabled,
    customFee: feeMinor === null ? null : toAmount(feeMinor),
    billingStartsOn: v.startsOn || null,
    students: v.students,
  }));
}
