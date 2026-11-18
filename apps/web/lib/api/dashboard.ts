import {
  dashboardEventsSchema,
  dashboardMetricsSchema,
  type DashboardEventsDto,
  type DashboardMetricsDto,
} from '@qarabic/shared';
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

/** D3 «Recent events» (docs/40 §3 row 3, `GET /dashboard/events`): newest first, paged by `before`. */
export async function fetchDashboardEvents(
  q: { limit: number; before?: string | null },
  signal?: AbortSignal,
): Promise<DashboardEventsDto> {
  const qs = new URLSearchParams({ limit: String(q.limit) });
  if (q.before) qs.set('before', q.before);
  return (
    await apiFetch(`/dashboard/events?${qs}`, {
      schema: z.object({ data: dashboardEventsSchema }),
      signal,
    })
  ).data;
}

export const dashboardKeys = {
  all: ['dashboard'] as const,
  metrics: (q: DashboardMetricsQuery) => ['dashboard', 'metrics', q] as const,
  events: ['dashboard', 'events'] as const,
};
