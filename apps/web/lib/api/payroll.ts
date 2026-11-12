import {
  adjustmentListResponseSchema,
  adjustmentSchema,
  attendanceListSchema,
  attendanceSchema,
  attendanceTodaySchema,
  cancelAdjustmentResultSchema,
  leaveListResponseSchema,
  leaveRequestSchema,
  myWalletSchema,
  payProfileListResponseSchema,
  payProfileSchema,
  payrollPickerPersonSchema,
  payrollRunDetailSchema,
  payrollRunSchema,
  payRuleSetSchema,
  payslipSchema,
  runListResponseSchema,
  runPreviewSchema,
  walletRowSchema,
  type AdjustmentDto,
  type AdjustmentListQuery,
  type AttendanceDto,
  type AttendanceListDto,
  type AttendanceListQuery,
  type AttendanceTodayDto,
  type CancelAdjustmentResultDto,
  type CreateAdjustmentInput,
  type CreateLeaveInput,
  type CreatePayRuleSetInput,
  type LeaveListQuery,
  type LeaveRequestDto,
  type MarkAttendanceInput,
  type MyWalletDto,
  type Paginated,
  type PayProfileDto,
  type PayrollPickerPersonDto,
  type PayrollRunDetailDto,
  type PayrollRunDto,
  type PayRuleSetDto,
  type PayslipDto,
  type RecordPaymentInput,
  type RunPreviewDto,
  type SavePayProfileInput,
  type WalletRowDto,
} from '@qarabic/shared';
import { z } from 'zod';
import { apiFetch } from './client';
import { toSearchParams } from './people';

/**
 * Payroll (N7, apps/api README «Endpoints (N7: payroll)»): attendance and leave, fines and other
 * pay adjustments, salary profiles, pay rule sets, monthly runs, payslips and wallets. Contract in
 * `@qarabic/shared` (`payroll.ts`). The API only computes, records and approves (D140): recording
 * a payment stores what Accounts did outside the system. Money stays the API's decimal string.
 */
const one = <T extends z.ZodType>(schema: T) => z.object({ data: schema });
const qs = (query: object) => {
  const flat: Record<string, string | number | boolean | undefined> = {};
  for (const [k, v] of Object.entries(query)) {
    flat[k] = Array.isArray(v) ? v.join(',') : (v as string | number | boolean | undefined);
  }
  const s = toSearchParams(flat);
  return s ? `?${s}` : '';
};

// ------------------------------------------------------------------ attendance

export async function fetchAttendanceToday(signal?: AbortSignal): Promise<AttendanceTodayDto> {
  return (await apiFetch('/attendance/today', { schema: one(attendanceTodaySchema), signal })).data;
}

export async function checkIn(): Promise<AttendanceDto> {
  return (await apiFetch('/attendance/check-in', { method: 'POST', schema: one(attendanceSchema) }))
    .data;
}

export async function checkOut(): Promise<AttendanceDto> {
  return (
    await apiFetch('/attendance/check-out', { method: 'POST', schema: one(attendanceSchema) })
  ).data;
}

export async function fetchAttendance(
  query: AttendanceListQuery,
  signal?: AbortSignal,
): Promise<AttendanceListDto> {
  return apiFetch(`/attendance${qs(query)}`, { schema: attendanceListSchema, signal });
}

export async function markAttendance(
  userId: number,
  date: string,
  body: MarkAttendanceInput,
): Promise<AttendanceDto> {
  return (
    await apiFetch(`/attendance/${userId}/${date}`, {
      method: 'PUT',
      body,
      schema: one(attendanceSchema),
    })
  ).data;
}

// ------------------------------------------------------------------ leave requests

export async function fetchLeaveRequests(
  query: LeaveListQuery,
  signal?: AbortSignal,
): Promise<Paginated<LeaveRequestDto>> {
  return apiFetch(`/leave-requests${qs(query)}`, { schema: leaveListResponseSchema, signal });
}

