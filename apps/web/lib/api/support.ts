import {
  feedbackSummarySchema,
  inboxResponseSchema,
  myRequestsResponseSchema,
  parentHomeSchema,
  personRefSchema,
  supportPeopleSchema,
  supportReportSchema,
  supportSummarySchema,
  ticketCommentSchema,
  ticketDetailSchema,
  ticketListResponseSchema,
  type ConfirmTicketInput,
  type CreateTicketInput,
  type FeedbackSummaryDto,
  type InboxQuery,
  type InboxResponse,
  type MyRequestsQuery,
  type MyRequestsResponse,
  type ParentHomeDto,
  type PersonRef,
  type SupportPeopleDto,
  type SupportSettingsDto,
  type SupportReportDto,
  type SupportSummaryDto,
  type TicketCommentDto,
  type TicketDetailDto,
  type TicketListQuery,
  type TicketListResponse,
  type TicketQueue,
  type UpdateSupportSettingsInput,
  type UpdateTicketInput,
} from '@qarabic/shared';
import { z } from 'zod';
import { API_URL, apiFetch } from './client';
import { toSearchParams } from './people';

/**
 * Support centre (N4): «تواصل معنا» tickets (`/feedback/…`), the staff inbox and «طلباتي»
 * (`/support/…`), the support settings and the parent home. Contract in `@qarabic/shared`.
 */
const one = <T extends z.ZodType>(schema: T) => z.object({ data: schema });
const qs = (query: object) => {
  const s = toSearchParams(query as Record<string, string | number | boolean | undefined>);
  return s ? `?${s}` : '';
};

// ------------------------------------------------------------------ tickets

export async function fetchFeedbackSummary(signal?: AbortSignal): Promise<FeedbackSummaryDto> {
  return (await apiFetch('/feedback/summary', { schema: one(feedbackSummarySchema), signal })).data;
}

export async function fetchTickets(
  query: TicketListQuery,
  signal?: AbortSignal,
): Promise<TicketListResponse> {
  return apiFetch(`/feedback/tickets${qs(query)}`, { schema: ticketListResponseSchema, signal });
}

export async function fetchTicket(id: number, signal?: AbortSignal): Promise<TicketDetailDto> {
  return (await apiFetch(`/feedback/tickets/${id}`, { schema: one(ticketDetailSchema), signal }))
    .data;
}

/** A new ticket: multipart when there are images (the screenshot and up to 3 attachments). */
export async function createTicket(
  input: CreateTicketInput,
  files: { screenshot?: Blob | null; attachments?: File[] } = {},
): Promise<TicketDetailDto> {
  const images = !!files.screenshot || !!files.attachments?.length;
  let body: unknown = input;
  if (images) {
    const form = new FormData();
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || value === null) continue;
      form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    if (files.screenshot) form.append('screenshot', files.screenshot, 'screenshot.png');
    for (const f of files.attachments ?? []) form.append('attachments', f, f.name);
    body = form;
  }
  return (
    await apiFetch('/feedback/tickets', { method: 'POST', body, schema: one(ticketDetailSchema) })
  ).data;
}

export async function updateTicket(id: number, body: UpdateTicketInput): Promise<TicketDetailDto> {
  return (
    await apiFetch(`/feedback/tickets/${id}`, {
      method: 'PATCH',
      body,
      schema: one(ticketDetailSchema),
    })
  ).data;
}

export async function addTicketComment(
  id: number,
  input: { body: string; internal?: boolean },
  files: File[] = [],
): Promise<TicketCommentDto> {
  let body: unknown = input;
  if (files.length) {
    const form = new FormData();
    form.append('body', input.body);
    if (input.internal) form.append('internal', '1');
    for (const f of files) form.append('attachments', f, f.name);
    body = form;
  }
  return (
    await apiFetch(`/feedback/tickets/${id}/comments`, {
      method: 'POST',
      body,
      schema: one(ticketCommentSchema),
    })
  ).data;
}

export async function confirmTicket(
  id: number,
  body: ConfirmTicketInput,
): Promise<TicketDetailDto> {
  return (
    await apiFetch(`/feedback/tickets/${id}/confirm`, {
      method: 'POST',
      body,
      schema: one(ticketDetailSchema),
    })
  ).data;
}

