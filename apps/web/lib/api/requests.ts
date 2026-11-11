import {
  requestCountsSchema,
  sessionRequestListResponseSchema,
  sessionRequestSchema,
  type ApproveSessionRequestInput,
  type CreateSessionRequestInput,
  type Paginated,
  type RejectSessionRequestInput,
  type RequestCountsDto,
  type SessionRequestDto,
  type SessionRequestListQuery,
} from '@qarabic/shared';
import { z } from 'zod';
import { apiFetch } from './client';
import { toSearchParams } from './people';

/** Class requests (N2): `/session-requests` — leave, reschedule, advance and extra. */
const one = <T extends z.ZodType>(schema: T) => z.object({ data: schema });

export async function fetchRequests(
  query: SessionRequestListQuery,
  signal?: AbortSignal,
): Promise<Paginated<SessionRequestDto>> {
  const qs = toSearchParams(query as Record<string, string | number | boolean | undefined>);
  return apiFetch(`/session-requests${qs ? `?${qs}` : ''}`, {
    schema: sessionRequestListResponseSchema,
    signal,
  });
}

export async function fetchRequestCounts(signal?: AbortSignal): Promise<RequestCountsDto> {
  return (
    await apiFetch('/session-requests?countOnly=1', { schema: one(requestCountsSchema), signal })
  ).data;
}

export async function createRequest(body: CreateSessionRequestInput): Promise<SessionRequestDto> {
  return (
    await apiFetch('/session-requests', {
      method: 'POST',
      body,
      schema: one(sessionRequestSchema),
    })
  ).data;
}

export async function approveRequest(
  id: number,
  body: ApproveSessionRequestInput,
): Promise<SessionRequestDto> {
  return (
    await apiFetch(`/session-requests/${id}/approve`, {
      method: 'POST',
      body,
      schema: one(sessionRequestSchema),
    })
  ).data;
}

export async function rejectRequest(
  id: number,
  body: RejectSessionRequestInput,
): Promise<SessionRequestDto> {
  return (
    await apiFetch(`/session-requests/${id}/reject`, {
      method: 'POST',
      body,
      schema: one(sessionRequestSchema),
    })
  ).data;
}

export async function cancelRequest(id: number): Promise<SessionRequestDto> {
  return (
    await apiFetch(`/session-requests/${id}/cancel`, {
      method: 'POST',
      schema: one(sessionRequestSchema),
    })
  ).data;
}

export const requestKeys = {
  all: ['requests'] as const,
  list: (query: unknown) => ['requests', 'list', query] as const,
  counts: ['requests', 'counts'] as const,
};
