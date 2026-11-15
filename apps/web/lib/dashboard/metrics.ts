import { z } from 'zod';

/**
 * `GET /dashboard/metrics` (docs/40 §5 D1, D144) as the web reads it. Kept in this one file until
 * the API's shared zod schemas land in `@qarabic/shared`; then this file re-exports those.
 *
 * Money is a decimal string in USD (D144: each amount converted at the monthly rate of the month
 * it happened). A point or KPI without a rate for one of its currencies says `missingRate`: the web
 * warns, never shows a silent 0. A KPI or series the viewer may not see is `null` (the API applies
 * each module's own permission, docs/40 §2.2).
 */
const money = z.string();
const count = z.number();

export const numberKpiSchema = z.object({ value: count, previous: count.nullable() });
export const moneyKpiSchema = z.object({
  value: money,
  previous: money.nullable(),
  missingRate: z.boolean().default(false),
});

export const dashboardMetricsSchema = z.object({
  range: z.object({
    from: z.string(),
    to: z.string(),
    bucket: z.enum(['day', 'week', 'month']),
  }),
  previous: z.object({ from: z.string(), to: z.string() }).nullable(),
  currency: z.literal('USD'),
  kpis: z.object({
    activeStudents: numberKpiSchema.nullable(),
    newStudents: numberKpiSchema.nullable(),
    teachersOnDuty: numberKpiSchema.nullable(),
    trials: z
      .object({
        booked: numberKpiSchema,
        attended: numberKpiSchema,
        converted: numberKpiSchema,
        /** converted ÷ attended, 0–100; null when no trial was attended. */
        conversionPct: z.number().nullable(),
      })
      .nullable(),
    collected: moneyKpiSchema.nullable(),
    outstanding: moneyKpiSchema.extend({ overdue: money }).nullable(),
    grossProfit: moneyKpiSchema.nullable(),
    /** taken ÷ (taken + absent), 0–100. */
    attendanceRate: numberKpiSchema.nullable(),
  }),
  series: z.object({
    finance: z
      .array(
        z.object({
          bucket: z.string(),
          revenue: money,
          expenses: money,
          profit: money,
          missingRate: z.boolean().default(false),
        }),
      )
      .nullable(),
    collections: z
      .array(
        z.object({
          bucket: z.string(),
          collected: money,
          invoiced: money,
          missingRate: z.boolean().default(false),
        }),
      )
      .nullable(),
    ageing: z.object({ d0_30: money, d31_60: money, d61_90: money, d90: money }).nullable(),
    growth: z
      .array(z.object({ bucket: z.string(), newStudents: count, trials: count, converted: count }))
      .nullable(),
    leadSources: z.array(z.object({ source: z.string(), count })).nullable(),
    lostReasons: z.array(z.object({ reason: z.string(), count })).nullable(),
    outcomes: z
      .array(
        z.object({
          bucket: z.string(),
          taken: count,
          absent: count,
          leave: count,
          declined: count,
          cancelled: count,
        }),
      )
      .nullable(),
    teacherHours: z
      .array(z.object({ bucket: z.string(), hours: count, payroll: money }))
      .nullable(),
  }),
});
export type DashboardMetricsDto = z.infer<typeof dashboardMetricsSchema>;

export type DashboardMetricsQuery = {
  from: string;
  to: string;
  compare: boolean;
  bucket: 'day' | 'week' | 'month';
};
