import {
  freeCapacitySchema,
  utilizationReportSchema,
  type FreeCapacityDto,
  type FreeCapacityQuery,
  type UtilizationQuery,
  type UtilizationReportDto,
} from '@qarabic/shared';
import { z } from 'zod';
import { apiFetch } from './client';

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
): Promise<UtilizationReportDto> {
  return (
    await apiFetch(`/reports/teacher-utilization${qs(query as Record<string, unknown>)}`, {
      schema: z.object({ data: utilizationReportSchema }),
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
