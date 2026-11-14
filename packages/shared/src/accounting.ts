import { z } from 'zod';
import { dateOnlySchema, paginatedSchema } from './people.js';
import { monthSchema } from './tests.js';

/**
 * Accounting (M7; docs/09 M14, docs/07 §أ, D2, D86, D95): chart of accounts, a double-entry journal
 * (append-only), automatic entries from the billing and payroll outboxes, receipt and payment
 * vouchers, monthly period close and the financial reports. `/api/v1/accounting/…`.
 *
 * Books are kept **per currency**: every journal entry is in one currency and balances in it
 * (debits = credits, checked by the API and again by a deferred database trigger). Reports take a
 * currency; nothing is converted (no exchange rates in Phase 1, B-question in docs/12).
 *
 * Money is a decimal string with 2 decimals (`"150.00"`); the API computes in integer minor units.
 * Dates are `YYYY-MM-DD` (the entry date, academy calendar); a period is `YYYY-MM`.
 *
 * Permissions (docs/07 §ب): `accounting.view` (admin, senior manager, accounts) reads everything;
 * `accounting.manage` (admin, accounts) posts, voids, closes and reopens.
 */

type Labels<T extends string> = Record<T, { ar: string; en: string }>;

const id = z.number().int().positive();
const queryId = z.coerce.number().int().positive().max(2_147_483_647);
const page = {
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
};

/** A positive decimal amount up to 999,999,999,999.99 (number or string, at most 2 decimals). */
export const ledgerMoneyInputSchema = z
  .union([z.number(), z.string().trim()])
  .transform((v) => String(v))
  .pipe(
    z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, {
      message: 'Use a positive amount with at most 2 decimals.',
    }),
  )
  .transform((v) => {
    const [whole = '0', frac = ''] = v.split('.');
    return `${BigInt(whole).toString()}.${frac.padEnd(2, '0')}`;
  });

const positiveMoney = ledgerMoneyInputSchema.refine((v) => !/^0\.00$/.test(v), {
  message: 'The amount must be greater than 0.',
});

export const ledgerCurrencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, { message: 'Use a 3-letter currency code.' });

const reasonText = z.string().trim().min(3).max(2000);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

// ------------------------------------------------------------------ catalog

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export const ACCOUNT_TYPE_LABELS: Labels<AccountType> = {
  asset: { ar: 'الأصول', en: 'Assets' },
  liability: { ar: 'الخصوم', en: 'Liabilities' },
  equity: { ar: 'حقوق الملكية', en: 'Equity' },
  income: { ar: 'الإيرادات', en: 'Income' },
  expense: { ar: 'المصروفات', en: 'Expenses' },
};
/** Debit-normal types (balance = debit − credit); the others are credit-normal. */
export const DEBIT_NORMAL: readonly AccountType[] = ['asset', 'expense'];

/**
 * Accounts the automatic entries post to (seeded, `system_key`): they cannot be archived and their
 * type cannot change.
 */
export const SYSTEM_ACCOUNT_KEYS = [
  'cash',
  'bank',
  'stripe_clearing',
  'paypal_clearing',
  'vodafone_cash',
  'receivable',
  'staff_advances',
  'salaries_payable',
  'tax_payable',
  'retained_earnings',
  'opening_balance',
  'tuition_revenue',
  'discounts',
  'fines_income',
  'salaries_expense',
  'gateway_fees',
  'customer_credits',
] as const;
export type SystemAccountKey = (typeof SYSTEM_ACCOUNT_KEYS)[number];

export const JOURNAL_SOURCES = ['manual', 'voucher', 'billing', 'payroll', 'reversal'] as const;
export type JournalSource = (typeof JOURNAL_SOURCES)[number];
export const JOURNAL_SOURCE_LABELS: Labels<JournalSource> = {
  manual: { ar: 'قيد يدوي', en: 'Manual entry' },
  voucher: { ar: 'سند', en: 'Voucher' },
  billing: { ar: 'الفوترة (تلقائي)', en: 'Billing (automatic)' },
  payroll: { ar: 'الرواتب (تلقائي)', en: 'Payroll (automatic)' },
  reversal: { ar: 'قيد عكسي', en: 'Reversing entry' },
};