export async function markTicketSeen(id: number): Promise<void> {
  await apiFetch(`/feedback/tickets/${id}/seen`, { method: 'POST' });
}

export async function fetchTriagers(signal?: AbortSignal): Promise<PersonRef[]> {
  return (await apiFetch('/feedback/assignees', { schema: one(z.array(personRefSchema)), signal }))
    .data;
}

/** Private file behind the session (an `<img src>` sends the cookie on the same site). */
export const attachmentSrc = (url: string) => `${API_URL}${url}`;

// ------------------------------------------------------------------ inbox, «طلباتي»

export async function fetchInbox(query: InboxQuery, signal?: AbortSignal): Promise<InboxResponse> {
  return apiFetch(`/support/inbox${qs(query)}`, { schema: inboxResponseSchema, signal });
}

export async function fetchSupportSummary(signal?: AbortSignal): Promise<SupportSummaryDto> {
  return (await apiFetch('/support/summary', { schema: one(supportSummarySchema), signal })).data;
}

export async function fetchQueueAssignees(
  queue: TicketQueue,
  signal?: AbortSignal,
): Promise<PersonRef[]> {
  return (
    await apiFetch(`/support/assignees?queue=${queue}`, {
      schema: one(z.array(personRefSchema)),
      signal,
    })
  ).data;
}

export async function fetchSupportPeople(
  query: { familyId?: number; teacherId?: number },
  signal?: AbortSignal,
): Promise<SupportPeopleDto> {
  return (
    await apiFetch(`/support/people${qs(query)}`, { schema: one(supportPeopleSchema), signal })
  ).data;
}

export async function takeTicket(id: number): Promise<TicketDetailDto> {
  return (
    await apiFetch(`/support/tickets/${id}/take`, {
      method: 'POST',
      schema: one(ticketDetailSchema),
    })
  ).data;
}

export async function fetchMine(
  query: MyRequestsQuery,
  signal?: AbortSignal,
): Promise<MyRequestsResponse> {
  return apiFetch(`/support/mine${qs(query)}`, { schema: myRequestsResponseSchema, signal });
}

// ------------------------------------------------------------------ settings, parent home

export async function fetchSupportSettings(signal?: AbortSignal): Promise<SupportSettingsDto> {
  return ((await apiFetch('/settings/support', { signal })) as { data: SupportSettingsDto }).data;
}

export async function updateSupportSettings(
  body: UpdateSupportSettingsInput,
): Promise<SupportSettingsDto> {
  return (
    (await apiFetch('/settings/support', { method: 'PUT', body })) as {
      data: SupportSettingsDto;
    }
  ).data;
}

export async function fetchParentHome(signal?: AbortSignal): Promise<ParentHomeDto> {
  return (await apiFetch('/parent/home', { schema: one(parentHomeSchema), signal })).data;
}

/** S4: the support report for a period (academy days). */
export async function fetchSupportReport(
  query: { from: string; to: string },
  signal?: AbortSignal,
): Promise<SupportReportDto> {
  const qs = new URLSearchParams(query).toString();
  return (await apiFetch(`/support/reports?${qs}`, { schema: one(supportReportSchema), signal }))
    .data;
}

export const supportKeys = {
  all: ['support'] as const,
  feedbackSummary: ['support', 'feedback-summary'] as const,
  summary: ['support', 'summary'] as const,
  tickets: (query: unknown) => ['support', 'tickets', query] as const,
  ticket: (id: number) => ['support', 'ticket', id] as const,
  triagers: ['support', 'triagers'] as const,
  inbox: (query: unknown) => ['support', 'inbox', query] as const,
  assignees: (queue: string) => ['support', 'assignees', queue] as const,
  people: (query: unknown) => ['support', 'people', query] as const,
  mine: (query: unknown) => ['support', 'mine', query] as const,
  settings: ['support', 'settings'] as const,
  report: (query: unknown) => ['support', 'report', query] as const,
  parentHome: ['support', 'parent-home'] as const,
};
