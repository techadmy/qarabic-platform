import { permissionsFor, type Role, visibleWidgets } from '@qarabic/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type Client,
  clock,
  createTestApp,
  m2Enrollment,
  m2Session,
  m2Student,
  m2Teacher,
  resetState,
  signedIn,
  type TestContext,
} from './helpers.js';
import { crmLead } from './n5-helpers.js';
import { billingFamily, issuedInvoice, makeFeePackage, resetBilling } from './n6-helpers.js';

/*
| D1 (docs/40, D144): GET /dashboard/metrics. Each role gets only its widgets (B121); money is
| reported in USD at the month's rate, equals the payment / invoice / ledger rows behind it, keeps
| the original-currency breakdown, and a missing rate is flagged (usd null), never 0.
*/

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});
beforeEach(async () => {
  await resetState(ctx);
  resetBilling(ctx);
  clock(ctx).set('2026-11-02T09:00:00Z');
});

const NOV = '/dashboard/metrics?from=2026-11-01&to=2026-11-30';

/** A USD family paying 60.00 and a GBP family paying 50.00 in November; GBP has no rate yet. */
async function seedMoney(books: Client, billing: Client) {
  const usd = await billingFamily(ctx, 'USD', [await makeFeePackage(ctx, { USD: '60.00' })]);
  const gbp = await billingFamily(ctx, 'GBP', [await makeFeePackage(ctx, { GBP: '50.00' })]);
  const unpaid = await billingFamily(ctx, 'GBP', [await makeFeePackage(ctx, { GBP: '40.00' })]);
  const invUsd = await issuedInvoice(ctx, usd, '2026-11', '2026-11-07');
  const invGbp = await issuedInvoice(ctx, gbp, '2026-11', '2026-11-07');
  await issuedInvoice(ctx, unpaid, '2026-11', '2026-11-07');
  for (const [inv, amount] of [
    [invUsd, '60'],
    [invGbp, '50'],
  ] as const) {
    const paid = await billing.post(`/invoices/${inv.id}/payments`, {
      method: 'cash',
      amount,
      receivedOn: '2026-11-02',
    });
    expect(paid.status).toBe(201);
  }
  expect((await books.post('/accounting/outbox/process')).status).toBe(200);
}

describe('GET /dashboard/metrics: who sees which widget', () => {
  it('each staff role gets exactly its widgets; hidden ones are absent', async () => {
    const roles: Array<Role> = [
      'manager',
      'monitor',
      'csr',
      'billing',
      'accounts',
      'senior_manager',
    ];
    for (const role of roles) {
      const { client } = await signedIn(ctx, role);
      const res = await client.get(NOV);
      expect(res.status, role).toBe(200);
      const expected = visibleWidgets(new Set<string>(permissionsFor(role)));
      expect(res.body.data.widgets, role).toEqual(expected);
      for (const key of [
        ...Object.keys(res.body.data.kpis as object),
        ...Object.keys(res.body.data.series as object),
      ])
        expect(expected, `${role}: ${key}`).toContain(key);
    }
    const { client: manager } = await signedIn(ctx, 'manager');
    const m = (await manager.get(NOV)).body.data;
    expect(m.kpis.collected).toBeUndefined();
    expect(m.kpis.gross_profit).toBeUndefined();
    expect(m.series.revenue_expenses).toBeUndefined();
  });

  it('the owner sees all of them, with the current month by default and the previous period', async () => {
    const { client: admin } = await signedIn(ctx, 'admin');
    const res = await admin.get('/dashboard/metrics');
    expect(res.status).toBe(200);
    expect(res.body.data.widgets).toHaveLength(17);
    expect(res.body.data.range).toEqual({
      from: '2026-11-01',
      to: '2026-11-30',
      bucket: 'day',
      previous: { from: '2026-10-02', to: '2026-10-31' },
      timezone: 'Africa/Cairo',
    });
    expect(res.body.data.series.class_outcomes).toHaveLength(30);
  });

  it('teachers and parents get 403, no session 401, a bad range 422', async () => {
    for (const role of ['teacher', 'parent']) {
      const { client } = await signedIn(ctx, role);
      expect((await client.get(NOV)).status, role).toBe(403);
    }
    expect((await request(ctx.app.getHttpServer()).get(`/api/v1${NOV}`)).status).toBe(401);
    const { client: admin } = await signedIn(ctx, 'admin');
    expect((await admin.get('/dashboard/metrics?from=2026-11-30&to=2026-11-01')).status).toBe(422);
    expect((await admin.get('/dashboard/metrics?from=2026-11-01')).status).toBe(422);
  });
});