export const VOUCHER_TYPES = ['receipt', 'payment'] as const;
export type VoucherType = (typeof VOUCHER_TYPES)[number];
export const VOUCHER_TYPE_LABELS: Labels<VoucherType> = {
  receipt: { ar: 'سند قبض', en: 'Receipt voucher' },
  payment: { ar: 'سند صرف', en: 'Payment voucher' },
};
export const VOUCHER_STATUSES = ['posted', 'void'] as const;
export type VoucherStatus = (typeof VOUCHER_STATUSES)[number];
export const VOUCHER_STATUS_LABELS: Labels<VoucherStatus> = {
  posted: { ar: 'مُرحّل', en: 'Posted' },
  void: { ar: 'ملغى', en: 'Void' },
};

export const PERIOD_STATUSES = ['open', 'closed'] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];
export const PERIOD_STATUS_LABELS: Labels<PeriodStatus> = {
  open: { ar: 'مفتوحة', en: 'Open' },
  closed: { ar: 'مُقفلة', en: 'Closed' },
};

export const OUTBOX_SOURCES = ['billing', 'payroll'] as const;
export type OutboxSource = (typeof OUTBOX_SOURCES)[number];

export const ACCOUNTING_ERROR_MESSAGES = {
  unbalanced: {
    ar: 'القيد غير متوازن: يجب أن يساوي مجموع المدين مجموع الدائن.',
    en: 'The entry does not balance: total debits must equal total credits.',
  },
  account_not_postable: {
    ar: 'لا يمكن الترحيل إلى حساب تجميعي أو مؤرشف.',
    en: 'You cannot post to a group account or an archived account.',
  },
  account_currency: {
    ar: 'هذا الحساب مقيّد بعملة أخرى.',
    en: 'This account is restricted to another currency.',
  },
  period_closed: {
    ar: 'الفترة المحاسبية لهذا التاريخ مُقفلة.',
    en: 'The accounting period of this date is closed.',
  },
  period_not_closed: { ar: 'هذه الفترة غير مُقفلة.', en: 'This period is not closed.' },
  period_already_closed: { ar: 'هذه الفترة مُقفلة بالفعل.', en: 'This period is already closed.' },
  period_not_ended: {
    ar: 'لا يمكن إقفال فترة لم تنتهِ بعد.',
    en: 'A period can only be closed after it ends.',
  },
  outbox_pending: {
    ar: 'توجد قيود تلقائية لم تُرحّل بعد لهذه الفترة. رحّلها أولًا.',
    en: 'Automatic entries for this period are still waiting to be posted. Post them first.',
  },
  already_reversed: { ar: 'تم عكس هذا القيد من قبل.', en: 'This entry has already been reversed.' },
  reverse_voucher_entry: {
    ar: 'قيود السندات تُلغى من السند نفسه.',
    en: 'Voucher entries are cancelled by voiding the voucher.',
  },
  voucher_void: { ar: 'هذا السند ملغى بالفعل.', en: 'This voucher is already void.' },
  code_taken: { ar: 'رقم الحساب مستخدم.', en: 'This account code is already in use.' },
  parent_invalid: {
    ar: 'الحساب الأب يجب أن يكون حسابًا تجميعيًا من النوع نفسه.',
    en: 'The parent must be a group account of the same type.',
  },
  system_account: {
    ar: 'هذا حساب نظام تستخدمه القيود التلقائية: لا يمكن أرشفته.',
    en: 'This is a system account used by automatic entries: it cannot be archived.',
  },
  account_in_use: {
    ar: 'لا يمكن تحويل حساب عليه حركات إلى حساب تجميعي.',
    en: 'An account with postings cannot become a group account.',
  },
  group_has_children: {
    ar: 'لا يمكن أرشفة حساب تجميعي له حسابات فرعية نشطة.',
    en: 'A group account with active sub-accounts cannot be archived.',
  },
} as const;
export type AccountingErrorCode = keyof typeof ACCOUNTING_ERROR_MESSAGES;

// ------------------------------------------------------------------ chart of accounts

