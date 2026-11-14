import {
  bookedTrialSchema,
  bulkResultSchema,
  crmSettingsSchema,
  leadActivitySchema,
  leadAssigneeSchema,
  leadDetailSchema,
  leadFunnelSchema,
  leadListResponseSchema,
  leadSummarySchema,
  publicCourseSchema,
  type AssignLeadInput,
  type BookedTrialDto,
  type BookTrialInput,
  type BulkAssignLeadsInput,
  type BulkLeadStatusInput,
  type BulkResultDto,
  type ConvertLeadInput,
  type CreateLeadAccountInput,
  type CreateLeadInput,
  type CrmSettingsDto,
  type LeadActivityDto,
  type LeadActivityInput,
  type LeadAssigneeDto,
  type LeadDetailDto,
  type LeadFunnelDto,
  type LeadListQuery,
  type LeadStatusChangeInput,
  type LeadSummaryDto,
  type Paginated,
  type LeadDto,
  type PublicCourseDto,
  type PublicTrialRequestInput,
  type ReferralInput,
  type TrialOutcomeInput,
  type UpdateCrmSettingsInput,
  type UpdateLeadInput,
  trialChecklistItemSchema,
  trialReportSchema,
  type TrialReportDto,
  type TrialChecklistItemDto,
  leadKpisSchema,
  type LeadKpisDto,
  trialTeachersResponseSchema,
  trialOfferSchema,
  myTrialOfferSchema,
  type CreateTrialOfferInput,
  type AssignTrialOfferInput,
  type TrialOfferDto,
  type MyTrialOfferDto,
  type TrialTeachersQuery,
  type TrialTeachersResponse,
} from '@qarabic/shared';
import { z } from 'zod';
import { apiFetch } from './client';
import { toSearchParams } from './people';

/**
 * CRM (N5, apps/api README «Endpoints (N5)»): leads, their workbench, trial and conversion, the
 * referral form, the CRM settings and the public trial form. Contract in `@qarabic/shared` (`crm.ts`).
 */
const one = <T extends z.ZodType>(schema: T) => z.object({ data: schema });
const qs = (query: object) => {
  const s = toSearchParams(query as Record<string, string | number | boolean | undefined>);
  return s ? `?${s}` : '';
};
const detail = one(leadDetailSchema);

export async function fetchLeads(
  query: LeadListQuery,
  signal?: AbortSignal,
): Promise<Paginated<LeadDto>> {
  return apiFetch(`/leads${qs(query)}`, { schema: leadListResponseSchema, signal });
}

export async function fetchLeadSummary(tz: string, signal?: AbortSignal): Promise<LeadSummaryDto> {
  return (await apiFetch(`/leads/summary${qs({ tz })}`, { schema: one(leadSummarySchema), signal }))
    .data;
}

export async function fetchLeadFunnel(
  range: { from: string; to: string },
  signal?: AbortSignal,
): Promise<LeadFunnelDto> {
  return (await apiFetch(`/leads/funnel${qs(range)}`, { schema: one(leadFunnelSchema), signal }))
    .data;
}

export async function fetchLeadAssignees(signal?: AbortSignal): Promise<LeadAssigneeDto[]> {
  return (await apiFetch('/leads/assignees', { schema: one(z.array(leadAssigneeSchema)), signal }))
    .data;
}

export async function fetchLead(id: number, signal?: AbortSignal): Promise<LeadDetailDto> {
  return (await apiFetch(`/leads/${id}`, { schema: detail, signal })).data;
}

export async function createLead(body: CreateLeadInput): Promise<LeadDetailDto> {
  return (await apiFetch('/leads', { method: 'POST', body, schema: detail })).data;
}

export async function updateLead(id: number, body: UpdateLeadInput): Promise<LeadDetailDto> {
  return (await apiFetch(`/leads/${id}`, { method: 'PATCH', body, schema: detail })).data;
}

