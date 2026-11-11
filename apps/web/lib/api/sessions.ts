import {
  boardSchema,
  generateResultSchema,
  sessionDetailSchema,
  sessionListResponseSchema,
  sessionSchema,
  sessionSettingsSchema,
  zoomHostSchema,
  zoomJoinSchema,
  zoomStartSchema,
  type BoardDto,
  type CreateZoomHostInput,
  type GenerateResultDto,
  type GenerateSessionsInput,
  type Paginated,
  type SessionDetailDto,
  type SessionDto,
  type SessionListQuery,
  type SessionSettingsDto,
  type TransitionInput,
  type UpdateSessionInput,
  type UpdateSessionSettingsInput,
  type UpdateZoomHostInput,
  type ZoomHostDto,
} from '@qarabic/shared';
import { z } from 'zod';
import { API_PREFIX, API_URL, ApiError, apiFetch } from './client';
import { toSearchParams } from './people';

/**
 * Class endpoints (N2): the class list, the Today board, one class with its timeline, the state
 * machine transitions, meeting links, the generator, class rules and Zoom hosts.
 */
type Query = Record<string, string | number | boolean | undefined>;
const one = <T extends z.ZodType>(schema: T) => z.object({ data: schema });

export async function fetchSessions(
  query: SessionListQuery,
  signal?: AbortSignal,
): Promise<Paginated<SessionDto>> {
  const { stage, kind, ...rest } = query;
  const qs = toSearchParams({
    ...(rest as Query),
    stage: Array.isArray(stage) ? stage.join(',') : (stage as string | undefined),
    kind: Array.isArray(kind) ? kind.join(',') : (kind as string | undefined),
  });
  return apiFetch(`/sessions${qs ? `?${qs}` : ''}`, { schema: sessionListResponseSchema, signal });
}

/**
 * `GET /sessions/board`. Polled every 15 s with `since=cursor`: the answer holds every counter and
 * only the rows changed since the cursor. The API also sends a weak `ETag`; the browser's HTTP
 * cache revalidates the same URL with it (`Cache-Control: no-cache`) and turns a 304 into the
 * cached body, so the client sends no `If-None-Match` of its own (the API's CORS list does not
 * allow that header).
 */
export async function fetchBoard(
  query: { date?: string; tz?: string; since?: string },
  signal?: AbortSignal,
): Promise<BoardDto> {
  const qs = toSearchParams(query);
  const res = await fetch(`${API_URL}${API_PREFIX}/sessions/board${qs ? `?${qs}` : ''}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
    cache: 'no-cache',
    signal,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return one(boardSchema).parse(data).data;
}

export async function fetchSession(id: number, signal?: AbortSignal): Promise<SessionDetailDto> {
  return (await apiFetch(`/sessions/${id}`, { schema: one(sessionDetailSchema), signal })).data;
}

export async function transitionSession(id: number, body: TransitionInput): Promise<SessionDto> {
  return (
    await apiFetch(`/sessions/${id}/transitions`, {
      method: 'POST',
      body,
      schema: one(sessionSchema),
    })
  ).data;
}

export async function updateSession(id: number, body: UpdateSessionInput): Promise<SessionDto> {
  return (await apiFetch(`/sessions/${id}`, { method: 'PATCH', body, schema: one(sessionSchema) }))
    .data;
}

export async function zoomLink(id: number, as: 'start' | 'join'): Promise<string> {
  if (as === 'start') {
    return (await apiFetch(`/sessions/${id}/zoom/start`, { schema: one(zoomStartSchema) })).data
      .startUrl;
  }
  return (await apiFetch(`/sessions/${id}/zoom/join`, { schema: one(zoomJoinSchema) })).data
    .joinUrl;
}

export async function retryZoom(id: number): Promise<SessionDto> {
  return (
    await apiFetch(`/sessions/${id}/zoom/retry`, { method: 'POST', schema: one(sessionSchema) })
  ).data;
}

export async function generateSessions(body: GenerateSessionsInput): Promise<GenerateResultDto> {
  return (
    await apiFetch('/sessions/generate', {
      method: 'POST',
      body,
      schema: one(generateResultSchema),
    })
  ).data;
}

export async function fetchSessionSettings(signal?: AbortSignal): Promise<SessionSettingsDto> {
  return (await apiFetch('/settings/sessions', { schema: one(sessionSettingsSchema), signal }))
    .data;
}

export async function updateSessionSettings(
  body: UpdateSessionSettingsInput,
): Promise<SessionSettingsDto> {
  return (
    await apiFetch('/settings/sessions', {
      method: 'PUT',
      body,
      schema: one(sessionSettingsSchema),
    })
  ).data;
}

export async function fetchZoomHosts(signal?: AbortSignal): Promise<ZoomHostDto[]> {
  return (await apiFetch('/zoom-hosts', { schema: one(z.array(zoomHostSchema)), signal })).data;
}

export async function createZoomHost(body: CreateZoomHostInput): Promise<ZoomHostDto> {
  return (await apiFetch('/zoom-hosts', { method: 'POST', body, schema: one(zoomHostSchema) }))
    .data;
}

export async function updateZoomHost(id: number, body: UpdateZoomHostInput): Promise<ZoomHostDto> {
  return (
    await apiFetch(`/zoom-hosts/${id}`, { method: 'PATCH', body, schema: one(zoomHostSchema) })
  ).data;
}

export const sessionKeys = {
  all: ['sessions'] as const,
  board: (date: string, tz: string) => ['sessions', 'board', date, tz] as const,
  list: (query: unknown) => ['sessions', 'list', query] as const,
  detail: (id: number) => ['sessions', 'detail', id] as const,
  settings: ['sessions', 'settings'] as const,
  zoomHosts: ['sessions', 'zoom-hosts'] as const,
};