export const ledgerAccountSchema = z.object({
  id,
  code: z.string(),
  nameAr: z.string(),
  nameEn: z.string(),
  type: z.enum(ACCOUNT_TYPES),
  parentId: id.nullable(),
  isGroup: z.boolean(),
  isCash: z.boolean(),
  /** Only lines in this currency may post here (e.g. a USD bank account); null = any. */
  currency: z.string().nullable(),
  systemKey: z.enum(SYSTEM_ACCOUNT_KEYS).nullable(),
  isActive: z.boolean(),
  description: z.string().nullable(),
});
export type LedgerAccountDto = z.infer<typeof ledgerAccountSchema>;

export const accountListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  type: z.enum(ACCOUNT_TYPES).optional(),
  /** `postable` = active, non-group accounts (the account picker). */
  only: z.enum(['all', 'active', 'postable']).default('all'),
});
export type AccountListQuery = z.infer<typeof accountListQuerySchema>;

const accountCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{1,10}$/, { message: 'Use up to 10 digits.' });

export const createAccountSchema = z.object({
  code: accountCodeSchema,
  nameAr: z.string().trim().min(2).max(120),
  nameEn: z.string().trim().min(2).max(120),
  type: z.enum(ACCOUNT_TYPES),
  parentId: id.nullable().optional(),
  isGroup: z.boolean().default(false),
  isCash: z.boolean().default(false),
  currency: ledgerCurrencySchema.nullable().optional(),
  description: optionalText(500),
});
export type CreateAccountInput = z.input<typeof createAccountSchema>;

export const updateAccountSchema = z
  .object({
    nameAr: z.string().trim().min(2).max(120),
    nameEn: z.string().trim().min(2).max(120),
    parentId: id.nullable(),
    isCash: z.boolean(),
    isActive: z.boolean(),
    description: optionalText(500),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });
export type UpdateAccountInput = z.input<typeof updateAccountSchema>;

// ------------------------------------------------------------------ journal

export const journalLineSchema = z.object({
  id,
  accountId: id,
  accountCode: z.string(),
  accountNameAr: z.string(),
  accountNameEn: z.string(),
  debit: z.string(),
  credit: z.string(),
  description: z.string().nullable(),
  partyType: z.enum(['family', 'user']).nullable(),
  partyId: id.nullable(),
});
export type JournalLineDto = z.infer<typeof journalLineSchema>;

export const journalEntrySchema = z.object({
  id,
  number: z.string(),
  date: dateOnlySchema,
  currency: z.string(),
  memo: z.string(),
  source: z.enum(JOURNAL_SOURCES),
  /** `billing_event:12`, `payroll_event:4`, `voucher:7`, … */
  sourceRef: z.string().nullable(),
  reversesId: id.nullable(),
  reversedById: id.nullable(),
  voucherId: id.nullable(),
  total: z.string(),
  createdBy: z.object({ id, name: z.string() }).nullable(),
  createdAt: z.string(),
  lines: z.array(journalLineSchema),
});
export type JournalEntryDto = z.infer<typeof journalEntrySchema>;

/** The list row (no lines). */
export const journalEntryRowSchema = journalEntrySchema.omit({ lines: true });
export type JournalEntryRowDto = z.infer<typeof journalEntryRowSchema>;
export const journalListResponseSchema = paginatedSchema(journalEntryRowSchema);

export const journalListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  currency: ledgerCurrencySchema.optional(),
  source: z.enum(JOURNAL_SOURCES).optional(),
  accountId: queryId.optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  ...page,
});
export type JournalListQuery = z.infer<typeof journalListQuerySchema>;

export const journalLineInputSchema = z
  .object({
    accountId: id,
    debit: ledgerMoneyInputSchema.optional(),
    credit: ledgerMoneyInputSchema.optional(),
    description: optionalText(500),
  })
  .refine(
    (l) => {
      const d = l.debit && l.debit !== '0.00';
      const c = l.credit && l.credit !== '0.00';
      return Boolean(d) !== Boolean(c);
    },
    { message: 'Each line has either a debit or a credit amount (greater than 0).' },
  );

export const createJournalEntrySchema = z.object({
  date: dateOnlySchema,
  currency: ledgerCurrencySchema,
  memo: z.string().trim().min(3).max(500),
  lines: z.array(journalLineInputSchema).min(2).max(100),
});
export type CreateJournalEntryInput = z.input<typeof createJournalEntrySchema>;

