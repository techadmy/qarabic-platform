import {
  accountingPeriodSchema,
  accountStatementSchema,
  balanceSheetSchema,
  cashReportSchema,
  journalEntrySchema,
  journalListResponseSchema,
  ledgerAccountSchema,
  outboxRunResultSchema,
  outboxStatusSchema,
  profitAndLossSchema,
  trialBalanceSchema,
  voucherListResponseSchema,
  voucherSchema,
  type AccountingPeriodDto,
  type AccountListQuery,
  type AccountStatementDto,
  type BalanceSheetDto,
  type CashReportDto,
  type CreateAccountInput,
  type CreateJournalEntryInput,
  type CreateVoucherInput,
  type JournalEntryDto,
  type JournalEntryRowDto,
  type JournalListQuery,
  type LedgerAccountDto,
  type OutboxRunResultDto,
  type OutboxStatusDto,
  type Paginated,
  type ProfitAndLossDto,
  type ReverseEntryInput,
  type TrialBalanceDto,
  type UpdateAccountInput,
  type VoucherDto,
  type VoucherListQuery,
  type VoucherRowDto,
} from '@qarabic/shared';
import { z } from 'zod';
import { apiFetch } from './client';
import { toSearchParams } from './people';

/**
 * Accounting (M7, apps/api `accounting/…`): chart of accounts, the journal, receipt and payment
 * vouchers, periods, the automatic-entry outbox and the reports. Contract in `@qarabic/shared`
 * (`accounting.ts`). Money is the API's decimal string; the screens never add amounts up for the
 * books (the form only shows the running difference while typing).
 */
const one = <T extends z.ZodType>(schema: T) => z.object({ data: schema });
const qs = (query: object) => {
  const s = toSearchParams(query as Record<string, string | number | boolean | undefined>);
  return s ? `?${s}` : '';
};
const BASE = '/accounting';

// ------------------------------------------------------------------ chart of accounts

export async function fetchAccounts(
  query: Partial<AccountListQuery> = {},
  signal?: AbortSignal,
): Promise<LedgerAccountDto[]> {
  return (
    await apiFetch(`${BASE}/accounts${qs(query)}`, {
      schema: one(z.array(ledgerAccountSchema)),
      signal,
    })
  ).data;
}

export async function createAccount(body: CreateAccountInput): Promise<LedgerAccountDto> {
  return (
    await apiFetch(`${BASE}/accounts`, { method: 'POST', body, schema: one(ledgerAccountSchema) })
  ).data;
}

export async function updateAccount(
  id: number,
  body: UpdateAccountInput,
): Promise<LedgerAccountDto> {
  return (
    await apiFetch(`${BASE}/accounts/${id}`, {
      method: 'PATCH',
      body,
      schema: one(ledgerAccountSchema),
    })
  ).data;
}

export async function fetchAccountStatement(
  id: number,
  query: { currency: string; from: string; to: string; page?: number; perPage?: number },
  signal?: AbortSignal,
): Promise<AccountStatementDto> {
  return apiFetch(`${BASE}/accounts/${id}/statement${qs(query)}`, {
    schema: accountStatementSchema,
    signal,
  });
}

// ------------------------------------------------------------------ journal

export async function fetchJournal(
  query: Partial<JournalListQuery>,
  signal?: AbortSignal,
): Promise<Paginated<JournalEntryRowDto>> {
  return apiFetch(`${BASE}/journal${qs(query)}`, { schema: journalListResponseSchema, signal });
}

export async function fetchJournalEntry(
  id: number,
  signal?: AbortSignal,
): Promise<JournalEntryDto> {
  return (await apiFetch(`${BASE}/journal/${id}`, { schema: one(journalEntrySchema), signal }))
    .data;
}

export async function createJournalEntry(body: CreateJournalEntryInput): Promise<JournalEntryDto> {
  return (
    await apiFetch(`${BASE}/journal`, { method: 'POST', body, schema: one(journalEntrySchema) })
  ).data;
}

export async function reverseJournalEntry(
  id: number,
  body: ReverseEntryInput,
): Promise<JournalEntryDto> {
  return (
    await apiFetch(`${BASE}/journal/${id}/reverse`, {
      method: 'POST',
      body,
      schema: one(journalEntrySchema),
    })
  ).data;
}

// ------------------------------------------------------------------ vouchers

