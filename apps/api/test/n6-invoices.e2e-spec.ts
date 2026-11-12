import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type Client,
  clock,
  createTestApp,
  resetState,
  signedIn,
  type TestContext,
} from './helpers.js';
import { billingFamily, issuedInvoice, makeFeePackage, resetBilling } from './n6-helpers.js';

/*
| Ports of Laravel tests/Feature/M5/MoneyAndPackagesTest.php (packages part) and
| InvoiceLifecycleTest.php (D83): append-only lines, adjust / discount / split / void rules, manual
| invoices (CSR drafts), manual payments and recalculation. Money is a decimal string.
*/

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

const events = (type: string) =>
  ctx.prisma.billingEvent
    .findMany({ where: { type }, orderBy: { id: 'asc' } })
    .then((rows) => rows.map((r) => r.amount.toFixed(2)));

describe('fee packages', () => {
  beforeEach(async () => {
    await resetState(ctx);
    resetBilling(ctx);
  });

  it('lets billing create and update a package with a price per currency', async () => {
    const { client } = await signedIn(ctx, 'billing');
    const res = await client.post('/fee-packages', {
      name: '3 days a week',
      classesPerWeek: 3,
      sessionMinutes: 30,
      prices: [
        { currency: 'USD', monthlyAmount: '90' },
        { currency: 'gbp', monthlyAmount: 72 },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      classesPerWeek: 3,
      prices: [
        { currency: 'GBP', monthlyAmount: '72.00' },
        { currency: 'USD', monthlyAmount: '90.00' },
      ],
      studentsCount: 0,
    });
    const id = res.body.data.id as number;

    const upd = await client.patch(`/fee-packages/${id}`, {
      prices: [{ currency: 'USD', monthlyAmount: '95.00' }],
    });
    expect(upd.status).toBe(200);
    expect(upd.body.data.prices).toEqual([{ currency: 'USD', monthlyAmount: '95.00' }]);
    expect(
      (await client.patch(`/fee-packages/${id}`, { isActive: false })).body.data.isActive,
    ).toBe(false);

    expect((await client.get('/fee-packages?active=1')).body.data).toHaveLength(0);
    expect((await client.get('/fee-packages')).body.data).toHaveLength(1);
    expect((await client.patch('/fee-packages/999999', { isActive: true })).status).toBe(404);
    const audit = await ctx.prisma.auditLog.findMany({ where: { subjectType: 'fee_package' } });
    expect(audit.map((a) => a.action)).toEqual(['created', 'updated', 'updated']);
  });

  it('validates packages: currency, duplicates and positive prices', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const res = await client.post('/fee-packages', {
      name: 'X',
      classesPerWeek: 0,
      prices: [
        { currency: 'XYZ', monthlyAmount: 0 },
        { currency: 'USD', monthlyAmount: '1.999' },
      ],
    });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.errors)).toEqual(
      expect.arrayContaining([
        'classesPerWeek',
        'prices.0.currency',
        'prices.0.monthlyAmount',
        'prices.1.monthlyAmount',
      ]),
    );
  });

  it.each([
    ['admin', 201],
    ['senior_manager', 201],
    ['billing', 201],
    ['manager', 403],
    ['csr', 403],
    ['accounts', 403],
    ['monitor', 403],
    ['teacher', 403],
    ['parent', 403],
  ])(
    'keeps package management to admin, senior manager and billing (%s → %i)',
    async (role, status) => {
      const { client } = await signedIn(ctx, role);
      const res = await client.post('/fee-packages', {
        name: 'P',
        classesPerWeek: 2,
        prices: [{ currency: 'USD', monthlyAmount: '1.00' }],
      });
      expect(res.status).toBe(status);
    },
  );
});

