import {
  deleteExchangeRateSchema,
  exchangeRateQuerySchema,
  upsertExchangeRateSchema,
  type ExchangeRateDto,
} from '@qarabic/shared';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { guardAny, notFound, validationFailed } from './session';

/**
 * The mock `…/accounting/exchange-rates` (D144, D146): read with `accounting.view` or
 * `reports.financial`, change with `accounting.manage` or `accounting.rates` (accounts keep the
 * rates without seeing the ledger). Seeded with GBP and EGP for the last few months; December 2025
 * GBP is missing on purpose (the dashboard mock's oldest month says so too).
 */
const API = '*/api/v1/accounting/exchange-rates';

let rates: ExchangeRateDto[] = [];
let nextId = 1;

function seed(): ExchangeRateDto[] {
  const at = '2026-11-01T09:00:00.000Z';
  const by = { id: 13, name: 'Accounts Officer' };
  const rows: [string, string, string][] = [
    ['GBP', '2026-11', '1.27'],
    ['GBP', '2026-10', '1.2650'],
    ['GBP', '2026-09', '1.31'],
    ['EGP', '2026-11', '0.0205'],
    ['EGP', '2026-10', '0.0207'],
    ['EUR', '2026-10', '1.08'],
  ];
  return rows.map(([currency, month, rateToUsd], i) => ({
    id: i + 1,
    currency,
    month,
    rateToUsd,
    note: null,
    updatedAt: at,
    updatedBy: by,
  }));
}

export function resetExchangeRates() {
  rates = seed();
  nextId = rates.length + 1;
}
resetExchangeRates();

const sorted = (rows: ExchangeRateDto[]) =>
  [...rows].sort((a, b) => b.month.localeCompare(a.month) || a.currency.localeCompare(b.currency));

export const exchangeRateHandlers: HttpHandler[] = [
  http.get(API, ({ request }) => {
    const g = guardAny(request, 'accounting.view', 'reports.financial');
    if ('error' in g) return g.error;
    const q = exchangeRateQuerySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!q.success) return validationFailed(q.error.issues);
    const { currency, from, to } = q.data;
    const rows = rates.filter(
      (r) =>
        (!currency || r.currency === currency) &&
        (!from || r.month >= from) &&
        (!to || r.month <= to),
    );
    return HttpResponse.json({ data: sorted(rows) });
  }),

  http.put(API, async ({ request }) => {
    const g = guardAny(request, 'accounting.manage', 'accounting.rates');
    if ('error' in g) return g.error;
    const body = upsertExchangeRateSchema.safeParse(await request.json());
    if (!body.success) return validationFailed(body.error.issues);
    const { currency, month, rateToUsd, note } = body.data;
    const at = new Date().toISOString();
    const by = { id: g.me.id, name: g.me.name };
    const found = rates.find((r) => r.currency === currency && r.month === month);
    const row: ExchangeRateDto = found
      ? {
          ...found,
          rateToUsd,
          note: note === undefined ? found.note : note,
          updatedAt: at,
          updatedBy: by,
        }
      : {
          id: nextId++,
          currency,
          month,
          rateToUsd,
          note: note ?? null,
          updatedAt: at,
          updatedBy: by,
        };
    rates = [...rates.filter((r) => r.id !== row.id), row];
    return HttpResponse.json({ data: row });
  }),

  http.delete(`${API}/:id`, async ({ request, params }) => {
    const g = guardAny(request, 'accounting.manage', 'accounting.rates');
    if ('error' in g) return g.error;
    const body = deleteExchangeRateSchema.safeParse(await request.json().catch(() => ({})));
    if (!body.success) return validationFailed(body.error.issues);
    const id = Number(params.id);
    if (!rates.some((r) => r.id === id)) return notFound();
    rates = rates.filter((r) => r.id !== id);
    return HttpResponse.json({ data: { id } });
  }),
];
