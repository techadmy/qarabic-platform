import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, resetState, signedIn, type TestContext } from './helpers.js';

/*
| D1 (docs/40, D144 / B124): accounts keep a monthly rate per currency to USD; billing and the
| owner read it. Every change is audited with the old value; a delete needs a reason.
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
});

describe('exchange rates', () => {
  it('accounts set, change and delete a rate; each step is audited', async () => {
    const { client: accounts } = await signedIn(ctx, 'accounts');
    const set = await accounts.put('/accounting/exchange-rates', {
      currency: 'gbp',
      month: '2026-11',
      rateToUsd: '1.2700',
      note: 'Monthly average',
    });
    expect(set.status).toBe(200);
    expect(set.body.data).toMatchObject({
      currency: 'GBP',
      month: '2026-11',
      rateToUsd: '1.27',
      note: 'Monthly average',
      updatedBy: { name: expect.any(String) },
    });

    // A rate already set is never overwritten silently: 409 with the current rate.
    const again = await accounts.put('/accounting/exchange-rates', {
      currency: 'GBP',
      month: '2026-11',
      rateToUsd: '1.2712',
    });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'rate_exists', data: { rateToUsd: '1.27' } });
    const noReason = await accounts.put('/accounting/exchange-rates', {
      currency: 'GBP',
      month: '2026-11',
      rateToUsd: '1.2712',
      replace: true,
    });
    expect(noReason.status).toBe(422);
    expect(noReason.body.errors).toHaveProperty('reason');
    const changed = await accounts.put('/accounting/exchange-rates', {
      currency: 'GBP',
      month: '2026-11',
      rateToUsd: '1.2712',
      replace: true,
      reason: 'Bank statement average',
    });
    expect(changed.status).toBe(200);
    expect(changed.body.data).toMatchObject({ id: set.body.data.id, rateToUsd: '1.2712' });
    expect(changed.body.data.note).toBe('Monthly average');
    expect(await ctx.prisma.exchangeRate.count()).toBe(1);

    const list = await accounts.get(
      '/accounting/exchange-rates?currency=GBP&from=2026-01&to=2026-12',
    );
    expect(list.body.data).toHaveLength(1);

    const noDeleteReason = await accounts.delete(
      `/accounting/exchange-rates/${set.body.data.id}`,
      {},
    );
    expect(noDeleteReason.status).toBe(422);
    const gone = await accounts.delete(`/accounting/exchange-rates/${set.body.data.id}`, {
      reason: 'Entered for the wrong month',
    });
    expect(gone.status).toBe(200);
    expect(await ctx.prisma.exchangeRate.count()).toBe(0);
    expect(
      (await accounts.delete(`/accounting/exchange-rates/${set.body.data.id}`, { reason: 'again' }))
        .status,
    ).toBe(404);

    const audit = await ctx.prisma.auditLog.findMany({
      where: { subjectType: 'exchange_rate' },
      orderBy: { id: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual([
      'exchange_rate_set',
      'exchange_rate_replaced',
      'exchange_rate_deleted',
    ]);
    expect(audit[1]!.before).toMatchObject({ rateToUsd: '1.27' });
    expect(audit[1]!.after).toMatchObject({ rateToUsd: '1.2712' });
    expect(audit[1]!.reason).toBe('Bank statement average');
    expect(audit[1]!.actorId).toEqual(expect.any(Number));
    expect(audit[2]!.reason).toBe('Entered for the wrong month');
  });

  it('refuses USD, a zero rate and a bad month', async () => {
    const { client: accounts } = await signedIn(ctx, 'accounts');
    for (const body of [
      { currency: 'USD', month: '2026-11', rateToUsd: '1' },
      { currency: 'GBP', month: '2026-11', rateToUsd: '0' },
      { currency: 'GBP', month: '2026-13', rateToUsd: '1.2' },
    ]) {
      expect((await accounts.put('/accounting/exchange-rates', body)).status).toBe(422);
    }
  });

  it('billing reads but cannot write; a manager, teacher and parent cannot read', async () => {
    const { client: accounts } = await signedIn(ctx, 'accounts');
    await accounts.put('/accounting/exchange-rates', {
      currency: 'EGP',
      month: '2026-11',
      rateToUsd: '0.0205',
    });
    const { client: billing } = await signedIn(ctx, 'billing');
    expect((await billing.get('/accounting/exchange-rates')).body.data).toHaveLength(1);
    expect(
      (
        await billing.put('/accounting/exchange-rates', {
          currency: 'EGP',
          month: '2026-11',
          rateToUsd: '1',
        })
      ).status,
    ).toBe(403);
    for (const role of ['manager', 'teacher', 'parent']) {
      const { client } = await signedIn(ctx, role);
      expect((await client.get('/accounting/exchange-rates')).status).toBe(403);
    }
    const anon = await request(ctx.app.getHttpServer()).get('/api/v1/accounting/exchange-rates');
    expect(anon.status).toBe(401);
  });
});
