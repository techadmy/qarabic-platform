import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, resetState, signedIn, type TestContext } from './helpers.js';
import { billingFamily, issuedInvoice, makeFeePackage, resetBilling } from './n6-helpers.js';
import { m6At, m6Enrollment, m6Session, m6Teacher, userWithRole } from './payroll-helpers.js';

/*
| M7 against the real billing (N6) and payroll (N7) services: their outbox events become journal
| entries, and the books balance per currency afterwards.
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
});

const codes = (lines: Array<{ accountCode: string; debit: string; credit: string }>) =>
  lines.map((l) => [l.accountCode, l.debit, l.credit]);

describe('ledger from live billing and payroll', () => {
  it('posts an issued invoice and its manual payment (USD) and balances', async () => {
    m6At(ctx, '2026-12-01T08:00:00Z');
    const family = await billingFamily(ctx, 'USD', [await makeFeePackage(ctx, { USD: '60.00' })]);
    const invoice = await issuedInvoice(ctx, family);
    const { client: billing } = await signedIn(ctx, 'billing');
    const paid = await billing.post(`/invoices/${invoice.id}/payments`, {
      method: 'bank_transfer',
      amount: '20',
      receivedOn: '2026-12-01',
      reference: 'TRX-1',
    });
    expect(paid.status).toBe(201);

    const { client: accounts } = await signedIn(ctx, 'accounts');
    expect((await accounts.post('/accounting/outbox/process')).body.data).toMatchObject({
      posted: 2,
      failed: 0,
    });
    const list = (await accounts.get('/accounting/journal?source=billing')).body.data;
    expect(list).toHaveLength(2);
    const lines = await Promise.all(
      list.map(
        async (e: {
          id: number;
        }): Promise<Array<{ accountCode: string; debit: string; credit: string }>> =>
          (
            (await accounts.get(`/accounting/journal/${e.id}`)).body as {
              data: { lines: Array<{ accountCode: string; debit: string; credit: string }> };
            }
          ).data.lines,
      ),
    );
    expect(lines.map(codes)).toEqual(
      expect.arrayContaining([
        [
          ['1210', '60.00', '0.00'],
          ['4100', '0.00', '60.00'],
        ],
        [
          ['1120', '20.00', '0.00'],
          ['1210', '0.00', '20.00'],
        ],
      ]),
    );
    const tb = (
      await accounts.get(
        '/accounting/reports/trial-balance?currency=USD&from=2026-12-01&to=2026-12-31',
      )
    ).body.data;
    expect(tb.balanced).toBe(true);
    expect(tb.rows.find((r: { code: string }) => r.code === '1210').closingDebit).toBe('40.00');
  });

  it('posts payslip approval and payment (PKR): expense → wallet → Vodafone Cash', async () => {
    m6At(ctx, '2026-11-15T08:00:00Z');
    const teacher = await m6Teacher(ctx, { hourlyRate: '300.00' });
    await m6Session(ctx, await m6Enrollment(ctx, teacher), '2026-10-05T10:00:00Z', 'taken');
    const { client: accounts } = await userWithRole(ctx, 'accounts');
    const runId = (await accounts.post('/payroll/runs', { period: '2026-10' })).body.data.id;
    const { client: senior } = await userWithRole(ctx, 'senior_manager');
    expect((await senior.post(`/payroll/runs/${runId}/review`)).status).toBe(200);
    expect((await accounts.post(`/payroll/runs/${runId}/approve`)).status).toBe(200);
    const slip = await ctx.prisma.payslip.findFirstOrThrow({ where: { userId: teacher.userId } });
    const pay = await accounts.post(`/payslips/${slip.id}/payments`, {
      method: 'vodafone_cash',
      reference: 'VC-1',
      paidOn: '2026-11-14',
    });
    expect(pay.status).toBe(200);

    const run = (await accounts.post('/accounting/outbox/process')).body.data;
    expect(run).toMatchObject({ posted: 2, failed: 0 });
    const entries = (await accounts.get('/accounting/journal?source=payroll&currency=PKR')).body
      .data;
    expect(entries).toHaveLength(2);
    const net = slip.net.toFixed(2);
    const bs = (
      await accounts.get('/accounting/reports/balance-sheet?currency=PKR&asOf=2026-11-30')
    ).body.data;
    expect(bs.balanced).toBe(true);
    expect(bs.retainedEarnings).toBe(`-${net}`);
    const cash = (
      await accounts.get('/accounting/reports/cash?currency=PKR&from=2026-11-01&to=2026-11-30')
    ).body.data;
    expect(cash.currencies[0].accounts[0]).toMatchObject({ code: '1150', outflow: net });
    // The wallet (salaries payable) is back to zero after the payment.
    expect(bs.liabilities.rows).toEqual([]);
  });
});