describe('money in USD (D144)', () => {
  it('a missing GBP rate is flagged, never 0; once set, totals match the rows behind them', async () => {
    const { client: accounts } = await signedIn(ctx, 'accounts');
    const { client: billing } = await signedIn(ctx, 'billing');
    const { client: owner } = await signedIn(ctx, 'admin');
    await seedMoney(owner, billing);

    // No GBP rate for November yet.
    const before = (await accounts.get(NOV)).body.data;
    expect(before.kpis.collected.value).toEqual({
      usd: null,
      missingRate: true,
      byCurrency: [
        { currency: 'GBP', amount: '50.00', usd: null, missingMonths: ['2026-11'] },
        { currency: 'USD', amount: '60.00', usd: '60.00', missingMonths: [] },
      ],
    });
    expect(before.missingRates).toEqual([{ currency: 'GBP', month: '2026-11' }]);
    expect(before.kpis.collection_rate.value).toBeNull(); // GBP has no rate yet

    // Accounts set the rate: the next request shows it (no 5-minute wait).
    await accounts.put('/accounting/exchange-rates', {
      currency: 'GBP',
      month: '2026-11',
      rateToUsd: '1.25',
    });
    // Profit and loss is the owner's only (D145): accounts see collections, not profit.
    const forAccounts = (await accounts.get(NOV)).body.data;
    expect(forAccounts.kpis.gross_profit).toBeUndefined();
    expect(forAccounts.series.revenue_expenses).toBeUndefined();
    // D146: accounts see collections and the collection rate, nothing of the ledger.
    expect(forAccounts.widgets).toEqual([
      'collected',
      'outstanding',
      'collection_rate',
      'collections',
    ]);
    // Due in November: 60 USD + 50 GBP + 40 GBP = 172.50 USD; paid 60 + 50 GBP = 122.50 USD.
    expect(forAccounts.kpis.collection_rate.value).toBeCloseTo(122.5 / 172.5, 4);
    const after = (await owner.get(NOV)).body.data;
    expect(after.missingRates).toEqual([]);
    expect(after.kpis.collected.value.usd).toBe('122.50'); // 60 + 50 × 1.25

    // Collected = the payment rows.
    const payments = await ctx.prisma.payment.findMany({
      where: { status: 'succeeded', method: { not: 'credit' } },
    });
    const byCur = (cur: string) =>
      payments
        .filter((p) => p.currency === cur)
        .reduce((s, p) => s + Number(p.amount), 0)
        .toFixed(2);
    expect(after.kpis.collected.value.byCurrency).toEqual([
      { currency: 'GBP', amount: byCur('GBP'), usd: '62.50', missingMonths: [] },
      { currency: 'USD', amount: byCur('USD'), usd: '60.00', missingMonths: [] },
    ]);

    // Outstanding = the open invoice balances (the unpaid GBP family): 40 × 1.25.
    const open = await ctx.prisma.invoice.findMany({
      where: { status: { in: ['issued', 'partially_paid'] } },
    });
    const openGbp = open.reduce((s, i) => s + Number(i.total) - Number(i.paid), 0);
    expect(after.kpis.outstanding.value.total).toMatchObject({
      usd: (openGbp * 1.25).toFixed(2),
      byCurrency: [{ currency: 'GBP', amount: openGbp.toFixed(2) }],
    });
    // Due on the 7th, the period ends on the 30th: 23 days overdue.
    expect(after.series.collections.ageing.d0_30.usd).toBe((openGbp * 1.25).toFixed(2));

    // Revenue = the ledger's income lines (credit − debit), per currency.
    const income = await ctx.prisma.journalLine.groupBy({
      by: ['currency'],
      where: { account: { type: 'income' } },
      _sum: { credit: true, debit: true },
    });
    const revenue = (cur: string) => {
      const row = income.find((r) => r.currency === cur)!;
      return Number(row._sum.credit) - Number(row._sum.debit);
    };
    const points = after.series.revenue_expenses as Array<{
      revenue: { usd: string; byCurrency: Array<{ currency: string; amount: string }> };
    }>;
    const sumUsd = points.reduce((s, p) => s + Number(p.revenue.usd), 0);
    expect(sumUsd.toFixed(2)).toBe((revenue('USD') + revenue('GBP') * 1.25).toFixed(2));
    // No expenses booked: gross and net profit equal revenue.
    expect(after.kpis.gross_profit.value.usd).toBe(sumUsd.toFixed(2));
    expect(after.kpis.net_profit.value.usd).toBe(sumUsd.toFixed(2));
    // The original amounts are untouched.
    expect(
      (await ctx.prisma.payment.findFirstOrThrow({ where: { currency: 'GBP' } })).amount.toFixed(2),
    ).toBe('50.00');
  });
});