export const reverseEntrySchema = z.object({
  reason: reasonText,
  /** Defaults to today (academy zone). */
  date: dateOnlySchema.optional(),
});
export type ReverseEntryInput = z.input<typeof reverseEntrySchema>;

// ------------------------------------------------------------------ vouchers

export const voucherLineInputSchema = z.object({
  accountId: id,
  amount: positiveMoney,
  description: optionalText(500),
});

export const createVoucherSchema = z.object({
  type: z.enum(VOUCHER_TYPES),
  date: dateOnlySchema,
  currency: ledgerCurrencySchema,
  /** The cash, bank or wallet account that receives (receipt) or pays (payment). */
  cashAccountId: id,
  /** Payee (payment) or payer (receipt): a supplier, a person or a company. */
  party: z.string().trim().min(2).max(160),
  description: z.string().trim().min(3).max(500),
  reference: optionalText(80),
  chequeNumber: optionalText(40),
  lines: z.array(voucherLineInputSchema).min(1).max(50),
});
export type CreateVoucherInput = z.input<typeof createVoucherSchema>;

export const voucherSchema = z.object({
  id,
  number: z.string(),
  type: z.enum(VOUCHER_TYPES),
  status: z.enum(VOUCHER_STATUSES),
  date: dateOnlySchema,
  currency: z.string(),
  amount: z.string(),
  party: z.string(),
  description: z.string(),
  reference: z.string().nullable(),
  chequeNumber: z.string().nullable(),
  cashAccount: z.object({ id, code: z.string(), nameAr: z.string(), nameEn: z.string() }),
  lines: z.array(
    z.object({
      accountId: id,
      accountCode: z.string(),
      accountNameAr: z.string(),
      accountNameEn: z.string(),
      amount: z.string(),
      description: z.string().nullable(),
    }),
  ),
  journalEntryId: id,
  voidEntryId: id.nullable(),
  voidReason: z.string().nullable(),
  voidedAt: z.string().nullable(),
  createdBy: z.object({ id, name: z.string() }).nullable(),
  createdAt: z.string(),
});
export type VoucherDto = z.infer<typeof voucherSchema>;
export const voucherRowSchema = voucherSchema.omit({ lines: true });
export type VoucherRowDto = z.infer<typeof voucherRowSchema>;
export const voucherListResponseSchema = paginatedSchema(voucherRowSchema);

export const voucherListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  type: z.enum(VOUCHER_TYPES).optional(),
  status: z.enum(VOUCHER_STATUSES).optional(),
  currency: ledgerCurrencySchema.optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  ...page,
});
export type VoucherListQuery = z.infer<typeof voucherListQuerySchema>;

export const voidVoucherSchema = z.object({ reason: reasonText });

// ------------------------------------------------------------------ periods and the outbox

export const accountingPeriodSchema = z.object({
  period: monthSchema,
  status: z.enum(PERIOD_STATUSES),
  closedAt: z.string().nullable(),
  closedBy: z.object({ id, name: z.string() }).nullable(),
  reopenReason: z.string().nullable(),
  entries: z.number().int(),
});
export type AccountingPeriodDto = z.infer<typeof accountingPeriodSchema>;

export const periodListQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
});
export const reopenPeriodSchema = z.object({ reason: reasonText });

export const outboxStatusSchema = z.object({
  pending: z.record(z.enum(OUTBOX_SOURCES), z.number().int()),
  oldestPendingAt: z.string().nullable(),
  failures: z.array(
    z.object({
      source: z.enum(OUTBOX_SOURCES),
      eventId: id,
      eventType: z.string(),
      error: z.string(),
      attempts: z.number().int(),
      lastAttemptAt: z.string(),
    }),
  ),
});
export type OutboxStatusDto = z.infer<typeof outboxStatusSchema>;

export const outboxRunResultSchema = z.object({
  posted: z.number().int(),
  skipped: z.number().int(),
  failed: z.number().int(),
});
export type OutboxRunResultDto = z.infer<typeof outboxRunResultSchema>;

// ------------------------------------------------------------------ reports

export const reportRangeQuerySchema = z
  .object({ currency: ledgerCurrencySchema, from: dateOnlySchema, to: dateOnlySchema })
  .refine((v) => v.from <= v.to, { message: '`from` must be on or before `to`.', path: ['to'] });