export async function fetchLeaveRequest(id: number, signal?: AbortSignal) {
  return (await apiFetch(`/leave-requests/${id}`, { schema: one(leaveRequestSchema), signal }))
    .data;
}

export async function createLeave(body: CreateLeaveInput): Promise<LeaveRequestDto> {
  return (
    await apiFetch('/leave-requests', { method: 'POST', body, schema: one(leaveRequestSchema) })
  ).data;
}

export async function decideLeave(
  id: number,
  action: 'approve' | 'reject' | 'cancel',
  note: string | null,
): Promise<LeaveRequestDto> {
  return (
    await apiFetch(`/leave-requests/${id}/${action}`, {
      method: 'POST',
      body: note ? { note } : {},
      schema: one(leaveRequestSchema),
    })
  ).data;
}

// ------------------------------------------------------------------ adjustments (fines …)

export async function fetchAdjustments(
  query: AdjustmentListQuery,
  signal?: AbortSignal,
): Promise<Paginated<AdjustmentDto>> {
  return apiFetch(`/payroll/adjustments${qs(query)}`, {
    schema: adjustmentListResponseSchema,
    signal,
  });
}

export async function createAdjustment(body: CreateAdjustmentInput): Promise<AdjustmentDto> {
  return (
    await apiFetch('/payroll/adjustments', { method: 'POST', body, schema: one(adjustmentSchema) })
  ).data;
}

export async function decideAdjustment(
  id: number,
  action: 'approve' | 'reject',
  note: string | null,
): Promise<AdjustmentDto> {
  return (
    await apiFetch(`/payroll/adjustments/${id}/${action}`, {
      method: 'POST',
      body: note ? { note } : {},
      schema: one(adjustmentSchema),
    })
  ).data;
}

/** Cancel; a fine of an approved month is waived with a fine reduction (`reduction`). */
export async function cancelAdjustment(
  id: number,
  note: string,
): Promise<CancelAdjustmentResultDto> {
  return (
    await apiFetch(`/payroll/adjustments/${id}/cancel`, {
      method: 'POST',
      body: { note },
      schema: one(cancelAdjustmentResultSchema),
    })
  ).data;
}

/** People with an active salary profile (id, name, currency) for the pickers. */
export async function fetchPayrollPeople(
  q: string | undefined,
  signal?: AbortSignal,
): Promise<PayrollPickerPersonDto[]> {
  return (
    await apiFetch(`/payroll/people${qs({ q })}`, {
      schema: one(z.array(payrollPickerPersonSchema)),
      signal,
    })
  ).data;
}

// ------------------------------------------------------------------ salary profiles

export async function fetchPayProfiles(
  query: { q?: string; page?: number; perPage?: number },
  signal?: AbortSignal,
): Promise<Paginated<PayProfileDto>> {
  return apiFetch(`/salary-profiles${qs(query)}`, { schema: payProfileListResponseSchema, signal });
}

export async function fetchPayProfile(
  userId: number,
  signal?: AbortSignal,
): Promise<PayProfileDto | null> {
  return (
    await apiFetch(`/salary-profiles/${userId}`, {
      schema: one(payProfileSchema.nullable()),
      signal,
    })
  ).data;
}

export async function savePayProfile(
  userId: number,
  body: SavePayProfileInput,
): Promise<PayProfileDto> {
  return (
    await apiFetch(`/salary-profiles/${userId}`, {
      method: 'PUT',
      body,
      schema: one(payProfileSchema),
    })
  ).data;
}

// ------------------------------------------------------------------ runs and payslips

export async function fetchRuns(
  query: { page?: number; perPage?: number },
  signal?: AbortSignal,
): Promise<Paginated<PayrollRunDto>> {
  return apiFetch(`/payroll/runs${qs(query)}`, { schema: runListResponseSchema, signal });
}