describe('operations', () => {
  it('counts students, teachers, attendance, trials and class outcomes by day', async () => {
    const teacher = await m2Teacher(ctx);
    const a = await m2Student(ctx);
    const b = await m2Student(ctx);
    const ea = await m2Enrollment(ctx, a, teacher, { startsOn: '2026-11-03' });
    const eb = await m2Enrollment(ctx, b, teacher, { startsOn: '2026-10-01' });
    await m2Session(ctx, ea, '2026-11-03T10:00:00Z', { stage: 'taken' });
    await m2Session(ctx, ea, '2026-11-04T10:00:00Z', { stage: 'absent' });
    await m2Session(ctx, eb, '2026-11-04T12:00:00Z', { stage: 'taken' });
    await m2Session(ctx, eb, '2026-11-05T12:00:00Z', { stage: 'cancelled' });
    await m2Session(ctx, eb, '2026-11-06T12:00:00Z', { kind: 'trial', stage: 'taken' });
    // Outside the range.
    await m2Session(ctx, eb, '2026-12-01T12:00:00Z', { stage: 'taken' });
    await crmLead(ctx, { source: 'phone', createdAt: new Date('2026-11-04T09:00:00Z') });
    await crmLead(ctx, {
      source: 'whatsapp',
      status: 'converted',
      createdAt: new Date('2026-11-04T09:00:00Z'),
      convertedAt: new Date('2026-11-07T09:00:00Z'),
    });

    const { client: admin } = await signedIn(ctx, 'admin');
    const d = (await admin.get(NOV)).body.data;
    expect(d.kpis.active_students.value).toBe(2);
    expect(d.kpis.teachers_on_duty.value).toBe(1);
    expect(d.kpis.attendance_rate.value).toBeCloseTo(3 / 4, 4); // 3 taken (incl. trial) / 4 marked
    expect(d.kpis.new_students.value).toBe(1); // b started in October
    expect(d.kpis.trials.value).toEqual({
      booked: 1,
      attended: 1,
      converted: 1,
      conversionRate: 1,
    });
    const day = (key: string) =>
      (d.series.class_outcomes as Array<{ bucket: string }>).find((p) => p.bucket === key);
    expect(day('2026-11-04')).toEqual({
      bucket: '2026-11-04',
      taken: 1,
      absent: 1,
      leave: 0,
      declined: 0,
      cancelled: 0,
    });
    expect(day('2026-11-05')).toMatchObject({ cancelled: 1 });
    expect(d.series.leads_by_source).toEqual(
      expect.arrayContaining([
        { source: 'phone', count: 1 },
        { source: 'whatsapp', count: 1 },
      ]),
    );
    // The previous period (October) is empty.
    expect(d.kpis.active_students.previous).toBe(0);

    // The academy's week starts on Saturday: Nov 1 (Sunday) is in the week of Sat Oct 31, and the
    // Friday trial (Nov 6) and the Saturday class (Nov 7) fall in different weeks.
    await m2Session(ctx, eb, '2026-11-07T12:00:00Z', { stage: 'taken' });
    const weekly = (await admin.get(`${NOV}&bucket=week`)).body.data;
    const weeks = weekly.series.class_outcomes as Array<{ bucket: string; taken: number }>;
    expect(weeks.map((w) => w.bucket)).toEqual([
      '2026-10-31',
      '2026-11-07',
      '2026-11-14',
      '2026-11-21',
      '2026-11-28',
    ]);
    expect(weeks[0]).toMatchObject({ taken: 3, absent: 1, cancelled: 1 });
    expect(weeks[1]).toMatchObject({ taken: 1 });
  });
});
