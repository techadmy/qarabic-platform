import { dashboardMetricsSchema, type DashboardMetricsDto } from '@qarabic/shared';
import { z } from 'zod';
import { apiFetch } from './client';

export interface DashboardMetricsQuery {
  from: string;
  to: string;
  compare: boolean;
  bucket: 'day' | 'week' | 'month';
}

/** D2: the dashboard's KPIs and series for a range (docs/40 §5, `GET /dashboard/metrics`). */
export async function fetchDashboardMetrics(
  q: DashboardMetricsQuery,
  signal?: AbortSignal,
): Promise<DashboardMetricsDto> {
  // The API compares by default: say «none» when the switch is off.
  const qs = new URLSearchParams({
    from: q.from,
    to: q.to,
    bucket: q.bucket,
    compare: q.compare ? 'prev' : 'none',
  });
  return (
    await apiFetch(`/dashboard/metrics?${qs}`, {
      schema: z.object({ data: dashboardMetricsSchema }),
      signal,
    })
  ).data;
}

export const dashboardKeys = {
  all: ['dashboard'] as const,
  metrics: (q: DashboardMetricsQuery) => ['dashboard', 'metrics', q] as const,
};
