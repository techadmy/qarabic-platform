import {
  calendarBackgroundSchema,
  calendarEventsSchema,
  seriesChangeSchema,
  sessionSchema,
  type CalendarBackgroundDto,
  type CalendarBackgroundQuery,
  type CalendarEventsDto,
  type CalendarEventsQuery,
  type SeriesChangeDto,
  type SessionDto,
  type UpdateSessionInput,
} from '@qarabic/shared';
import { z } from 'zod';
import { apiFetch } from './client';

/**
 * The calendar module (C1/C2, docs/42 §3, D148): the classes of a range as events, what to shade
 * behind them, and the series edit. Lists go as repeated keys (`teacherIds=1&teacherIds=2`).
 */
function qs(query: Record<string, string | number | readonly (string | number)[] | undefined>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) s.append(k, String(x));
    else s.set(k, String(v));
  }
  return s.toString();
}

export async function fetchCalendarEvents(
  query: CalendarEventsQuery,
  signal?: AbortSignal,
): Promise<CalendarEventsDto> {
  return (
    await apiFetch(`/calendar/events?${qs(query as never)}`, {
      schema: z.object({ data: calendarEventsSchema }),
      signal,
    })
  ).data;
}

export async function fetchCalendarBackground(
  query: CalendarBackgroundQuery,
  signal?: AbortSignal,
): Promise<CalendarBackgroundDto> {
  return (
    await apiFetch(`/calendar/background?${qs(query as never)}`, {
      schema: z.object({ data: calendarBackgroundSchema }),
      signal,
    })
  ).data;
}

/**
 * `PATCH /sessions/:id` from the calendar: with `scope: 'following'` the weekly slot moves from this
 * class on and the answer says which slot closed and which opened (`series`).
 */
export async function moveSession(
  id: number,
  body: UpdateSessionInput,
): Promise<{ session: SessionDto; series: SeriesChangeDto | null }> {
  const res = await apiFetch(`/sessions/${id}`, {
    method: 'PATCH',
    body,
    schema: z.object({ data: sessionSchema, series: seriesChangeSchema.optional() }),
  });
  return { session: res.data, series: res.series ?? null };
}

export const calendarKeys = {
  all: ['calendar'] as const,
  events: (query: unknown) => ['calendar', 'events', query] as const,
  background: (query: unknown) => ['calendar', 'background', query] as const,
};
