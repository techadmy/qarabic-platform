import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvoiceService } from '../src/billing/invoices.service.js';
import { clock, createTestApp, resetState, signedIn, type TestContext } from './helpers.js';
import { billingFamily, issuedInvoice, makeFeePackage, resetBilling } from './n6-helpers.js';

/*
| P2-2 (docs/39 BIL-7, BIL-8, BIL-9, BIL-11, BIL-12): ledger dating and small money fixes.
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
  clock(ctx).set('2026-12-02T09:00:00Z');
});

describe('BIL-8 a manual payment is posted on the day the money came in', () => {
  it('cash received yesterday, recorded today → the journal entry is dated yesterday', async () => {
    const family = await billingFamily(ctx, 'USD', [await makeFeePackage(ctx, { USD: '60.00' })]);
    const invoice = await issuedInvoice(ctx, family);
    const { client: billing } = await signedIn(ctx, 'billing');
    const paid = await billing.post(`/invoices/${invoice.id}/payments`, {
      method: 'cash',
      amount: '60',
      receivedOn: '2026-12-01',
    });
    expect(paid.status).toBe(201);
    const { client: accounts } = await signedIn(ctx, 'admin'); // D146: the owner keeps the books
    const run = await accounts.post('/accounting/outbox/process');
    expect(run.body.data).toMatchObject({ failed: 0 });
    const entry = await ctx.prisma.journalEntry.findFirstOrThrow({
      where: { memo: { contains: `Payment #${paid.body.data.id}` } },
    });
    expect(entry.entryDate.toISOString().slice(0, 10)).toBe('2026-12-01');
  });
});

describe('BIL-9 a payslip payment date is not in the future', () => {
  it('tomorrow → 422 on paidOn', async () => {
    const { client: accounts } = await signedIn(ctx, 'admin'); // D146: the owner keeps the books
    const res = await accounts.post('/payslips/1/payments', {
      method: 'cash',
      paidOn: '2026-12-03',
    });
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty('paidOn');
  });
});

describe('BIL-11 one payment per provider payment id', () => {
  it('a second row with the same (method, provider payment id) is refused by the database', async () => {
    const family = await billingFamily(ctx, 'USD', [await makeFeePackage(ctx, { USD: '60.00' })]);
    const invoice = await issuedInvoice(ctx, family);
    const row = {
      invoiceId: invoice.id,
      familyId: family.id,
      method: 'stripe' as const,
      status: 'succeeded' as const,
      amount: '10.00',
      currency: 'USD',
      providerPaymentId: 'pi_same',
    };
    await ctx.prisma.payment.create({ data: { ...row, providerRef: 'cs_1' } });
    await expect(
      ctx.prisma.payment.create({ data: { ...row, providerRef: 'cs_2' } }),
    ).rejects.toThrow();
  });
});

describe('BIL-7 an invoice run keeps its audit and emails when a family fails', () => {
  it('family 2 fails; family 1 is issued, audited in the run and reported', async () => {
    const pkg = await makeFeePackage(ctx, { USD: '60.00' });
    const first = await billingFamily(ctx, 'USD', [pkg]);
    const second = await billingFamily(ctx, 'USD', [pkg]);
    const service = ctx.app.get(InvoiceService);
    const target = service as unknown as {
      issueLocked: (tx: unknown, inv: { familyId: number }, actor: unknown) => Promise<unknown>;
    };
    const original = target.issueLocked.bind(service);
    const spy = vi
      .spyOn(target, 'issueLocked')
      .mockImplementation((tx, inv, actor) =>
        inv.familyId === second.id ? Promise.reject(new Error('boom')) : original(tx, inv, actor),
      );
    try {
      const result = await service.run('2026-12', 1, '2026-12-07', null, [first.id, second.id]);
      expect(result.issued).toHaveLength(1);
      expect(result.skipped).toEqual([{ familyId: second.id, reason: 'error' }]);
    } finally {
      spy.mockRestore();
    }
    expect(await ctx.prisma.auditLog.count({ where: { action: 'invoice_run' } })).toBe(1);
    expect(
      await ctx.prisma.invoice.count({ where: { familyId: first.id, status: 'issued' } }),
    ).toBe(1);
  });
});

describe('BIL-12 closing a month waits for an entry being posted to it', () => {
  it('the close blocks while a posting holds the month', async () => {
    clock(ctx).set('2026-12-10T09:00:00Z');
    const { client: accounts } = await signedIn(ctx, 'admin'); // D146: the owner keeps the books
    let closedAt = 0;
    const holder = ctx.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext('ledger_period:2026-11'))`;
      await new Promise((r) => setTimeout(r, 800));
    });
    const started = Date.now();
    const close = accounts.post('/accounting/periods/2026-11/close').then((r) => {
      closedAt = Date.now();
      return r;
    });
    await holder;
    const res = await close;
    expect(res.status).toBe(200);
    expect(closedAt - started).toBeGreaterThanOrEqual(600);
  });
});