export async function addLeadActivity(
  id: number,
  body: LeadActivityInput,
): Promise<LeadActivityDto> {
  return (
    await apiFetch(`/leads/${id}/activities`, {
      method: 'POST',
      body,
      schema: one(leadActivitySchema),
    })
  ).data;
}

export async function assignLead(id: number, body: AssignLeadInput): Promise<LeadDetailDto> {
  return (await apiFetch(`/leads/${id}/assign`, { method: 'POST', body, schema: detail })).data;
}

export async function changeLeadStatus(
  id: number,
  body: LeadStatusChangeInput,
): Promise<LeadDetailDto> {
  return (await apiFetch(`/leads/${id}/status`, { method: 'POST', body, schema: detail })).data;
}

export async function bulkAssignLeads(body: BulkAssignLeadsInput): Promise<BulkResultDto> {
  return (
    await apiFetch('/leads/bulk/assign', { method: 'POST', body, schema: one(bulkResultSchema) })
  ).data;
}

export async function bulkLeadStatus(body: BulkLeadStatusInput): Promise<BulkResultDto> {
  return (
    await apiFetch('/leads/bulk/status', { method: 'POST', body, schema: one(bulkResultSchema) })
  ).data;
}

export async function createLeadAccount(
  id: number,
  body: CreateLeadAccountInput,
): Promise<LeadDetailDto> {
  return (await apiFetch(`/leads/${id}/account`, { method: 'POST', body, schema: detail })).data;
}

export async function bookTrial(
  id: number,
  body: BookTrialInput,
): Promise<{ lead: LeadDetailDto; trial: BookedTrialDto }> {
  const res = await apiFetch(`/leads/${id}/trials`, {
    method: 'POST',
    body,
    schema: z.object({ data: leadDetailSchema, meta: z.object({ trial: bookedTrialSchema }) }),
  });
  return { lead: res.data, trial: res.meta.trial };
}

/** T4: the lead's trial reports (the convert form starts from them). */
export async function fetchLeadTrialReports(
  leadId: number,
  signal?: AbortSignal,
): Promise<TrialReportDto[]> {
  return (
    await apiFetch(`/leads/${leadId}/trial-reports`, {
      schema: z.object({ data: z.array(trialReportSchema) }),
      signal,
    })
  ).data;
}

/** T4: today's trial classes for monitors and customer service (docs/33 §3.5). */
export async function fetchTrialsToday(
  query: { date?: string; tz?: string },
  signal?: AbortSignal,
): Promise<TrialChecklistItemDto[]> {
  return (
    await apiFetch(`/trials/today${qs(query)}`, {
      schema: z.object({ data: z.array(trialChecklistItemSchema) }),
      signal,
    })
  ).data;
}

/** T5: the CRM rates for a period (docs/33 §6). */
export async function fetchLeadKpis(
  query: { from?: string; to?: string },
  signal?: AbortSignal,
): Promise<LeadKpisDto> {
  return (await apiFetch(`/leads/kpis${qs(query)}`, { schema: one(leadKpisSchema), signal })).data;
}

/** T2: the teachers for a trial at this time, eligible ones ranked (docs/33 §4.1–4.2). */
export async function fetchTrialTeachers(
  id: number,
  query: TrialTeachersQuery,
  signal?: AbortSignal,
): Promise<TrialTeachersResponse> {
  return apiFetch(`/leads/${id}/trial-teachers${qs(query)}`, {
    schema: trialTeachersResponseSchema,
    signal,
  });
}

// ------------------------------------------------------------------ T3 open offers

const offerOne = one(trialOfferSchema);

/** T3: offer the trial to the eligible teachers (or a shortlist). */
export async function createTrialOffer(
  leadId: number,
  body: CreateTrialOfferInput,
): Promise<TrialOfferDto> {
  return (
    await apiFetch(`/leads/${leadId}/trial-offers`, { method: 'POST', body, schema: offerOne })
  ).data;
}

