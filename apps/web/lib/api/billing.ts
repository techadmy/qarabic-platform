import {
  billingProvidersSchema,
  billingSettingsSchema,
  billingSummarySchema,
  checkoutResultSchema,
  familyBillingSchema,
  feePackageSchema,
  invoiceDetailSchema,
  invoiceListResponseSchema,
  invoiceRunPreviewResponseSchema,
  invoiceRunResultSchema,
  paymentSchema,
  remindResultSchema,
  splitResultSchema,
  type AddInvoiceLineInput,
  type BillingProvidersDto,
  type BillingSettingsDto,
  type BillingSummaryDto,
  type CheckoutResultDto,
  type CreateFeePackageInput,
  type CreateInvoiceInput,
  type FamilyBillingDto,
  type FeePackageDto,
  type InvoiceDetailDto,
  type InvoiceDto,
  type InvoiceListQuery,
  type InvoiceRunInput,
  type InvoiceRunPreviewInput,
  type InvoiceRunPreviewResponse,
  type InvoiceRunResultDto,
  type ManualPaymentInput,
  type OnlinePaymentMethod,
  type Paginated,
  type PaymentDto,
  type RemindResultDto,
  type SplitInvoiceInput,
  type SplitResultDto,
  type UpdateBillingSettingsInput,
  type UpdateFamilyBillingInput,
  type UpdateFeePackageInput,
} from '@qarabic/shared';
import { z } from 'zod';
import { API_PREFIX, API_URL, apiFetch } from './client';
import { toSearchParams } from './people';

/**
 * Billing (N6, apps/api README «Endpoints (N6: billing)»): fee packages, the family billing
 * profile, invoices and their actions, payments (manual; Stripe / PayPal checkout in test mode
 * only), the monthly run and the billing settings. Contract in `@qarabic/shared` (`billing.ts`).
 * Money is always the API's decimal string; nothing here does arithmetic on amounts.
 */
const one = <T extends z.ZodType>(schema: T) => z.object({ data: schema });
const qs = (query: object) => {
  const s = toSearchParams(query as Record<string, string | number | boolean | undefined>);
  return s ? `?${s}` : '';
};
const detail = one(invoiceDetailSchema);

export async function fetchBillingProviders(signal?: AbortSignal): Promise<BillingProvidersDto> {
  return (await apiFetch('/billing/providers', { schema: one(billingProvidersSchema), signal }))
    .data;
}

export async function fetchBillingSummary(signal?: AbortSignal): Promise<BillingSummaryDto> {
  return (await apiFetch('/billing/summary', { schema: one(billingSummarySchema), signal })).data;
}

// ------------------------------------------------------------------ fee packages

export async function fetchFeePackages(signal?: AbortSignal): Promise<FeePackageDto[]> {
  return (await apiFetch('/fee-packages', { schema: one(z.array(feePackageSchema)), signal })).data;
}

export async function createFeePackage(body: CreateFeePackageInput): Promise<FeePackageDto> {
  return (await apiFetch('/fee-packages', { method: 'POST', body, schema: one(feePackageSchema) }))
    .data;
}

export async function updateFeePackage(
  id: number,
  body: UpdateFeePackageInput,
): Promise<FeePackageDto> {
  return (
    await apiFetch(`/fee-packages/${id}`, { method: 'PATCH', body, schema: one(feePackageSchema) })
  ).data;
}

// ------------------------------------------------------------------ family billing profile

export async function fetchFamilyBilling(
  familyId: number,
  signal?: AbortSignal,
): Promise<FamilyBillingDto> {
  return (
    await apiFetch(`/families/${familyId}/billing`, { schema: one(familyBillingSchema), signal })
  ).data;
}

export async function updateFamilyBilling(
  familyId: number,
  body: UpdateFamilyBillingInput,
): Promise<FamilyBillingDto> {
  return (
    await apiFetch(`/families/${familyId}/billing`, {
      method: 'PUT',
      body,
      schema: one(familyBillingSchema),
    })
  ).data;
}

// ------------------------------------------------------------------ invoices

export async function fetchInvoices(
  query: InvoiceListQuery,
  signal?: AbortSignal,
): Promise<Paginated<InvoiceDto>> {
  return apiFetch(`/invoices${qs(query)}`, { schema: invoiceListResponseSchema, signal });
}

