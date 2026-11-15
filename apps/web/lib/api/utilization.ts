import {
  freeCapacitySchema,
  utilizationReportSchema,
  type FreeCapacityDto,
  type FreeCapacityQuery,
  type UtilizationQuery,
} from '@qarabic/shared';
import { z } from 'zod';
import { apiFetch } from './client';

/**
 * Per-day totals for the busiest / emptiest days (R1 follow-up). Asked of backend for
 * `utilizationReportSchema` (#118 follow-up); optional here until it is in `@qarabic/shared`.
 */
export const utilizationDaySchema = z.object({
  date: z.string(),
  weekday: z.number().int().min(1).max(7),
  availableHours: z.number(),
  bookedHours: z.number(),
  freeHours: z.number(),
  outsideHours: z.number(),
  utilization: z.number().nullable(),
  classes: z.number().int(),
});
export type UtilizationDayDto = z.infer<typeof utilizationDaySchema>;
const reportSchema = utilizationReportSchema.extend({
  days: z.array(utilizationDaySchema).optional(),
});
export type UtilizationReport = z.infer<typeof reportSchema>;

/** R1 (docs/42 §5, D148): teacher utilization and the free-capacity heatmap. */
function qs(query: Record<string, unknown>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    s.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const out = s.toString();
  return out ? `?${out}` : '';
}

export async function fetchUtilization(
  query: UtilizationQuery,
  signal?: AbortSignal,
): Promise<UtilizationReport> {
  return (
    await apiFetch(`/reports/teacher-utilization${qs(query as Record<string, unknown>)}`, {
      schema: z.object({ data: reportSchema }),
      signal,
    })
  ).data;
}

export async function fetchFreeCapacity(
  query: FreeCapacityQuery,
  signal?: AbortSignal,
): Promise<FreeCapacityDto> {
  return (
    await apiFetch(`/reports/free-capacity${qs(query as Record<string, unknown>)}`, {
      schema: z.object({ data: freeCapacitySchema }),
      signal,
    })
  ).data;
}

export const utilizationKeys = {
  all: ['utilization'] as const,
  report: (q: object) => ['utilization', 'report', q] as const,
  capacity: (q: object) => ['utilization', 'capacity', q] as const,
};
