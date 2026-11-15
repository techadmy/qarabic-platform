import { z } from 'zod';
import { currencySchema } from './billing.js';
import { LEAD_SOURCES, LOST_REASONS } from './crm.js';
import type { Permission } from './permissions.js';
import { dateOnlySchema } from './people.js';

/*
| Management dashboard (docs/40, D144). All money is reported in USD: every amount is converted at
| the monthly rate of the month it happened (exchange-rate table kept by accounts). The original
| currency breakdown is always returned next to it, and a missing rate is a flag, never a 0.
*/

// ------------------------------------------------------------------ exchange rates (B124)

/** `YYYY-MM`. */
export const rateMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'Use a month as YYYY-MM.' });

/** Up to 8 decimals, > 0: USD for one unit of the currency (e.g. GBP → `1.27`). */
export const rateToUsdSchema = z
  .string()
  .trim()
  .regex(/^\d{1,6}(\.\d{1,8})?$/, { message: 'Use a positive number with up to 8 decimals.' })
  .refine((v) => Number(v) > 0, { message: 'The rate must be greater than zero.' });

/** USD itself is always 1 and is never stored. */
export const rateCurrencySchema = currencySchema.refine((c) => c !== 'USD', {
  message: 'USD is the reporting currency; its rate is always 1.',
});

export const exchangeRateSchema = z.object({
  id: z.number().int(),
  currency: z.string(),
  month: z.string(),
  /** USD per 1 unit of `currency`, decimal string. */
  rateToUsd: z.string(),
  note: z.string().nullable(),
  updatedAt: z.string(),
  /** Who set it last (staff-only list). */
  updatedBy: z.object({ id: z.number().int(), name: z.string() }).nullable(),
});
export type ExchangeRateDto = z.infer<typeof exchangeRateSchema>;

/** `GET /accounting/exchange-rates?currency&from&to` (`accounting.view` or `reports.financial`). */
export const exchangeRateQuerySchema = z.object({
  currency: rateCurrencySchema.optional(),
  from: rateMonthSchema.optional(),
  to: rateMonthSchema.optional(),
});

/** `PUT /accounting/exchange-rates` (`accounting.manage`): set the rate of a currency for a month. */
export const upsertExchangeRateSchema = z.object({
  currency: rateCurrencySchema,
  month: rateMonthSchema,
  rateToUsd: rateToUsdSchema,
  note: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().trim().max(500).nullable().optional(),
  ),
});
export type UpsertExchangeRateInput = z.input<typeof upsertExchangeRateSchema>;

/**
 * `DELETE /accounting/exchange-rates/:id` (`accounting.manage`): a reason is required, because
 * every report of that month changes.
 */
export const deleteExchangeRateSchema = z.object({ reason: z.string().trim().min(3).max(500) });

// ------------------------------------------------------------------ money in USD

/** One currency's part of a total. `usd` is null when that month's rate is missing. */
export const currencyPartSchema = z.object({
  currency: z.string(),
  /** In the original currency, decimal string. */
  amount: z.string(),
  usd: z.string().nullable(),
  /** Months (`YYYY-MM`) of this currency with no rate. Empty when all converted. */
  missingMonths: z.array(z.string()),
});

/**
 * A money total reported in USD. `usd` is null when any part lacks a rate (`missingRate`): the
 * screen shows the warning and the breakdown instead of a wrong total. Never a silent 0.
 */
export const usdMoneySchema = z.object({
  usd: z.string().nullable(),
  missingRate: z.boolean(),
  byCurrency: z.array(currencyPartSchema),
});
export type UsdMoney = z.infer<typeof usdMoneySchema>;

// ------------------------------------------------------------------ query

export const DASHBOARD_BUCKETS = ['day', 'week', 'month'] as const;
export type DashboardBucket = (typeof DASHBOARD_BUCKETS)[number];
export const DASHBOARD_COMPARE = ['prev', 'none'] as const;

/** At most two years in one request. */
export const DASHBOARD_MAX_DAYS = 731;

/**
 * `GET /dashboard/metrics?from&to&compare&bucket`. Dates are academy-local and inclusive. No range =
 * the current month (B122). No bucket = day up to 31 days, week up to 92, else month.
 */