export async function fetchVouchers(
  query: Partial<VoucherListQuery>,
  signal?: AbortSignal,
): Promise<Paginated<VoucherRowDto>> {
  return apiFetch(`${BASE}/vouchers${qs(query)}`, { schema: voucherListResponseSchema, signal });
}

export async function fetchVoucher(id: number, signal?: AbortSignal): Promise<VoucherDto> {
  return (await apiFetch(`${BASE}/vouchers/${id}`, { schema: one(voucherSchema), signal })).data;
}

export async function createVoucher(body: CreateVoucherInput): Promise<VoucherDto> {
  return (await apiFetch(`${BASE}/vouchers`, { method: 'POST', body, schema: one(voucherSchema) }))
    .data;
}

export async function voidVoucher(id: number, reason: string): Promise<VoucherDto> {
  return (
    await apiFetch(`${BASE}/vouchers/${id}/void`, {
      method: 'POST',
      body: { reason },
      schema: one(voucherSchema),
    })
  ).data;
}

// ------------------------------------------------------------------ periods and the outbox

export async function fetchPeriods(year: number, signal?: AbortSignal) {
  return (
    await apiFetch(`${BASE}/periods?year=${year}`, {
      schema: one(z.array(accountingPeriodSchema)),
      signal,
    })
  ).data;
}

export async function closePeriod(period: string): Promise<AccountingPeriodDto[]> {
  return (
    await apiFetch(`${BASE}/periods/${period}/close`, {
      method: 'POST',
      body: {},
      schema: one(z.array(accountingPeriodSchema)),
    })
  ).data;
}

export async function reopenPeriod(period: string, reason: string): Promise<AccountingPeriodDto[]> {
  return (
    await apiFetch(`${BASE}/periods/${period}/reopen`, {
      method: 'POST',
      body: { reason },
      schema: one(z.array(accountingPeriodSchema)),
    })
  ).data;
}

export async function fetchOutbox(signal?: AbortSignal): Promise<OutboxStatusDto> {
  return (await apiFetch(`${BASE}/outbox`, { schema: one(outboxStatusSchema), signal })).data;
}

export async function processOutbox(): Promise<OutboxRunResultDto> {
  return (
    await apiFetch(`${BASE}/outbox/process`, {
      method: 'POST',
      body: {},
      schema: one(outboxRunResultSchema),
    })
  ).data;
}

// ------------------------------------------------------------------ reports

type Range = { currency: string; from: string; to: string };

export async function fetchTrialBalance(q: Range, signal?: AbortSignal): Promise<TrialBalanceDto> {
  return (
    await apiFetch(`${BASE}/reports/trial-balance${qs(q)}`, {
      schema: one(trialBalanceSchema),
      signal,
    })
  ).data;
}

export async function fetchProfitAndLoss(
  q: Range,
  signal?: AbortSignal,
): Promise<ProfitAndLossDto> {
  return (
    await apiFetch(`${BASE}/reports/profit-and-loss${qs(q)}`, {
      schema: one(profitAndLossSchema),
      signal,
    })
  ).data;
}

export async function fetchBalanceSheet(
  q: { currency: string; asOf: string },
  signal?: AbortSignal,
): Promise<BalanceSheetDto> {
  return (
    await apiFetch(`${BASE}/reports/balance-sheet${qs(q)}`, {
      schema: one(balanceSheetSchema),
      signal,
    })
  ).data;
}

export async function fetchCashReport(
  q: { currency?: string; from: string; to: string },
  signal?: AbortSignal,
): Promise<CashReportDto> {
  return (await apiFetch(`${BASE}/reports/cash${qs(q)}`, { schema: one(cashReportSchema), signal }))
    .data;
}

/** Every accounting read sits under `accounting` so a write refreshes them together. */
export const accountingKeys = {
  all: ['accounting'] as const,
  accounts: (query: object) => ['accounting', 'accounts', query] as const,
  statement: (id: number, query: object) => ['accounting', 'statement', id, query] as const,
  journal: (query: object) => ['accounting', 'journal', query] as const,
  entry: (id: number) => ['accounting', 'entry', id] as const,
  vouchers: (query: object) => ['accounting', 'vouchers', query] as const,
  voucher: (id: number) => ['accounting', 'voucher', id] as const,
  periods: (year: number) => ['accounting', 'periods', year] as const,
  outbox: ['accounting', 'outbox'] as const,
  report: (name: string, query: object) => ['accounting', 'report', name, query] as const,
};