describe('invoice lifecycle', () => {
  let billing: Client;
  let family: Awaited<ReturnType<typeof billingFamily>>;
  let invoiceId: number;

  beforeEach(async () => {
    await resetState(ctx);
    resetBilling(ctx);
    clock(ctx).set('2026-12-02T09:00:00Z');
    ({ client: billing } = await signedIn(ctx, 'billing'));
    family = await billingFamily(ctx, 'USD', [await makeFeePackage(ctx, { USD: '60.00' })]);
    invoiceId = (await issuedInvoice(ctx, family)).id;
  });

  it('adds adjustments and discounts as new lines with a reason, never editing old ones', async () => {
    const original = await ctx.prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId } });

    let res = await billing.post(`/invoices/${invoiceId}/lines`, {
      type: 'adjustment',
      amount: '15.00',
      reason: 'Extra class on 12 Dec',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ total: '75.00', adjustments: '15.00' });
    res = await billing.post(`/invoices/${invoiceId}/lines`, {
      type: 'adjustment',
      amount: '-5',
      reason: 'Teacher leave credit',
    });
    expect(res.body.data.total).toBe('70.00');
    res = await billing.post(`/invoices/${invoiceId}/lines`, {
      type: 'discount',
      percent: 10,
      reason: 'Sibling discount',
    });
    expect(res.body.data).toMatchObject({ discounts: '-7.00', total: '63.00' });
    expect(res.body.data.lines).toHaveLength(4);
    expect(res.body.data.lines[3].meta).toEqual({ percent: '10.00' });

    const fresh = await ctx.prisma.invoiceLine.findUniqueOrThrow({ where: { id: original.id } });
    expect(fresh.amount.toFixed(2)).toBe('60.00');
    expect(await events('invoice.adjusted')).toEqual(['15.00', '-5.00', '-7.00']);

    expect(
      (await billing.post(`/invoices/${invoiceId}/lines`, { type: 'discount', amount: '5' })).body
        .errors,
    ).toHaveProperty('reason');
    expect(
      (
        await billing.post(`/invoices/${invoiceId}/lines`, {
          type: 'adjustment',
          percent: 5,
          reason: 'Nope',
        })
      ).status,
    ).toBe(422);
    const tooMuch = await billing.post(`/invoices/${invoiceId}/lines`, {
      type: 'adjustment',
      amount: '-9999.99',
      reason: 'Too much',
    });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.code).toBe('below_paid');
  });

  it('rounds a percent discount half up in integer cents', async () => {
    await billing.post(`/invoices/${invoiceId}/lines`, {
      type: 'adjustment',
      amount: '0.05',
      reason: 'Odd cents',
    });
    // 60.05 × 12.5 % = 7.50625 → 7.51
    const res = await billing.post(`/invoices/${invoiceId}/lines`, {
      type: 'discount',
      percent: '12.5',
      reason: 'Promo',
    });
    expect(res.body.data).toMatchObject({ discounts: '-7.51', total: '52.54', balance: '52.54' });
  });

  it('keeps invoice lines append-only in the database', async () => {
    await expect(
      ctx.prisma.invoiceLine.updateMany({ where: { invoiceId }, data: { amount: '1.00' } }),
    ).rejects.toThrow(/append-only/);
    await expect(ctx.prisma.invoiceLine.deleteMany({ where: { invoiceId } })).rejects.toThrow(
      /append-only/,
    );
    await expect(ctx.prisma.billingEvent.deleteMany({})).rejects.toThrow(/append-only/);
    await expect(ctx.prisma.billingEvent.updateMany({ data: { amount: '1.00' } })).rejects.toThrow(
      /append-only/,
    );
    // The ledger may mark rows consumed.
    expect(
      (await ctx.prisma.billingEvent.updateMany({ data: { consumedAt: new Date() } })).count,
    ).toBe(1);
  });

  it('records partial and full manual payments and moves the status', async () => {
    let res = await billing.post(`/invoices/${invoiceId}/payments`, {
      method: 'bank_transfer',
      amount: '20',
      receivedOn: '2026-12-01',
      reference: 'TRX-1',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'succeeded',
      amount: '20.00',
      reference: 'TRX-1',
    });
    expect(res.body.data.receiptNumber).toMatch(/^RC-\d{6}$/);
    let inv = await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(inv.status).toBe('partially_paid');
    expect(inv.paid.toFixed(2)).toBe('20.00');

    res = await billing.post(`/invoices/${invoiceId}/payments`, {
      method: 'cash',
      amount: '40.01',
      receivedOn: '2026-12-02',
    });
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty('amount');
    res = await billing.post(`/invoices/${invoiceId}/payments`, {
      method: 'cash',
      amount: '1',
      receivedOn: '2026-12-03',
    });
    expect(res.body.errors).toHaveProperty('receivedOn'); // future
    res = await billing.post(`/invoices/${invoiceId}/payments`, {
      method: 'stripe',
      amount: '1',
      receivedOn: '2026-12-02',
    });
    expect(res.body.errors).toHaveProperty('method'); // online only through the provider

    expect(
      (
        await billing.post(`/invoices/${invoiceId}/payments`, {
          method: 'cash',
          amount: '40.00',
          receivedOn: '2026-12-02',
        })
      ).status,
    ).toBe(201);
    inv = await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(inv.status).toBe('paid');
    expect(inv.paidAt).not.toBeNull();
    expect(await events('payment.succeeded')).toEqual(['20.00', '40.00']);

    // Paid: no more payments, no void.
    expect(
      (
        await billing.post(`/invoices/${invoiceId}/payments`, {
          method: 'cash',
          amount: '0.01',
          receivedOn: '2026-12-02',
        })
      ).status,
    ).toBe(422);
    expect((await billing.post(`/invoices/${invoiceId}/void`, { reason: 'Mistake' })).status).toBe(
      422,
    );
  });

  it('voids a wrong manual payment with a reason and reopens the invoice', async () => {
    const paymentId = (
      await billing.post(`/invoices/${invoiceId}/payments`, {
        method: 'cash',
        amount: '60',
        receivedOn: '2026-12-02',
      })
    ).body.data.id as number;
    expect((await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe(
      'paid',
    );

    expect((await billing.post(`/payments/${paymentId}/void`, {})).body.errors).toHaveProperty(
      'reason',
    );
    const res = await billing.post(`/payments/${paymentId}/void`, {
      reason: 'Recorded on the wrong family',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');
    expect((await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe(
      'issued',
    );
    expect(await events('payment.refunded')).toEqual(['-60.00']);
    expect(
      (await billing.post(`/payments/${paymentId}/void`, { reason: 'Again please' })).body.code,
    ).toBe('payment_not_voidable');
    expect((await billing.post('/payments/999999/void', { reason: 'Missing one' })).status).toBe(
      404,
    );
  });

  it('voids an unpaid invoice with a reason, keeping it and its lines', async () => {
    expect((await billing.post(`/invoices/${invoiceId}/void`, {})).body.errors).toHaveProperty(
      'reason',
    );
    const res = await billing.post(`/invoices/${invoiceId}/void`, {
      reason: 'Family left in November',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'void', voidReason: 'Family left in November' });
    expect(res.body.data.can.edit).toBe(false);
    expect(res.body.data.lines).toHaveLength(1);
    expect(await events('invoice.voided')).toEqual(['-60.00']);
    const audit = await ctx.prisma.auditLog.findFirst({
      where: { subjectType: 'invoice', subjectId: invoiceId, action: 'invoice_voided' },
    });
    expect(audit?.reason).toBe('Family left in November');
    expect(
      (
        await billing.post(`/invoices/${invoiceId}/lines`, {
          type: 'adjustment',
          amount: '1',
          reason: 'Late',
        })
      ).body.code,
    ).toBe('not_editable');
  });

  it('splits an unpaid invoice into parts that sum to the total', async () => {
    const bad = await billing.post(`/invoices/${invoiceId}/split`, {
      reason: 'Two instalments',
      parts: [
        { amount: '30', dueDate: '2026-12-07' },
        { amount: '20', dueDate: '2026-12-21' },
      ],
    });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: 'split_sum', data: { total: '60.00' } });

    const res = await billing.post(`/invoices/${invoiceId}/split`, {
      reason: 'Two instalments',
      parts: [
        { amount: '30', dueDate: '2026-12-07' },
        { amount: '30', dueDate: '2026-12-21' },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.original.status).toBe('split');
    expect(res.body.data.parts).toHaveLength(2);
    expect(res.body.data.parts[1].dueDate).toBe('2026-12-21');

    const partId = res.body.data.parts[0].id as number;
    const part = (await billing.get(`/invoices/${partId}`)).body.data;
    expect(part).toMatchObject({
      kind: 'split',
      status: 'issued',
      total: '30.00',
      splitFrom: { id: invoiceId },
    });
    expect(part.number).toBe('INV-2026-000002');
    expect((await billing.get(`/invoices/${invoiceId}`)).body.data.splits).toHaveLength(2);

    // Ledger-neutral: −60 for the original, +30 × 2 for the parts.
    const sums = await ctx.prisma.billingEvent.aggregate({
      where: { type: { in: ['invoice.issued', 'invoice.voided'] } },
      _sum: { amount: true },
    });
    expect(sums._sum.amount?.toFixed(2)).toBe('60.00');
  });

  it('refuses to split an invoice with a payment', async () => {
    await billing.post(`/invoices/${invoiceId}/payments`, {
      method: 'cash',
      amount: '10',
      receivedOn: '2026-12-02',
    });
    const res = await billing.post(`/invoices/${invoiceId}/split`, {
      reason: 'x x x',
      parts: [
        { amount: '25', dueDate: '2026-12-07' },
        { amount: '25', dueDate: '2026-12-21' },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('split_not_allowed');
  });

  it('lets CSR draft a manual invoice that billing then issues', async () => {
    const { client: csr } = await signedIn(ctx, 'csr');
    const child = family.students[0]!;
    const created = await csr.post('/invoices', {
      familyId: family.id,
      issue: true,
      dueDate: '2026-12-15',
      lines: [{ description: 'Placement test', amount: '15', studentId: child.id }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'draft', number: null, total: '15.00' });
    const id = created.body.data.id as number;

    expect((await csr.post(`/invoices/${id}/issue`)).status).toBe(403);
    const issued = await billing.post(`/invoices/${id}/issue`);
    expect(issued.status).toBe(200);
    expect(issued.body.data).toMatchObject({
      status: 'issued',
      number: 'INV-2026-000002',
      dueDate: '2026-12-15',
      issueDate: '2026-12-02',
    });
    const again = await billing.post(`/invoices/${id}/issue`);
    expect(again.status).toBe(422);
    expect(again.body.code).toBe('not_draft');

    // Another family's child cannot be put on the invoice.
    const stranger = await billingFamily(ctx, 'USD', [await makeFeePackage(ctx)]);
    const res = await billing.post('/invoices', {
      familyId: family.id,
      lines: [{ description: 'X', amount: '1', studentId: stranger.students[0]!.id }],
    });
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty(['lines.0.studentId']);
    // No currency: refused.
    const noCurrency = await billingFamily(ctx, null);
    expect(
      (
        await billing.post('/invoices', {
          familyId: noCurrency.id,
          lines: [{ description: 'X', amount: '1' }],
        })
      ).body.code,
    ).toBe('missing_currency');
    expect(
      (
        await billing.post('/invoices', {
          familyId: 999999,
          lines: [{ description: 'X', amount: '1' }],
        })
      ).status,
    ).toBe(404);
  });

  it('issues a draft with the default due date (billing.default_due_days)', async () => {
    const created = await billing.post('/invoices', {
      familyId: family.id,
      issue: true,
      lines: [{ description: 'Books', amount: '12.34' }],
    });
    expect(created.body.data).toMatchObject({
      status: 'issued',
      dueDate: '2026-12-09',
      total: '12.34',
    });
  });

  it('lists invoices with status tabs, overdue, search, period and the KPI summary', async () => {
    const other = await billingFamily(ctx, 'GBP', [await makeFeePackage(ctx, { GBP: '50.00' })]);
    const gbp = await issuedInvoice(ctx, other);
    await billing.post(`/invoices/${gbp.id}/payments`, {
      method: 'cash',
      amount: '50',
      receivedOn: '2026-12-02',
    });
    await billing.post('/invoices', {
      familyId: family.id,
      lines: [{ description: 'Draft', amount: '1' }],
    });

    let res = await billing.get('/invoices');
    expect(res.body.data).toHaveLength(3);
    expect(res.body.meta).toMatchObject({
      total: 3,
      counts: { all: 3, draft: 1, issued: 1, paid: 1, open: 1, overdue: 0 },
    });
    expect((await billing.get('/invoices?status=paid')).body.data[0].currency).toBe('GBP');
    expect((await billing.get('/invoices?status=open')).body.data).toHaveLength(1);
    expect((await billing.get('/invoices?status=overdue')).body.data).toHaveLength(0);
    expect((await billing.get('/invoices?q=INV-2026-000001')).body.data).toHaveLength(1);
    expect((await billing.get('/invoices?period=2026-12')).body.data).toHaveLength(2);
    expect((await billing.get(`/invoices?familyId=${other.id}`)).body.data).toHaveLength(1);
    expect((await billing.get('/invoices?status=nope')).status).toBe(422);

    clock(ctx).set('2026-12-10T09:00:00Z'); // the due date 2026-12-07 has passed
    res = await billing.get('/invoices?status=overdue');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].isOverdue).toBe(true);
    res = await billing.get('/billing/summary');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      month: '2026-12',
      byCurrency: [
        { currency: 'GBP', collectedThisMonth: '50.00', due: '0.00' },
        { currency: 'USD', overdue: '60.00', overdueCount: 1, due: '60.00', openCount: 1 },
      ],
      counts: { overdue: 1, paid: 1, issued: 1, draft: 1 },
    });
  });

  it('keeps the summary to billing, finance and the managers', async () => {
    for (const [role, status] of [
      ['accounts', 200],
      ['senior_manager', 200],
      ['manager', 403],
      ['csr', 403],
      ['parent', 403],
    ] as const) {
      const { client } = await signedIn(ctx, role);
      expect((await client.get('/billing/summary')).status, role).toBe(status);
    }
  });
});
