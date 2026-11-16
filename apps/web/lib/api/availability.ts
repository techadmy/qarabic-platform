import {
  availabilityChangeSchema,
  type AvailabilityChangeDto,
  type AvailabilityChangeStatus,
} from '@qarabic/shared';
import { z } from 'zod';
import { apiFetch } from './client';

/**
 * A1 availability changes (docs/42 §4, D148, B131): a teacher's request to change their working
 * hours or unavailable times, decided by staff with `schedule.manage` (never their own).
 */
const one = z.object({ data: availabilityChangeSchema });

export async function fetchAvailabilityChanges(
  query: { status?: AvailabilityChangeStatus; teacherId?: number } = {},
  signal?: AbortSignal,
): Promise<AvailabilityChangeDto[]> {
  const s = new URLSearchParams();
  if (query.status) s.set('status', query.status);
  if (query.teacherId) s.set('teacherId', String(query.teacherId));
  const qs = s.toString();
  return (
    await apiFetch(`/availability-changes${qs ? `?${qs}` : ''}`, {
      schema: z.object({ data: z.array(availabilityChangeSchema) }),
      signal,
    })
  ).data;
}

export async function approveAvailabilityChange(
  id: number,
  body: { effectiveFrom?: string; note?: string } = {},
): Promise<AvailabilityChangeDto> {
  return (
    await apiFetch(`/availability-changes/${id}/approve`, { method: 'POST', body, schema: one })
  ).data;
}

export async function rejectAvailabilityChange(
  id: number,
  reason: string,
): Promise<AvailabilityChangeDto> {
  return (
    await apiFetch(`/availability-changes/${id}/reject`, {
      method: 'POST',
      body: { reason },
      schema: one,
    })
  ).data;
}

export async function withdrawAvailabilityChange(id: number): Promise<AvailabilityChangeDto> {
  return (await apiFetch(`/availability-changes/${id}/withdraw`, { method: 'POST', schema: one }))
    .data;
}

export const availabilityKeys = {
  all: ['availability-changes'] as const,
  list: (query: object) => ['availability-changes', query] as const,
};