export async function fetchRun(id: number, signal?: AbortSignal): Promise<PayrollRunDetailDto> {
  return (await apiFetch(`/payroll/runs/${id}`, { schema: one(payrollRunDetailSchema), signal }))
    .data;
}

/** What a run of `period` would hold, computed now; nothing is stored. */
export async function previewRun(period: string, signal?: AbortSignal): Promise<RunPreviewDto> {
  return (
    await apiFetch(`/payroll/runs/preview${qs({ period })}`, {
      schema: one(runPreviewSchema),
      signal,
    })
  ).data;
}

export async function createRun(period: string): Promise<PayrollRunDto> {
  return (
    await apiFetch('/payroll/runs', {
      method: 'POST',
      body: { period },
      schema: one(payrollRunSchema),
    })
  ).data;
}

export type RunAction = 'recompute' | 'review' | 'approve' | 'reopen';

export async function runAction(
  id: number,
  action: RunAction,
  note?: string,
): Promise<PayrollRunDto> {
  return (
    await apiFetch(`/payroll/runs/${id}/${action}`, {
      method: 'POST',
      body: note ? { note } : undefined,
      schema: one(payrollRunSchema),
    })
  ).data;
}

export async function fetchPayslip(id: number, signal?: AbortSignal): Promise<PayslipDto> {
  return (await apiFetch(`/payslips/${id}`, { schema: one(payslipSchema), signal })).data;
}

/** «تسجيل الصرف»: records a payment made outside the system; no money moves. */
export async function recordPayslipPayment(
  id: number,
  body: RecordPaymentInput,
): Promise<PayslipDto> {
  return (
    await apiFetch(`/payslips/${id}/payments`, {
      method: 'POST',
      body,
      schema: one(payslipSchema),
    })
  ).data;
}

export async function fetchMyPayslips(signal?: AbortSignal): Promise<PayslipDto[]> {
  return (await apiFetch('/me/payslips', { schema: one(z.array(payslipSchema)), signal })).data;
}

export async function fetchMyWallet(signal?: AbortSignal): Promise<MyWalletDto> {
  return (await apiFetch('/me/wallet', { schema: one(myWalletSchema), signal })).data;
}

export async function fetchWallets(signal?: AbortSignal): Promise<WalletRowDto[]> {
  return (await apiFetch('/wallets', { schema: one(z.array(walletRowSchema)), signal })).data;
}

// ------------------------------------------------------------------ pay rules

export async function fetchPayRuleSets(signal?: AbortSignal): Promise<PayRuleSetDto[]> {
  return (await apiFetch('/pay-rule-sets', { schema: one(z.array(payRuleSetSchema)), signal }))
    .data;
}

export async function createPayRuleSet(body: CreatePayRuleSetInput): Promise<PayRuleSetDto> {
  return (await apiFetch('/pay-rule-sets', { method: 'POST', body, schema: one(payRuleSetSchema) }))
    .data;
}

export const payrollKeys = {
  all: ['payroll'] as const,
  today: ['payroll', 'attendance', 'today'] as const,
  attendance: (query: unknown) => ['payroll', 'attendance', query] as const,
  leave: (query: unknown) => ['payroll', 'leave', query] as const,
  adjustments: (query: unknown) => ['payroll', 'adjustments', query] as const,
  people: (q: string) => ['payroll', 'people', q] as const,
  profiles: (query: unknown) => ['payroll', 'profiles', query] as const,
  profile: (userId: number) => ['payroll', 'profile', userId] as const,
  runs: (query: unknown) => ['payroll', 'runs', query] as const,
  run: (id: number) => ['payroll', 'run', id] as const,
  preview: (period: string) => ['payroll', 'preview', period] as const,
  payslip: (id: number) => ['payroll', 'payslip', id] as const,
  myPayslips: ['payroll', 'me', 'payslips'] as const,
  myWallet: ['payroll', 'me', 'wallet'] as const,
  wallets: ['payroll', 'wallets'] as const,
  ruleSets: ['payroll', 'rule-sets'] as const,
};