export const dashboardQuerySchema = z
  .object({
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    compare: z.enum(DASHBOARD_COMPARE).default('prev'),
    bucket: z.enum(DASHBOARD_BUCKETS).optional(),
  })
  .refine((q) => (q.from === undefined) === (q.to === undefined), {
    message: 'Send both from and to, or neither.',
    path: ['to'],
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: 'The start must be on or before the end.',
    path: ['to'],
  })
  .refine(
    (q) =>
      !q.from ||
      !q.to ||
      (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86_400_000 <
        DASHBOARD_MAX_DAYS,
    { message: 'Choose a range of at most two years.', path: ['from'] },
  );
export type DashboardQuery = z.input<typeof dashboardQuerySchema>;

// ------------------------------------------------------------------ widgets

export const DASHBOARD_WIDGETS = [
  // KPI cards
  'active_students',
  'new_students',
  'teachers_on_duty',
  'trials',
  'attendance_rate',
  'collected',
  'outstanding',
  'collection_rate',
  'gross_profit',
  'net_profit',
  // charts
  'revenue_expenses',
  'collections',
  'students_trials',
  'leads_by_source',
  'lost_reasons',
  'class_outcomes',
  'teacher_hours',
] as const;
export type DashboardWidget = (typeof DASHBOARD_WIDGETS)[number];

/**
 * Every widget needs ALL of its permissions (the same as the module it reads). The endpoint itself
 * needs `reports.view`. Basic finance (collections, outstanding, ageing, collection rate) needs
 * `reports.financial`; profit and loss (expenses, teacher pay, gross and net profit) needs
 * `reports.profit`, which only the owner holds (D145, D146).
 */
export const DASHBOARD_WIDGET_PERMISSIONS: Record<DashboardWidget, readonly Permission[]> = {
  active_students: ['reports.view', 'sessions.view'],
  new_students: ['reports.view', 'sessions.view'],
  teachers_on_duty: ['reports.view', 'sessions.view'],
  attendance_rate: ['reports.view', 'sessions.view'],
  class_outcomes: ['reports.view', 'sessions.view'],
  trials: ['reports.view', 'leads.view'],
  leads_by_source: ['reports.view', 'leads.view'],
  lost_reasons: ['reports.view', 'leads.view'],
  students_trials: ['reports.view', 'sessions.view', 'leads.view'],
  collected: ['reports.financial', 'invoices.view'],
  outstanding: ['reports.financial', 'invoices.view'],
  collection_rate: ['reports.financial', 'invoices.view'],
  collections: ['reports.financial', 'invoices.view'],
  gross_profit: ['reports.profit'],
  net_profit: ['reports.profit'],
  revenue_expenses: ['reports.profit'],
  // Teacher pay is an expense: owner only (D145, D146).
  teacher_hours: ['reports.profit'],
};

/** The widgets a set of permissions can see, in display order. */
export function visibleWidgets(granted: ReadonlySet<string>): DashboardWidget[] {
  return DASHBOARD_WIDGETS.filter((w) =>
    DASHBOARD_WIDGET_PERMISSIONS[w].every((p) => granted.has(p)),
  );
}

// ------------------------------------------------------------------ KPI values

/** A count with the previous period's value (null when `compare=none`). */
const countKpi = z.object({ value: z.number().int(), previous: z.number().int().nullable() });
/** A ratio 0…1; null when there is nothing to divide (no classes). */
const ratioKpi = z.object({ value: z.number().nullable(), previous: z.number().nullable() });
const moneyKpi = z.object({ value: usdMoneySchema, previous: usdMoneySchema.nullable() });

const trialCounts = z.object({
  booked: z.number().int(),
  attended: z.number().int(),
  converted: z.number().int(),
  /** converted ÷ attended; null when none attended. */
  conversionRate: z.number().nullable(),
});

export const dashboardKpisSchema = z.object({
  /** Students with at least one scheduled class in the period. */
  active_students: countKpi.optional(),
  /** First regular enrolment started in the period. */
  new_students: countKpi.optional(),
  /** Teachers with at least one class in the period. */
  teachers_on_duty: countKpi.optional(),
  trials: z.object({ value: trialCounts, previous: trialCounts.nullable() }).optional(),
  /** taken ÷ (taken + absent). */
  attendance_rate: ratioKpi.optional(),
  /** Payments received in the period (succeeded, net of refunds), converted per payment month. */
  collected: moneyKpi.optional(),
  /** Open invoice balance at the end of the period, and the overdue part of it. */
  outstanding: z
    .object({
      value: z.object({ total: usdMoneySchema, overdue: usdMoneySchema }),
      previous: z.object({ total: usdMoneySchema, overdue: usdMoneySchema }).nullable(),
    })
    .optional(),
  /**
   * D146: of the invoices due in the period, the share paid by its end (applied payments ÷ total,
   * in USD). Null when nothing was due, or when a rate is missing (see `missingRates`).
   */
  collection_rate: ratioKpi.optional(),
  /** Revenue − teacher pay (B123). */
  gross_profit: moneyKpi.optional(),
  /** Revenue − every expense account in the ledger (B123). */
  net_profit: moneyKpi.optional(),
});
export type DashboardKpis = z.infer<typeof dashboardKpisSchema>;

// ------------------------------------------------------------------ series

/** First academy-local day of the bucket (`YYYY-MM-DD`): the x axis. */
const bucketKey = z.string();

export const revenueExpensesPointSchema = z.object({
  bucket: bucketKey,
  revenue: usdMoneySchema,
  teacherPay: usdMoneySchema,
  otherExpenses: usdMoneySchema,
  grossProfit: usdMoneySchema,
  netProfit: usdMoneySchema,
});

export const collectionsPointSchema = z.object({
  bucket: bucketKey,
  collected: usdMoneySchema,
  invoiced: usdMoneySchema,
});

export const AGEING_BANDS = ['d0_30', 'd31_60', 'd61_90', 'd90_plus'] as const;
export type AgeingBand = (typeof AGEING_BANDS)[number];

export const studentsTrialsPointSchema = z.object({
  bucket: bucketKey,
  newStudents: z.number().int(),
  trialsBooked: z.number().int(),
  trialsAttended: z.number().int(),
  trialsConverted: z.number().int(),
});

export const classOutcomesPointSchema = z.object({
  bucket: bucketKey,
  taken: z.number().int(),
  absent: z.number().int(),
  leave: z.number().int(),
  declined: z.number().int(),
  cancelled: z.number().int(),
});

export const teacherHoursPointSchema = z.object({
  bucket: bucketKey,
  /** Paid teaching hours (per-class rounding, B117). */
  hours: z.number(),
  payroll: usdMoneySchema,
});

export const dashboardSeriesSchema = z.object({
  revenue_expenses: z.array(revenueExpensesPointSchema).optional(),
  collections: z
    .object({
      points: z.array(collectionsPointSchema),
      /** Overdue open balance at the end of the period, by days past due. */
      ageing: z.record(z.enum(AGEING_BANDS), usdMoneySchema),
    })
    .optional(),
  students_trials: z.array(studentsTrialsPointSchema).optional(),
  leads_by_source: z
    .array(z.object({ source: z.enum(LEAD_SOURCES), count: z.number().int() }))
    .optional(),
  lost_reasons: z
    .array(z.object({ reason: z.enum(LOST_REASONS), count: z.number().int() }))
    .optional(),
  class_outcomes: z.array(classOutcomesPointSchema).optional(),
  teacher_hours: z.array(teacherHoursPointSchema).optional(),
});
export type DashboardSeries = z.infer<typeof dashboardSeriesSchema>;

// ------------------------------------------------------------------ response

const rangeSchema = z.object({ from: z.string(), to: z.string() });

export const dashboardMetricsSchema = z.object({
  range: rangeSchema.extend({
    bucket: z.enum(DASHBOARD_BUCKETS),
    /** The period compared against (same length, just before); null with `compare=none`. */
    previous: rangeSchema.nullable(),
    /** The academy's zone: day and month boundaries. */
    timezone: z.string(),
  }),
  /** Reporting currency (D144). */
  currency: z.literal('USD'),
  /** The widgets this viewer may see; every other key is absent from `kpis` and `series`. */
  widgets: z.array(z.enum(DASHBOARD_WIDGETS)),
  kpis: dashboardKpisSchema,
  series: dashboardSeriesSchema,
  /** True when any money figure lacks an exchange rate (show the banner, link to the rates). */
  missingRates: z.array(z.object({ currency: z.string(), month: z.string() })),
  generatedAt: z.string(),
});
export type DashboardMetricsDto = z.infer<typeof dashboardMetricsSchema>;

// ------------------------------------------------------------------ recent events (docs/40 §3 row 3)

/** Business events on the dashboard's «Recent events» panel. */
export const DASHBOARD_EVENT_KINDS = [
  'payment_received',
  'payment_refunded',
  'invoice_issued',
  'invoice_voided',
  'lead_converted',
  'trial_booked',
  'payroll_approved',
  'payslip_paid',
  'class_cancelled',
] as const;
export type DashboardEventKind = (typeof DASHBOARD_EVENT_KINDS)[number];

/** Same gate as the widget each kind belongs to: a role sees only events of modules it can view. */
export const DASHBOARD_EVENT_PERMISSIONS: Record<DashboardEventKind, readonly Permission[]> = {
  payment_received: ['reports.financial', 'invoices.view'],
  payment_refunded: ['reports.financial', 'invoices.view'],
  invoice_issued: ['reports.financial', 'invoices.view'],
  invoice_voided: ['reports.financial', 'invoices.view'],
  lead_converted: ['leads.view'],
  trial_booked: ['leads.view'],
  payroll_approved: ['payroll.view'],
  payslip_paid: ['payroll.view'],
  class_cancelled: ['sessions.view'],
};

export const DASHBOARD_EVENT_LABELS: Record<DashboardEventKind, { ar: string; en: string }> = {
  payment_received: { ar: 'تحصيل دفعة', en: 'Payment received' },
  payment_refunded: { ar: 'استرداد دفعة', en: 'Payment refunded' },
  invoice_issued: { ar: 'إصدار فاتورة', en: 'Invoice issued' },
  invoice_voided: { ar: 'إلغاء فاتورة', en: 'Invoice voided' },
  lead_converted: { ar: 'تحويل عميل محتمل إلى طالب', en: 'Lead converted' },
  trial_booked: { ar: 'حجز حصة تجريبية', en: 'Trial booked' },
  payroll_approved: { ar: 'اعتماد مسيّر الرواتب', en: 'Payroll approved' },
  payslip_paid: { ar: 'صرف قسيمة راتب', en: 'Payslip paid' },
  class_cancelled: { ar: 'إلغاء حصة', en: 'Class cancelled' },
};

/** `GET /dashboard/events?limit&before` (`reports.view`; staff only). */
export const dashboardEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** The previous page's `nextBefore`: events strictly older than it. */
  before: z.iso.datetime({ offset: true }).optional(),
});
export type DashboardEventsQuery = z.input<typeof dashboardEventsQuerySchema>;

