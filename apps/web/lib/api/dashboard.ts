import { apiFetch } from './client';
import { z } from 'zod';
import {
  dashboardMetricsSchema,
  type DashboardMetricsDto,
  type DashboardMetricsQuery,
} from '@/lib/dashboard/metrics';

/** D2: the dashboard's KPIs and series for a range (docs/40 §5). */
export async function fetchDashboardMetrics(
  q: DashboardMetricsQuery,
  signal?: AbortSignal,
): Promise<DashboardMetricsDto> {
  const qs = new URLSearchParams({ from: q.from, to: q.to, bucket: q.bucket });
  if (q.compare) qs.set('compare', '1');
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
