import { z } from 'zod';
import { dateOnlySchema, paginatedSchema } from './people.js';

/**
 * Billing (N6; Laravel M5, docs/20, D83–D88, D140): fee packages, the family billing profile,
 * invoices (monthly run, manual, split), payments (manual, Stripe Checkout, PayPal Orders v2 in
 * test / sandbox mode only), reminders and the `billing_events` outbox for the accounting ledger.
 *
 * Money (D83): an exact decimal string with 2 places (`"60.00"`, `"-5.00"`) + an ISO 4217
 * currency. Never a float: the helpers below work on integer minor units (cents) only. The API
 * stores `numeric(12,2)`. Row scope (D87): staff with `invoices.view` see every family; a parent
 * only their own family's issued invoices (anything else 404); teachers have no billing access.
 */

type Labels<T extends string> = Record<T, { ar: string; en: string }>;

const id = z.number().int().positive();
const queryId = z.coerce.number().int().positive().max(2_147_483_647);
const queryBool = z
  .union([z.boolean(), z.enum(['1', '0', 'true', 'false'])])
  .transform((v) => v === true || v === '1' || v === 'true');

// ------------------------------------------------------------------ money (integer minor units)

/** Currencies a family can be billed in (Laravel `config/billing.php`); all have 2 decimals. */
export const CURRENCIES = ['USD', 'GBP', 'EUR', 'CAD', 'AUD', 'AED', 'PKR', 'EGP', 'SAR'] as const;
export type Currency = (typeof CURRENCIES)[number];
export const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.enum(CURRENCIES, { message: 'Use one of the billing currencies.' }));
export const CURRENCY_LABELS: Labels<Currency> = {
  USD: { ar: 'دولار أمريكي', en: 'US dollar' },
  GBP: { ar: 'جنيه إسترليني', en: 'Pound sterling' },
  EUR: { ar: 'يورو', en: 'Euro' },
  CAD: { ar: 'دولار كندي', en: 'Canadian dollar' },
  AUD: { ar: 'دولار أسترالي', en: 'Australian dollar' },
  AED: { ar: 'درهم إماراتي', en: 'UAE dirham' },
  PKR: { ar: 'روبية باكستانية', en: 'Pakistani rupee' },
  EGP: { ar: 'جنيه مصري', en: 'Egyptian pound' },
  SAR: { ar: 'ريال سعودي', en: 'Saudi riyal' },
};

/** Largest amount on one line, package price or payment (Laravel `max:100000000` minor units). */
export const MAX_AMOUNT_MINOR = 100_000_000;

const DECIMAL = /^(-?)(\d{1,13})(?:\.(\d{1,2}))?$/;

/** `"60.00"` → 6000, `"-0.05"` → -5, `"12"` → 1200, `"0.1"` → 10. Throws on anything else. */
export function toMinor(value: string): number {
  const m = DECIMAL.exec(value.trim());
  if (!m) throw new RangeError(`Bad amount ${value}`);
  const minor = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] === '-' && minor !== 0 ? -minor : minor;
}