export async function fetchInvoice(id: number, signal?: AbortSignal): Promise<InvoiceDetailDto> {
  return (await apiFetch(`/invoices/${id}`, { schema: detail, signal })).data;
}

/** The printable invoice the API renders (HTML in the viewer's language; print or save as PDF). */
export const invoicePrintUrl = (id: number) => `${API_URL}${API_PREFIX}/invoices/${id}/print`;

export async function createInvoice(body: CreateInvoiceInput): Promise<InvoiceDetailDto> {
  return (await apiFetch('/invoices', { method: 'POST', body, schema: detail })).data;
}

export async function issueInvoice(id: number): Promise<InvoiceDetailDto> {
  return (await apiFetch(`/invoices/${id}/issue`, { method: 'POST', schema: detail })).data;
}

export async function addInvoiceLine(
  id: number,
  body: AddInvoiceLineInput,
): Promise<InvoiceDetailDto> {
  return (await apiFetch(`/invoices/${id}/lines`, { method: 'POST', body, schema: detail })).data;
}

export async function voidInvoice(id: number, reason: string): Promise<InvoiceDetailDto> {
  return (
    await apiFetch(`/invoices/${id}/void`, { method: 'POST', body: { reason }, schema: detail })
  ).data;
}

export async function splitInvoice(id: number, body: SplitInvoiceInput): Promise<SplitResultDto> {
  return (
    await apiFetch(`/invoices/${id}/split`, {
      method: 'POST',
      body,
      schema: one(splitResultSchema),
    })
  ).data;
}

export async function remindInvoice(id: number): Promise<RemindResultDto> {
  return (
    await apiFetch(`/invoices/${id}/remind`, { method: 'POST', schema: one(remindResultSchema) })
  ).data;
}

export async function recordPayment(id: number, body: ManualPaymentInput): Promise<PaymentDto> {
  return (
    await apiFetch(`/invoices/${id}/payments`, { method: 'POST', body, schema: one(paymentSchema) })
  ).data;
}

export async function voidPayment(id: number, reason: string): Promise<PaymentDto> {
  return (
    await apiFetch(`/payments/${id}/void`, {
      method: 'POST',
      body: { reason },
      schema: one(paymentSchema),
    })
  ).data;
}

/** The parent only picks the provider; the server charges its own balance. */
export async function startCheckout(
  id: number,
  provider: OnlinePaymentMethod,
): Promise<CheckoutResultDto> {
  return (
    await apiFetch(`/invoices/${id}/checkout`, {
      method: 'POST',
      body: { provider },
      schema: one(checkoutResultSchema),
    })
  ).data;
}

export async function capturePaypal(id: number, orderId: string): Promise<PaymentDto> {
  return (
    await apiFetch(`/invoices/${id}/paypal/capture`, {
      method: 'POST',
      body: { orderId },
      schema: one(paymentSchema),
    })
  ).data;
}

// ------------------------------------------------------------------ monthly run

export async function previewInvoiceRun(
  body: InvoiceRunPreviewInput,
): Promise<InvoiceRunPreviewResponse> {
  return apiFetch('/invoice-runs/preview', {
    method: 'POST',
    body,
    schema: invoiceRunPreviewResponseSchema,
  });
}

export async function runInvoices(body: InvoiceRunInput): Promise<InvoiceRunResultDto> {
  return (
    await apiFetch('/invoice-runs', { method: 'POST', body, schema: one(invoiceRunResultSchema) })
  ).data;
}

// ------------------------------------------------------------------ settings

export async function fetchBillingSettings(signal?: AbortSignal): Promise<BillingSettingsDto> {
  return (await apiFetch('/settings/billing', { schema: one(billingSettingsSchema), signal })).data;
}

export async function updateBillingSettings(
  body: UpdateBillingSettingsInput,
): Promise<BillingSettingsDto> {
  return (
    await apiFetch('/settings/billing', {
      method: 'PUT',
      body,
      schema: one(billingSettingsSchema),
    })
  ).data;
}

export const billingKeys = {
  all: ['billing'] as const,
  providers: ['billing', 'providers'] as const,
  summary: ['billing', 'summary'] as const,
  packages: ['billing', 'packages'] as const,
  family: (id: number) => ['billing', 'family', id] as const,
  invoices: (query: unknown) => ['billing', 'invoices', query] as const,
  invoice: (id: number) => ['billing', 'invoice', id] as const,
  settings: ['billing', 'settings'] as const,
};
