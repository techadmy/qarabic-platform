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
  leadKpisSchema,
  type LeadKpisDto,
  trialTeachersResponseSchema,
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
  settings: ['crm', 'settings'] as const,
  kpis: (query: unknown) => ['crm', 'kpis', query] as const,
  publicCourses: ['public', 'courses'] as const,
};