export async function fetchLeadTrialOffers(
  leadId: number,
  signal?: AbortSignal,
): Promise<TrialOfferDto[]> {
  return (
    await apiFetch(`/leads/${leadId}/trial-offers`, {
      schema: z.object({ data: z.array(trialOfferSchema) }),
      signal,
    })
  ).data;
}

export async function trialOfferAction(
  id: number,
  action: 'assign' | 'resend' | 'cancel',
  body: AssignTrialOfferInput | { expiresInMinutes?: number } | { reason?: string | null } = {},
): Promise<TrialOfferDto> {
  return (
    await apiFetch(`/trial-offers/${id}/${action}`, { method: 'POST', body, schema: offerOne })
  ).data;
}

/** The teacher's offers («عروض الحصص التجريبية»): no family data. */
export async function fetchMyTrialOffers(signal?: AbortSignal): Promise<MyTrialOfferDto[]> {
  return (
    await apiFetch('/me/trial-offers', {
      schema: z.object({ data: z.array(myTrialOfferSchema) }),
      signal,
    })
  ).data;
}

export async function answerMyTrialOffer(
  id: number,
  answer: 'accept' | 'decline',
): Promise<MyTrialOfferDto> {
  return (
    await apiFetch(`/me/trial-offers/${id}/${answer}`, {
      method: 'POST',
      body: {},
      schema: one(myTrialOfferSchema),
    })
  ).data;
}

export async function recordTrialOutcome(
  id: number,
  body: TrialOutcomeInput,
): Promise<LeadDetailDto> {
  return (await apiFetch(`/leads/${id}/trial-outcome`, { method: 'POST', body, schema: detail }))
    .data;
}

export async function convertLead(id: number, body: ConvertLeadInput): Promise<LeadDetailDto> {
  return (await apiFetch(`/leads/${id}/convert`, { method: 'POST', body, schema: detail })).data;
}

export async function sendReferral(body: ReferralInput): Promise<void> {
  await apiFetch('/me/referrals', { method: 'POST', body });
}

export async function fetchCrmSettings(signal?: AbortSignal): Promise<CrmSettingsDto> {
  return (await apiFetch('/settings/crm', { schema: one(crmSettingsSchema), signal })).data;
}

export async function updateCrmSettings(body: UpdateCrmSettingsInput): Promise<CrmSettingsDto> {
  return (await apiFetch('/settings/crm', { method: 'PUT', body, schema: one(crmSettingsSchema) }))
    .data;
}

// ------------------------------------------------------------------ public (no login)

export async function fetchPublicCourses(signal?: AbortSignal): Promise<PublicCourseDto[]> {
  return (await apiFetch('/public/courses', { schema: one(z.array(publicCourseSchema)), signal }))
    .data;
}

/** The public trial form; `website` is the honeypot humans leave empty. */
export async function sendTrialRequest(
  body: PublicTrialRequestInput & { website?: string },
): Promise<void> {
  await apiFetch('/public/trial-requests', { method: 'POST', body });
}

export const crmKeys = {
  all: ['crm'] as const,
  leads: (query: unknown) => ['crm', 'leads', query] as const,
  summary: (tz: string) => ['crm', 'summary', tz] as const,
  funnel: (range: unknown) => ['crm', 'funnel', range] as const,
  assignees: ['crm', 'assignees'] as const,
  lead: (id: number) => ['crm', 'lead', id] as const,
  trialTeachers: (id: number, query: unknown) => ['crm', 'trial-teachers', id, query] as const,
  trialOffers: (leadId: number) => ['crm', 'trial-offers', leadId] as const,
  myTrialOffers: ['crm', 'my-trial-offers'] as const,
  settings: ['crm', 'settings'] as const,
  trialsToday: (query: unknown) => ['crm', 'trials-today', query] as const,
  trialReports: (leadId: number) => ['crm', 'trial-reports', leadId] as const,
  kpis: (query: unknown) => ['crm', 'kpis', query] as const,
  publicCourses: ['public', 'courses'] as const,
};