/** 6000 → `"60.00"`, -5 → `"-0.05"`. */
export function fromMinor(minor: number): string {
  if (!Number.isSafeInteger(minor)) throw new RangeError(`Bad minor amount ${minor}`);
  const abs = Math.abs(minor);
  return `${minor < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Half up, away from zero: `n / d` rounded to the nearest integer (d > 0). */
function divRound(n: bigint, d: bigint): bigint {
  const sign = n < 0n ? -1n : 1n;
  const abs = n < 0n ? -n : n;
  return (sign * (abs * 2n + d)) / (d * 2n);
}

/** `amount × numerator / denominator`, rounded half up (D85: the first month by days). */
export function prorate(amountMinor: number, numerator: number, denominator: number): number {
  if (denominator <= 0 || numerator >= denominator) return amountMinor;
  if (numerator <= 0) return 0;
  return Number(divRound(BigInt(amountMinor) * BigInt(numerator), BigInt(denominator)));
}

/** `percent` % of an amount (percent with at most 2 decimals, as a string), rounded half up. */
export function percentOf(amountMinor: number, percent: string): number {
  const basisPoints = BigInt(toMinor(percent));
  return Number(divRound(BigInt(amountMinor) * basisPoints, 10_000n));
}

/** `"60.00 USD"` (plain text: mails, the printable invoice). */
export const formatMoney = (amount: string, currency: string) => `${amount} ${currency}`;

const amountText = z
  .union([z.number(), z.string().trim()])
  .transform((v) => String(v))
  .pipe(z.string().regex(DECIMAL, { message: 'Use an amount with at most 2 decimals.' }))
  .transform((v) => toMinor(v));

/** A positive amount (0.01 … 1,000,000.00), normalised to `"60.00"`. */
export const amountSchema = amountText
  .refine((m) => m > 0, { message: 'The amount must be greater than zero.' })
  .refine((m) => m <= MAX_AMOUNT_MINOR, { message: 'The amount may not be greater than 1000000.' })
  .transform(fromMinor);

/** A non-zero signed amount (adjustments: + charge, − credit). */
export const signedAmountSchema = amountText
  .refine((m) => m !== 0, { message: 'The amount cannot be zero.' })
  .refine((m) => Math.abs(m) <= MAX_AMOUNT_MINOR, {
    message: 'The amount may not be greater than 1000000.',
  })
  .transform(fromMinor);

/** A discount percent: more than 0, at most 100, 2 decimals (`"10.00"`). */
export const percentSchema = z
  .union([z.number(), z.string().trim()])
  .transform((v) => String(v))
  .pipe(
    z
      .string()
      .regex(/^\d{1,3}(\.\d{1,2})?$/, { message: 'Use a percent with at most 2 decimals.' }),
  )
  .transform((v) => toMinor(v))
  .refine((bp) => bp > 0 && bp <= 10_000, { message: 'Use a percent above 0 and up to 100.' })
  .transform(fromMinor);

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM.');
const reasonSchema = z.string().trim().min(3).max(500);

// ------------------------------------------------------------------ catalog

/** Invoice lifecycle (D83). "Overdue" is not stored: open and past its due date (academy zone). */
export const INVOICE_STATUSES = [
  'draft',
  'issued',
  'partially_paid',
  'paid',
  'void',
  'split',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
/** Statuses that still expect money. */
export const OPEN_INVOICE_STATUSES = [
  'issued',
  'partially_paid',
] as const satisfies readonly InvoiceStatus[];
export const isOpenInvoice = (s: InvoiceStatus) => s === 'issued' || s === 'partially_paid';
/** Lines can still change (adjust, discount). */
export const isEditableInvoice = (s: InvoiceStatus) => s === 'draft' || isOpenInvoice(s);
export const INVOICE_STATUS_LABELS: Labels<InvoiceStatus> = {
  draft: { ar: 'مسودة', en: 'Draft' },
  issued: { ar: 'مستحقة', en: 'Issued' },
  partially_paid: { ar: 'مدفوعة جزئيًّا', en: 'Partially paid' },
  paid: { ar: 'مدفوعة', en: 'Paid' },
  void: { ar: 'ملغاة', en: 'Void' },
  split: { ar: 'مقسّمة', en: 'Split' },
};
/** List tabs: the statuses plus `open` (issued + partially paid) and `overdue`. */
export const INVOICE_TABS = [...INVOICE_STATUSES, 'open', 'overdue'] as const;
export type InvoiceTab = (typeof INVOICE_TABS)[number];
export const INVOICE_TAB_LABELS: Labels<'open' | 'overdue'> = {
  open: { ar: 'غير مسددة', en: 'Open' },
  overdue: { ar: 'متأخرة', en: 'Overdue' },
};

export const INVOICE_KINDS = ['monthly', 'manual', 'split'] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];
export const INVOICE_KIND_LABELS: Labels<InvoiceKind> = {
  monthly: { ar: 'شهرية', en: 'Monthly' },
  manual: { ar: 'يدوية', en: 'Manual' },
  split: { ar: 'جزء من فاتورة مقسّمة', en: 'Instalment' },
};

export const INVOICE_LINE_TYPES = ['package', 'manual', 'adjustment', 'discount', 'split'] as const;
export type InvoiceLineType = (typeof INVOICE_LINE_TYPES)[number];
export const INVOICE_LINE_TYPE_LABELS: Labels<InvoiceLineType> = {
  package: { ar: 'رسوم الباقة', en: 'Package fee' },
  manual: { ar: 'بند يدوي', en: 'Manual item' },
  adjustment: { ar: 'تسوية', en: 'Adjustment' },
  discount: { ar: 'خصم', en: 'Discount' },
  split: { ar: 'قسط', en: 'Instalment' },
};

export const ONLINE_PAYMENT_METHODS = ['stripe', 'paypal'] as const;
export type OnlinePaymentMethod = (typeof ONLINE_PAYMENT_METHODS)[number];
/** Methods billing staff record by hand. */
export const MANUAL_PAYMENT_METHODS = ['cash', 'bank_transfer', 'cheque', 'other'] as const;
export type ManualPaymentMethod = (typeof MANUAL_PAYMENT_METHODS)[number];
/** P1-1 (B115): a family credit used on an invoice; created by the system only. */
export const PAYMENT_METHODS = [
  ...ONLINE_PAYMENT_METHODS,
  ...MANUAL_PAYMENT_METHODS,
  'credit',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const isOnlineMethod = (m: PaymentMethod) => m === 'stripe' || m === 'paypal';
export const PAYMENT_METHOD_LABELS: Labels<PaymentMethod> = {
  stripe: { ar: 'بطاقة (Stripe)', en: 'Card (Stripe)' },
  paypal: { ar: 'PayPal', en: 'PayPal' },
  cash: { ar: 'نقدًا', en: 'Cash' },
  bank_transfer: { ar: 'تحويل بنكي', en: 'Bank transfer' },
  cheque: { ar: 'شيك', en: 'Cheque' },
  other: { ar: 'أخرى', en: 'Other' },
  credit: { ar: 'من رصيد الأسرة الدائن', en: 'Family credit' },
};

export const PAYMENT_STATUSES = [
  'pending',
  'succeeded',
  'failed',
  'cancelled',
  'refunded',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const PAYMENT_STATUS_LABELS: Labels<PaymentStatus> = {
  pending: { ar: 'قيد التنفيذ', en: 'Pending' },
  succeeded: { ar: 'ناجحة', en: 'Succeeded' },
  failed: { ar: 'فاشلة', en: 'Failed' },
  cancelled: { ar: 'ملغاة', en: 'Cancelled' },
  refunded: { ar: 'مستردة', en: 'Refunded' },
};

/** Billing day of a family (old `payment_cycle`): the 1st or the 15th. */
export const BILLING_DAYS = [1, 15] as const;
export type BillingDay = (typeof BILLING_DAYS)[number];

export const SESSION_MINUTES_OPTIONS = [30, 45, 60, 90] as const;

/**
 * Why a family gets no (or a partial) invoice. `no_package:<studentId>` and
 * `missing_price:<studentId>` carry the child; the others are plain codes.
 */
export const BILLING_WARNINGS = [
  'missing_currency',
  'no_package',
  'missing_price',
  'not_started',
  'no_fee',
] as const;
export type BillingWarning = (typeof BILLING_WARNINGS)[number];
export const BILLING_WARNING_LABELS: Labels<BillingWarning> = {
  missing_currency: { ar: 'لم تُحدَّد عملة الفوترة', en: 'No billing currency' },
  no_package: { ar: 'طالب بلا باقة', en: 'A child has no package' },
  missing_price: {
    ar: 'باقة بلا سعر بعملة الأسرة',
    en: 'A package has no price in the family currency',
  },
  not_started: { ar: 'لم تبدأ الفوترة بعد', en: 'Billing has not started yet' },
  no_fee: { ar: 'لا رسوم', en: 'No fee' },
};
/** `missing_price:12` → `missing_price`. */
export const warningCode = (w: string) => w.split(':')[0] as BillingWarning;

/** Business refusals of the billing routes (Laravel `lang/{en,ar}/billing.php`). */
export const BILLING_ERROR_MESSAGES = {
  missing_currency: {
    en: "Set the family's billing currency first.",
    ar: 'حدّد عملة الفوترة للأسرة أولًا.',
  },
  not_draft: {
    en: 'Only a draft invoice can be issued.',
    ar: 'لا يمكن إصدار إلا الفاتورة المسودة.',
  },
  empty_invoice: {
    en: 'An invoice needs at least one line.',
    ar: 'يجب أن تحتوي الفاتورة على بند واحد على الأقل.',
  },
  not_editable: {
    en: 'This invoice can no longer be changed.',
    ar: 'لم يعد بالإمكان تعديل هذه الفاتورة.',
  },
  zero_amount: { en: 'The amount cannot be zero.', ar: 'لا يمكن أن يكون المبلغ صفرًا.' },
  below_paid: {
    en: 'The total cannot go below zero or below what is already paid.',
    ar: 'لا يمكن أن يقل الإجمالي عن الصفر أو عن المبلغ المدفوع.',
  },
  has_payments: {
    en: 'An invoice with a payment cannot be voided. Void or refund the payment first.',
    ar: 'لا يمكن إلغاء فاتورة عليها دفعة. ألغِ الدفعة أو استردها أولًا.',
  },
  split_not_allowed: {
    en: 'Only an issued invoice with nothing paid can be split.',
    ar: 'لا يمكن تقسيم إلا فاتورة مستحقة لم يُدفع منها شيء.',
  },
  split_sum: {
    en: 'The parts must add up to the invoice total.',
    ar: 'يجب أن يساوي مجموع الأجزاء إجمالي الفاتورة.',
  },
  not_open: { en: 'This invoice is not open for payment.', ar: 'هذه الفاتورة غير متاحة للدفع.' },
  over_balance: {
    en: 'The amount is more than the balance due.',
    ar: 'المبلغ أكبر من الرصيد المستحق.',
  },
  payment_not_voidable: {
    en: 'Only a recorded manual payment can be voided here.',
    ar: 'لا يمكن هنا إلغاء إلا دفعة يدوية مسجلة.',
  },
  provider_unavailable: {
    en: 'This payment method is not available.',
    ar: 'طريقة الدفع هذه غير متاحة.',
  },
  provider_error: {
    en: 'The payment provider did not respond. Please try again.',
    ar: 'لم تستجب جهة الدفع. حاول مرة أخرى.',
  },
  remind_throttled: {
    en: 'A reminder was already sent in the last hour.',
    ar: 'أُرسل تذكير خلال الساعة الماضية.',
  },
  parent_mail_off: {
    en: 'Emails to parents are switched off (billing.notify_parents).',
    ar: 'رسائل البريد إلى أولياء الأمور متوقفة (billing.notify_parents).',
  },
  unknown_student: {
    en: 'Unknown student for this family.',
    ar: 'الطالب لا ينتمي إلى هذه الأسرة.',
  },
  has_open_invoices: {
    en: 'This family still has open invoices. Settle or void them first.',
    ar: 'لدى هذه الأسرة فواتير غير مسددة. سدّدها أو ألغِها أولًا.',
  },
} as const;
export type BillingErrorCode = keyof typeof BILLING_ERROR_MESSAGES;

/** The invoice screen in the web app (mail links, checkout return URLs). */
export const invoicePath = (invoiceId: number) => `/invoices/${invoiceId}`;

// ------------------------------------------------------------------ fee packages

export const feePackagePriceSchema = z.object({
  currency: z.enum(CURRENCIES),
  /** Monthly fee, `"60.00"`. */
  monthlyAmount: z.string(),
});
export type FeePackagePriceDto = z.infer<typeof feePackagePriceSchema>;

export const feePackageSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  classesPerWeek: z.number().int(),
  sessionMinutes: z.number().int(),
  description: z.string().nullable(),
  isActive: z.boolean(),
  /** Sorted by currency. */
  prices: z.array(feePackagePriceSchema),
  /** Children on this package. */
  studentsCount: z.number().int(),
});
export type FeePackageDto = z.infer<typeof feePackageSchema>;

export const feePackageListQuerySchema = z.object({ active: queryBool.optional() });
export type FeePackageListQuery = z.input<typeof feePackageListQuerySchema>;

const priceInputSchema = z.object({ currency: currencySchema, monthlyAmount: amountSchema });
const pricesInputSchema = z
  .array(priceInputSchema)
  .min(1)
  .max(CURRENCIES.length)
  .superRefine((prices, ctx) => {
    const seen = new Set<string>();
    prices.forEach((p, i) => {
      if (seen.has(p.currency)) {
        ctx.addIssue({ code: 'custom', path: [i, 'currency'], message: 'Each currency once.' });
      }
      seen.add(p.currency);
    });
  });

export const createFeePackageSchema = z.object({
  name: z.string().trim().min(1).max(120),
  classesPerWeek: z.number().int().min(1).max(14),
  sessionMinutes: z
    .number()
    .int()
    .refine((m) => (SESSION_MINUTES_OPTIONS as readonly number[]).includes(m), {
      message: 'Use 30, 45, 60 or 90 minutes.',
    })
    .default(30),
  description: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().trim().max(500).nullable().optional(),
  ),
  isActive: z.boolean().default(true),
  /** The monthly price per currency; on update the list replaces the old one. */
  prices: pricesInputSchema,
});
export type CreateFeePackageInput = z.input<typeof createFeePackageSchema>;
export const updateFeePackageSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  classesPerWeek: z.number().int().min(1).max(14).optional(),
  sessionMinutes: z
    .number()
    .int()
    .refine((m) => (SESSION_MINUTES_OPTIONS as readonly number[]).includes(m), {
      message: 'Use 30, 45, 60 or 90 minutes.',
    })
    .optional(),
  description: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().trim().max(500).nullable().optional(),
  ),
  isActive: z.boolean().optional(),
  prices: pricesInputSchema.optional(),
});
export type UpdateFeePackageInput = z.input<typeof updateFeePackageSchema>;

// ------------------------------------------------------------------ family billing profile

export const feeLineSchema = z.object({
  type: z.enum(INVOICE_LINE_TYPES),
  studentId: z.number().int().nullable(),
  feePackageId: z.number().int().nullable(),
  description: z.string(),
  amount: z.string(),
  /** `source` (`package` | `custom_fee`), proration (`prorated`, `days`, `periodDays`, `fullAmount`). */
  meta: z.record(z.string(), z.unknown()).nullable(),
});
export type FeeLineDto = z.infer<typeof feeLineSchema>;

/** One family's fee for a period (the run preview row, the profile's next invoice). */
export const familyFeeSchema = z.object({
  periodStart: dateOnlySchema,
  periodEnd: dateOnlySchema,
  currency: z.enum(CURRENCIES).nullable(),
  total: z.string(),
  lines: z.array(feeLineSchema),
  /** `BILLING_WARNINGS` codes, some with `:<studentId>`. */
  warnings: z.array(z.string()),
});
export type FamilyFeeDto = z.infer<typeof familyFeeSchema>;

/** What a family owes, per currency (open invoices). */
export const familyBalanceSchema = z.object({
  currency: z.string(),
  due: z.string(),
  overdue: z.string(),
  openInvoices: z.number().int(),
});
export type FamilyBalanceDto = z.infer<typeof familyBalanceSchema>;

export const familyBillingSchema = z.object({
  familyId: z.number().int(),
  familyName: z.string(),
  billingCurrency: z.enum(CURRENCIES).nullable(),
  billingDay: z.number().int(),
  billingEnabled: z.boolean(),
  /** Fixed monthly fee of the family (old `account.fee`); replaces the packages when set. */
  customFee: z.string().nullable(),
  billingStartsOn: dateOnlySchema.nullable(),
  status: z.string(),
  students: z.array(
    z.object({ id: z.number().int(), name: z.string(), feePackageId: z.number().int().nullable() }),
  ),
  nextInvoice: familyFeeSchema,
  balance: z.array(familyBalanceSchema),
});
export type FamilyBillingDto = z.infer<typeof familyBillingSchema>;

export const updateFamilyBillingSchema = z.object({
  billingCurrency: currencySchema,
  billingDay: z.union([z.literal(1), z.literal(15)], { message: 'Use 1 or 15.' }),
  billingEnabled: z.boolean(),
  customFee: z.preprocess(
    (v) => (v === '' ? null : v),
    z
      .union([z.number(), z.string()])
      .transform((v) => String(v))
      .pipe(z.string().regex(DECIMAL, { message: 'Use an amount with at most 2 decimals.' }))
      .transform(toMinor)
      .refine((m) => m >= 0 && m <= MAX_AMOUNT_MINOR, {
        message: 'Use an amount from 0 to 1000000.',
      })
      .transform(fromMinor)
      .nullable()
      .optional(),
  ),
  billingStartsOn: z.preprocess((v) => (v === '' ? null : v), dateOnlySchema.nullable().optional()),
  /** A package change applies from the next invoice (old change-pack, D85). */
  students: z
    .array(z.object({ id, feePackageId: id.nullable() }))
    .max(20)
    .superRefine((rows, ctx) => {
      const seen = new Set<number>();
      rows.forEach((r, i) => {
        if (seen.has(r.id))
          ctx.addIssue({ code: 'custom', path: [i, 'id'], message: 'Duplicate.' });
        seen.add(r.id);
      });
    })
    .optional(),
});
export type UpdateFamilyBillingInput = z.input<typeof updateFamilyBillingSchema>;

// ------------------------------------------------------------------ invoices

export const invoiceListQuerySchema = z.object({
  status: z.enum(INVOICE_TABS).optional(),
  familyId: queryId.optional(),
  /** Invoices whose period starts in the month (or issued in it when they have no period). */
  period: monthSchema.optional(),
  /** Number, parent name or email. */
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});
export type InvoiceListQuery = z.input<typeof invoiceListQuerySchema>;

export const invoiceSchema = z.object({
  id: z.number().int(),
  /** `INV-2026-000123`, set when issued. */
  number: z.string().nullable(),
  kind: z.enum(INVOICE_KINDS),
  status: z.enum(INVOICE_STATUSES),
  isOverdue: z.boolean(),
  family: z.object({ id: z.number().int(), name: z.string() }),
  currency: z.string(),
  periodStart: dateOnlySchema.nullable(),
  periodEnd: dateOnlySchema.nullable(),
  issueDate: dateOnlySchema.nullable(),
  dueDate: dateOnlySchema.nullable(),
  subtotal: z.string(),
  adjustments: z.string(),
  discounts: z.string(),
  total: z.string(),
  paid: z.string(),
  balance: z.string(),
  paidAt: z.string().nullable(),
  createdAt: z.string(),
});
export type InvoiceDto = z.infer<typeof invoiceSchema>;
export const invoiceListResponseSchema = paginatedSchema(invoiceSchema);

export const invoiceLineSchema = z.object({
  id: z.number().int(),
  type: z.enum(INVOICE_LINE_TYPES),
  student: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  description: z.string(),
  amount: z.string(),
  meta: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});
export type InvoiceLineDto = z.infer<typeof invoiceLineSchema>;

export const paymentSchema = z.object({
  id: z.number().int(),
  invoiceId: z.number().int(),
  method: z.enum(PAYMENT_METHODS),
  status: z.enum(PAYMENT_STATUSES),
  amount: z.string(),
  currency: z.string(),
  reference: z.string().nullable(),
  receivedAt: z.string().nullable(),
  refundedAt: z.string().nullable(),
  createdAt: z.string(),
  /** `RC-000123` once succeeded. */
  receiptNumber: z.string().nullable(),
  /** Staff only: internal note, failure code, provider id, who recorded it. */
  note: z.string().nullable().optional(),
  failureReason: z.string().nullable().optional(),
  providerPaymentId: z.string().nullable().optional(),
  recordedBy: z.object({ id: z.number().int(), name: z.string() }).nullable().optional(),
  /** P1-1: the part not applied to this invoice (kept as the family's credit), decimal string. */
  unapplied: z.string().default('0.00'),
  /** Staff: look at it (`overpaid` / `invoice_closed`). */
  needsReview: z.boolean().default(false),
  reviewReason: z.string().nullable().default(null),
});
export type PaymentDto = z.infer<typeof paymentSchema>;

/** Package usage of a child in the invoice period (B24, D85): information only. */
export const packageUsageSchema = z.object({
  studentId: z.number().int(),
  studentName: z.string(),
  /** Classes per week × 4. */
  allowance: z.number().int(),
  /** Classes in `countedStages` (`billing.deducting_stages`: taken, absent, declined). */
  counted: z.number().int(),
  /** Leave, cancelled (holidays) and moved classes. */
  notCounted: z.number().int(),
  /** Classes still to come or running. */
  upcoming: z.number().int(),
  byStage: z.record(z.string(), z.number().int()),
  countedStages: z.array(z.string()),
});
export type PackageUsageDto = z.infer<typeof packageUsageSchema>;

export const invoiceDetailSchema = invoiceSchema.extend({
  notes: z.string().nullable(),
  voidReason: z.string().nullable(),
  voidedAt: z.string().nullable(),
  lines: z.array(invoiceLineSchema),
  /** A parent sees succeeded, refunded and pending payments only. */
  payments: z.array(paymentSchema),
  splitFrom: z.object({ id: z.number().int(), number: z.string().nullable() }).nullable(),
  splits: z.array(
    z.object({
      id: z.number().int(),
      number: z.string().nullable(),
      status: z.enum(INVOICE_STATUSES),
      total: z.string(),
      dueDate: dateOnlySchema.nullable(),
    }),
  ),
  usage: z.array(packageUsageSchema),
  can: z.object({
    pay: z.boolean(),
    issue: z.boolean(),
    edit: z.boolean(),
    recordPayment: z.boolean(),
    split: z.boolean(),
    void: z.boolean(),
    remind: z.boolean(),
  }),
});
export type InvoiceDetailDto = z.infer<typeof invoiceDetailSchema>;

export const createInvoiceSchema = z.object({
  familyId: id,
  dueDate: z.preprocess((v) => (v === '' ? null : v), dateOnlySchema.nullable().optional()),
  notes: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().trim().max(1000).nullable().optional(),
  ),
  /** Issue at once (needs `invoices.manage`; `invoices.request` alone always makes a draft, D87). */
  issue: z.boolean().default(false),
  lines: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(500),
        amount: amountSchema,
        studentId: id.nullable().optional(),
      }),
    )
    .min(1)
    .max(20),
});
export type CreateInvoiceInput = z.input<typeof createInvoiceSchema>;

/** Adjustment (signed `amount`) or discount (`amount` or `percent` of the current total); D83. */
export const addInvoiceLineSchema = z
  .object({
    type: z.enum(['adjustment', 'discount']),
    amount: signedAmountSchema.optional(),
    percent: percentSchema.optional(),
    reason: reasonSchema,
  })
  .superRefine((v, ctx) => {
    if (v.percent !== undefined && v.type !== 'discount') {
      ctx.addIssue({
        code: 'custom',
        path: ['percent'],
        message: 'Only a discount has a percent.',
      });
    }
    if (v.percent === undefined && v.amount === undefined) {
      ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Send an amount or a percent.' });
    }
    if (v.percent !== undefined && v.amount !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Send an amount or a percent.' });
    }
  });
export type AddInvoiceLineInput = z.input<typeof addInvoiceLineSchema>;

/** Destructive money actions need a reason (D31); it goes to the record and the audit log. */
export const billingReasonSchema = z.object({ reason: reasonSchema });
export type BillingReasonInput = z.input<typeof billingReasonSchema>;

export const splitInvoiceSchema = z.object({
  reason: reasonSchema,
  parts: z
    .array(z.object({ amount: amountSchema, dueDate: dateOnlySchema }))
    .min(2)
    .max(6),
});
export type SplitInvoiceInput = z.input<typeof splitInvoiceSchema>;
export const splitResultSchema = z.object({
  original: invoiceDetailSchema,
  parts: z.array(invoiceSchema),
});
export type SplitResultDto = z.infer<typeof splitResultSchema>;

export const remindResultSchema = z.object({
  result: z.enum(['sent', 'already', 'unreachable', 'failed', 'disabled']),
});
export type RemindResultDto = z.infer<typeof remindResultSchema>;

// ------------------------------------------------------------------ payments

export const manualPaymentSchema = z.object({
  method: z.enum(MANUAL_PAYMENT_METHODS, {
    message: 'Online payments are recorded by the provider only.',
  }),
  amount: amountSchema,
  /** Academy-local date, not in the future. */
  receivedOn: dateOnlySchema,
  reference: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().trim().max(191).nullable().optional(),
  ),
  note: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().trim().max(1000).nullable().optional(),
  ),
});
export type ManualPaymentInput = z.input<typeof manualPaymentSchema>;

/** The parent only chooses the provider; the amount is always the server's balance. */
export const checkoutSchema = z.object({ provider: z.enum(ONLINE_PAYMENT_METHODS) });
export type CheckoutInput = z.input<typeof checkoutSchema>;
export const checkoutResultSchema = z.object({
  paymentId: z.number().int(),
  provider: z.enum(ONLINE_PAYMENT_METHODS),
  amount: z.string(),
  currency: z.string(),
  /** The provider's hosted page (Stripe Checkout / PayPal approval). */
  url: z.string(),
});
export type CheckoutResultDto = z.infer<typeof checkoutResultSchema>;

export const paypalCaptureSchema = z.object({
  orderId: z
    .string()
    .max(64)
    .regex(/^[A-Z0-9-]+$/, 'Invalid order id.'),
});
export type PaypalCaptureInput = z.input<typeof paypalCaptureSchema>;

export const billingProvidersSchema = z.object({
  /** Online methods that are configured (test / sandbox keys only, D88). */
  online: z.array(z.enum(ONLINE_PAYMENT_METHODS)),
  manual: z.array(z.enum(MANUAL_PAYMENT_METHODS)),
  currencies: z.array(z.enum(CURRENCIES)),
});
export type BillingProvidersDto = z.infer<typeof billingProvidersSchema>;

// ------------------------------------------------------------------ monthly run

export const invoiceRunPreviewSchema = z.object({
  period: monthSchema,
  billingDay: z.union([z.literal(1), z.literal(15)], { message: 'Use 1 or 15.' }).default(1),
  dueDate: dateOnlySchema.optional(),
  familyIds: z.array(id).max(2000).optional(),
});
export type InvoiceRunPreviewInput = z.input<typeof invoiceRunPreviewSchema>;
export const invoiceRunSchema = invoiceRunPreviewSchema.extend({ dueDate: dateOnlySchema });
export type InvoiceRunInput = z.input<typeof invoiceRunSchema>;

export const invoiceRunRowSchema = familyFeeSchema.extend({
  familyId: z.number().int(),
  familyName: z.string(),
  children: z.number().int(),
  existingInvoiceId: z.number().int().nullable(),
  willIssue: z.boolean(),
});
export type InvoiceRunRowDto = z.infer<typeof invoiceRunRowSchema>;
export const invoiceRunPreviewResponseSchema = z.object({
  data: z.array(invoiceRunRowSchema),
  meta: z.object({
    families: z.number().int(),
    willIssue: z.number().int(),
    /** Currency → total of the invoices that would be issued. */
    totals: z.record(z.string(), z.string()),
  }),
});
export type InvoiceRunPreviewResponse = z.infer<typeof invoiceRunPreviewResponseSchema>;
export const invoiceRunResultSchema = z.object({
  issued: z.array(z.number().int()),
  skipped: z.array(z.object({ familyId: z.number().int(), reason: z.string() })),
  issuedCount: z.number().int(),
});
export type InvoiceRunResultDto = z.infer<typeof invoiceRunResultSchema>;

// ------------------------------------------------------------------ summary + settings

export const billingSummarySchema = z.object({
  byCurrency: z.array(
    z.object({
      currency: z.string(),
      due: z.string(),
      openCount: z.number().int(),
      overdue: z.string(),
      overdueCount: z.number().int(),
      collectedThisMonth: z.string(),
    }),
  ),
  /** Status → count, plus `overdue`. */
  counts: z.record(z.string(), z.number().int()),
  /** Academy month, `YYYY-MM`. */
  month: z.string(),
});
export type BillingSummaryDto = z.infer<typeof billingSummarySchema>;

/**
 * `GET/PUT /settings/billing`: flat keys (like `/settings/sessions`). `billing.notify_parents`
 * is off by default (D140): no invoice or reminder email goes to a family until it is switched on.
 */
export const BILLING_SETTING_RULES = {
  /** Class stages that count against a package (B24, D85). */
  'billing.deducting_stages': z
    .array(
      z.enum([
        'scheduled',
        'activated',
        'in_progress',
        'ended',
        'taken',
        'absent',
        'declined',
        'leave',
        'cancelled',
        'moved_out',
      ]),
    )
    .max(10),
  /** Reminder days relative to the due date (D88); `[]` = no automatic reminders. */
  'billing.reminder_days': z.array(z.number().int().min(-30).max(60)).max(10),
  'billing.default_due_days': z.number().int().min(0).max(90),
  'billing.notify_parents': z.boolean(),
} as const;
export type BillingSettingKey = keyof typeof BILLING_SETTING_RULES;
export const billingSettingsSchema = z.object(BILLING_SETTING_RULES);
export type BillingSettingsDto = z.infer<typeof billingSettingsSchema>;
export const updateBillingSettingsSchema = z.strictObject(BILLING_SETTING_RULES).partial();
export type UpdateBillingSettingsInput = z.input<typeof updateBillingSettingsSchema>;

// ------------------------------------------------------------------ P1-1 family credits

/** Money a family paid beyond an invoice (B115): kept, reviewed, used on the next invoice. */
export const FAMILY_CREDIT_STATUSES = ['open', 'used', 'refunded'] as const;
export type FamilyCreditStatus = (typeof FAMILY_CREDIT_STATUSES)[number];
export const FAMILY_CREDIT_STATUS_LABELS: Labels<FamilyCreditStatus> = {
  open: { ar: 'متاح', en: 'Open' },
  used: { ar: 'استُخدم', en: 'Used' },
  refunded: { ar: 'رُدّ', en: 'Refunded' },
};

/** `GET /billing/credits?status&needsReview&familyId` (`invoices.view`). */
export const familyCreditQuerySchema = z.object({
  status: z.enum(FAMILY_CREDIT_STATUSES).optional(),
  /** `1`: only the ones nobody marked reviewed yet (the review list). */
  needsReview: z
    .enum(['1', '0', 'true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === '1' || v === 'true')),
  familyId: z.coerce.number().int().positive().optional(),
});

export const familyCreditSchema = z.object({
  id: z.number().int(),
  family: z.object({ id: z.number().int(), name: z.string() }),
  currency: z.string(),
  amount: z.string(),
  remaining: z.string(),
  status: z.enum(FAMILY_CREDIT_STATUSES),
  sourcePayment: z
    .object({ id: z.number().int(), invoiceId: z.number().int(), method: z.string() })
    .nullable(),
  reviewedAt: z.string().nullable(),
  reviewedBy: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
});
export type FamilyCreditDto = z.infer<typeof familyCreditSchema>;

/** `POST /billing/credits/:id/review` (`invoices.manage`): seen, with an optional note. */
export const reviewFamilyCreditSchema = z.object({
  note: z
    .preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
      z.string().trim().max(1000).nullable(),
    )
    .optional(),
});