export const reportAsOfQuerySchema = z.object({
  currency: ledgerCurrencySchema,
  asOf: dateOnlySchema,
});
export const cashReportQuerySchema = z
  .object({
    /** Omit for every currency. */
    currency: ledgerCurrencySchema.optional(),
    from: dateOnlySchema,
    to: dateOnlySchema,
  })
  .refine((v) => v.from <= v.to, { message: '`from` must be on or before `to`.', path: ['to'] });
export const accountStatementQuerySchema = z
  .object({ currency: ledgerCurrencySchema, from: dateOnlySchema, to: dateOnlySchema, ...page })
  .refine((v) => v.from <= v.to, { message: '`from` must be on or before `to`.', path: ['to'] });

const reportAccount = z.object({
  id,
  code: z.string(),
  nameAr: z.string(),
  nameEn: z.string(),
  type: z.enum(ACCOUNT_TYPES),
  parentId: id.nullable(),
});

export const trialBalanceSchema = z.object({
  currency: z.string(),
  from: dateOnlySchema,
  to: dateOnlySchema,
  rows: z.array(
    reportAccount.extend({
      openingDebit: z.string(),
      openingCredit: z.string(),
      periodDebit: z.string(),
      periodCredit: z.string(),
      closingDebit: z.string(),
      closingCredit: z.string(),
    }),
  ),
  totals: z.object({
    openingDebit: z.string(),
    openingCredit: z.string(),
    periodDebit: z.string(),
    periodCredit: z.string(),
    closingDebit: z.string(),
    closingCredit: z.string(),
  }),
  balanced: z.boolean(),
});
export type TrialBalanceDto = z.infer<typeof trialBalanceSchema>;

const sectionSchema = z.object({
  type: z.enum(ACCOUNT_TYPES),
  /** Accounts with a non-zero amount; `amount` is in the type's normal direction (may be negative). */
  rows: z.array(reportAccount.extend({ amount: z.string() })),
  total: z.string(),
});

export const profitAndLossSchema = z.object({
  currency: z.string(),
  from: dateOnlySchema,
  to: dateOnlySchema,
  income: sectionSchema,
  expense: sectionSchema,
  netProfit: z.string(),
});
export type ProfitAndLossDto = z.infer<typeof profitAndLossSchema>;

export const balanceSheetSchema = z.object({
  currency: z.string(),
  asOf: dateOnlySchema,
  assets: sectionSchema,
  liabilities: sectionSchema,
  equity: sectionSchema,
  /** Income − expenses up to `asOf` (no closing entries: shown as a line of equity). */
  retainedEarnings: z.string(),
  totalLiabilitiesAndEquity: z.string(),
  balanced: z.boolean(),
});
export type BalanceSheetDto = z.infer<typeof balanceSheetSchema>;

export const cashReportSchema = z.object({
  from: dateOnlySchema,
  to: dateOnlySchema,
  currencies: z.array(
    z.object({
      currency: z.string(),
      accounts: z.array(
        reportAccount.extend({
          opening: z.string(),
          inflow: z.string(),
          outflow: z.string(),
          closing: z.string(),
        }),
      ),
      opening: z.string(),
      inflow: z.string(),
      outflow: z.string(),
      closing: z.string(),
    }),
  ),
});
export type CashReportDto = z.infer<typeof cashReportSchema>;

export const accountStatementSchema = z.object({
  account: reportAccount,
  currency: z.string(),
  from: dateOnlySchema,
  to: dateOnlySchema,
  opening: z.string(),
  closing: z.string(),
  rows: z.array(
    z.object({
      lineId: id,
      entryId: id,
      number: z.string(),
      date: dateOnlySchema,
      memo: z.string(),
      description: z.string().nullable(),
      debit: z.string(),
      credit: z.string(),
      /** Running balance in the account's normal direction, after this line. */
      balance: z.string(),
    }),
  ),
  meta: z.object({
    page: z.number().int(),
    perPage: z.number().int(),
    total: z.number().int(),
    lastPage: z.number().int(),
  }),
});
export type AccountStatementDto = z.infer<typeof accountStatementSchema>;