export const dashboardEventSchema = z.object({
  /** Unique across sources, e.g. `audit:123` or `session:456`. */
  key: z.string(),
  kind: z.enum(DASHBOARD_EVENT_KINDS),
  at: z.string(),
  /** Who did it (staff viewers only; null = the system, e.g. an online payment). */
  actor: z
    .object({ id: z.number().int(), name: z.string(), role: z.string().nullable() })
    .nullable(),
  /** What it is about, for the link: `payment` / `invoice` / `lead` / `payroll_run` / `payslip` / `class_session`. */
  subject: z.object({ type: z.string(), id: z.number().int().nullable() }),
  /**
   * A few safe facts per kind (never the raw audit record): amount + currency (+ method,
   * invoiceId) for payments; number + total + currency for an issued invoice; familyId for a
   * conversion; startsAt + sessionId for a trial; period for payroll; paidOn for a payslip;
   * startsAt + reason for a cancelled class.
   */
  data: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
});
export type DashboardEventDto = z.infer<typeof dashboardEventSchema>;

export const dashboardEventsSchema = z.object({
  events: z.array(dashboardEventSchema),
  /** Send as `before` for the next page; null at the end. */
  nextBefore: z.string().nullable(),
});
export type DashboardEventsDto = z.infer<typeof dashboardEventsSchema>;

/** The event kinds a set of permissions can see. */
export function visibleEventKinds(granted: ReadonlySet<string>): DashboardEventKind[] {
  return DASHBOARD_EVENT_KINDS.filter((k) =>
    DASHBOARD_EVENT_PERMISSIONS[k].every((p) => granted.has(p)),
  );
}
