import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clock,
  type Client,
  createTestApp,
  resetState,
  signedIn,
  type TestContext,
} from './helpers.js';

/*
| M7 accounting (docs/09 M14, docs/07 §أ): chart of accounts, manual entries and reversals, receipt
| and payment vouchers, the billing/payroll outbox consumer, period close and the reports. Books
| are per currency; every entry balances (API + deferred trigger). The clock is pinned to
| 2026-11-15 (Cairo).
*/

let ctx: TestContext;
let accounts: Client;
let ids: Record<string, number>;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});
beforeEach(async () => {
  await resetState(ctx);
  clock(ctx).set('2026-11-15T08:00:00Z');
  accounts = (await signedIn(ctx, 'accounts')).client;
  const rows = await ctx.prisma.ledgerAccount.findMany({ select: { id: true, code: true } });
  ids = Object.fromEntries(rows.map((r) => [r.code, r.id]));
});

const entry = (lines: Array<[string, string | null, string | null]>, extra: object = {}) => ({
  date: '2026-11-10',
  currency: 'USD',
  memo: 'Opening balance',
  lines: lines.map(([code, debit, credit]) => ({
    accountId: ids[code],
    ...(debit ? { debit } : {}),
    ...(credit ? { credit } : {}),
  })),
  ...extra,
});

async function billingEvent(
  type: string,
  amount: string,
  over: { currency?: string; payload?: object; occurredAt?: string; subjectId?: number } = {},
) {
  return ctx.prisma.billingEvent.create({
    data: {
      type,
      subjectType: type.startsWith('payment') ? 'payment' : 'invoice',
      subjectId: over.subjectId ?? 1,
      familyId: 3,
      amount,
      currency: over.currency ?? 'USD',
      payload: over.payload ?? { number: 'INV-2026-0001', method: 'stripe' },
      occurredAt: new Date(over.occurredAt ?? '2026-11-05T10:00:00Z'),
    },
  });
}

describe('permissions (docs/07 §ب)', () => {
  it('lets the senior manager read but not post; other roles get 403', async () => {
    const { client: senior } = await signedIn(ctx, 'senior_manager');
    expect((await senior.get('/accounting/accounts')).status).toBe(200);
    expect(
      (
        await senior.get(
          '/accounting/reports/trial-balance?currency=USD&from=2026-11-01&to=2026-11-30',
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await senior.post(
          '/accounting/journal',
          entry([
            ['1110', '10', null],
            ['3100', null, '10'],
          ]),
        )
      ).status,
    ).toBe(403);
    expect((await senior.post('/accounting/outbox/process')).status).toBe(403);
    for (const role of ['manager', 'monitor', 'csr', 'billing', 'teacher', 'parent']) {
      const { client } = await signedIn(ctx, role);
      for (const path of [
        '/accounting/accounts',
        '/accounting/journal',
        '/accounting/vouchers',
        '/accounting/periods?year=2026',
        '/accounting/outbox',
        '/accounting/reports/cash?from=2026-11-01&to=2026-11-30',
      ]) {
        expect((await client.get(path)).status, `${role} ${path}`).toBe(403);
      }
      expect((await client.post('/accounting/vouchers', {})).status, role).toBe(403);
    }
  });
});

describe('chart of accounts', () => {
  it('lists the seeded chart, adds an account under a group and refuses bad ones', async () => {
    const list = await accounts.get('/accounting/accounts?only=postable&type=expense');
    expect(list.status).toBe(200);
    expect(
      list.body.data.every(
        (a: { isGroup: boolean; type: string }) => !a.isGroup && a.type === 'expense',
      ),
    ).toBe(true);

    const created = await accounts.post('/accounting/accounts', {
      code: '5285',
      nameAr: 'اشتراكات البرمجيات',
      nameEn: 'Software subscriptions',
      type: 'expense',
      parentId: ids['52'],
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ code: '5285', isGroup: false, systemKey: null });

    const taken = await accounts.post('/accounting/accounts', {
      code: '5285',
      nameAr: 'مكرر',
      nameEn: 'Dup',
      type: 'expense',
      parentId: ids['52'],
    });
    expect(taken.body.code).toBe('code_taken');
    const wrongType = await accounts.post('/accounting/accounts', {
      code: '5286',
      nameAr: 'خطأ',
      nameEn: 'Wrong',
      type: 'income',
      parentId: ids['52'],
    });
    expect(wrongType.body.code).toBe('parent_invalid');
    const leafParent = await accounts.post('/accounting/accounts', {
      code: '5287',
      nameAr: 'خطأ',
      nameEn: 'Wrong',
      type: 'expense',
      parentId: ids['5130'],
    });
    expect(leafParent.body.code).toBe('parent_invalid');

    const archiveSystem = await accounts.patch(`/accounting/accounts/${ids['1210']}`, {
      isActive: false,
    });
    expect(archiveSystem.status).toBe(409);
    expect(archiveSystem.body.code).toBe('system_account');
    const cycle = await accounts.patch(`/accounting/accounts/${ids['5']}`, { parentId: ids['52'] });
    expect(cycle.body.code).toBe('parent_invalid');
    const renamed = await accounts.patch(`/accounting/accounts/${created.body.data.id}`, {
      nameEn: 'SaaS',
      isActive: false,
    });
    expect(renamed.body.data).toMatchObject({ nameEn: 'SaaS', isActive: false });
    expect(await ctx.prisma.auditLog.count({ where: { subjectType: 'ledger_account' } })).toBe(2);
  });
});

describe('journal', () => {
  it('posts a balanced manual entry, numbers it and refuses unbalanced or unpostable lines', async () => {
    const ok = await accounts.post(
      '/accounting/journal',
      entry([
        ['1120', '1000.50', null],
        ['3100', null, '1000.5'],
      ]),
    );
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({
      number: 'JE-2026-000001',
      source: 'manual',
      total: '1000.50',
      currency: 'USD',
    });
    expect(ok.body.data.lines).toHaveLength(2);

    const unbalanced = await accounts.post(
      '/accounting/journal',
      entry([
        ['1120', '10', null],
        ['3100', null, '9.99'],
      ]),
    );
    expect(unbalanced.status).toBe(422);
    expect(unbalanced.body.code).toBe('unbalanced');
    const group = await accounts.post(
      '/accounting/journal',
      entry([
        ['11', '10', null],
        ['3100', null, '10'],
      ]),
    );
    expect(group.body.code).toBe('account_not_postable');
    const bothSides = await accounts.post('/accounting/journal', {
      ...entry([
        ['1120', '10', null],
        ['3100', null, '10'],
      ]),
      lines: [
        { accountId: ids['1120'], debit: '10', credit: '10' },
        { accountId: ids['3100'], credit: '10' },
      ],
    });
    expect(bothSides.status).toBe(422);
    const oneLine = await accounts.post('/accounting/journal', {
      ...entry([]),
      lines: [{ accountId: ids['1120'], debit: '1' }],
    });
    expect(oneLine.status).toBe(422);

    await ctx.prisma.ledgerAccount.update({
      where: { id: ids['1120']! },
      data: { currency: 'EGP' },
    });
    const currency = await accounts.post(
      '/accounting/journal',
      entry([
        ['1120', '10', null],
        ['3100', null, '10'],
      ]),
    );
    expect(currency.body.code).toBe('account_currency');

    const list = await accounts.get('/accounting/journal?currency=USD&q=opening');
    expect(list.body.meta.total).toBe(1);
    expect(list.body.data[0].lines).toBeUndefined();
  });

  it('reverses an entry once; the journal itself is append-only in the database', async () => {
    const id = (
      await accounts.post(
        '/accounting/journal',
        entry([
          ['5130', '300', null],
          ['1110', null, '300'],
        ]),
      )
    ).body.data.id;
    const rev = await accounts.post(`/accounting/journal/${id}/reverse`, {
      reason: 'Posted twice',
    });
    expect(rev.status).toBe(201);
    expect(rev.body.data).toMatchObject({ source: 'reversal', reversesId: id, date: '2026-11-15' });
    expect(
      rev.body.data.lines.map((l: { debit: string; credit: string }) => [l.debit, l.credit]),
    ).toEqual([
      ['0.00', '300.00'],
      ['300.00', '0.00'],
    ]);
    expect((await accounts.get(`/accounting/journal/${id}`)).body.data.reversedById).toBe(
      rev.body.data.id,
    );
    const again = await accounts.post(`/accounting/journal/${id}/reverse`, {
      reason: 'Posted twice',
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('already_reversed');
    expect(
      (await accounts.post('/accounting/journal/999/reverse', { reason: 'missing' })).status,
    ).toBe(404);

    await expect(ctx.prisma.journalLine.updateMany({ data: { debit: '1' } })).rejects.toThrow();
    await expect(ctx.prisma.journalEntry.deleteMany({})).rejects.toThrow();
    // A lone unbalanced line is refused at commit by the deferred trigger.
    await expect(
      ctx.prisma.journalLine.create({
        data: {
          entryId: id,
          accountId: ids['1110']!,
          currency: 'USD',
          entryDate: new Date('2026-11-10'),
          debit: '5',
        },
      }),
    ).rejects.toThrow(/does not balance/);
  });
});

describe('vouchers', () => {
  it('posts a payment voucher (Dr expenses / Cr cash) and voids it with a reversing entry', async () => {
    const res = await accounts.post('/accounting/vouchers', {
      type: 'payment',
      date: '2026-11-12',
      currency: 'EGP',
      cashAccountId: ids['1110'],
      party: 'Office landlord',
      description: 'November rent and internet',
      reference: 'R-77',
      lines: [
        { accountId: ids['5130'], amount: '5000' },
        { accountId: ids['5150'], amount: '450.25', description: 'Fibre' },
      ],
    });
    expect(res.status).toBe(201);
    const v = res.body.data;
    expect(v).toMatchObject({ number: 'PV-2026-00001', amount: '5450.25', status: 'posted' });
    const je = (await accounts.get(`/accounting/journal/${v.journalEntryId}`)).body.data;
    expect(je).toMatchObject({
      source: 'voucher',
      voucherId: v.id,
      currency: 'EGP',
      total: '5450.25',
    });
    expect(je.lines[0]).toMatchObject({ accountCode: '1110', credit: '5450.25' });

    const rv = await accounts.post('/accounting/vouchers', {
      type: 'receipt',
      date: '2026-11-12',
      currency: 'EGP',
      cashAccountId: ids['1120'],
      party: 'Owner',
      description: 'Capital injection',
      lines: [{ accountId: ids['3100'], amount: '10000' }],
    });
    expect(rv.body.data.number).toBe('RV-2026-00001');

    const viaJournal = await accounts.post(`/accounting/journal/${v.journalEntryId}/reverse`, {
      reason: 'wrong way',
    });
    expect(viaJournal.body.code).toBe('reverse_voucher_entry');

    const voided = await accounts.post(`/accounting/vouchers/${v.id}/void`, {
      reason: 'Paid by the owner personally',
    });
    expect(voided.status).toBe(200);
    expect(voided.body.data).toMatchObject({
      status: 'void',
      voidReason: 'Paid by the owner personally',
    });
    expect(
      (await accounts.post(`/accounting/vouchers/${v.id}/void`, { reason: 'again!' })).body.code,
    ).toBe('voucher_void');

    const list = await accounts.get('/accounting/vouchers?status=posted');
    expect(list.body.meta.counts).toMatchObject({ all: 2, posted: 1, void: 1 });
    expect(list.body.data).toHaveLength(1);

    const notCash = await accounts.post('/accounting/vouchers', {
      type: 'payment',
      date: '2026-11-12',
      currency: 'EGP',
      cashAccountId: ids['5130'],
      party: 'X Co',
      description: 'Wrong',
      lines: [{ accountId: ids['5150'], amount: '1' }],
    });
    expect(notCash.body.code).toBe('account_not_postable');
    const zero = await accounts.post('/accounting/vouchers', {
      type: 'payment',
      date: '2026-11-12',
      currency: 'EGP',
      cashAccountId: ids['1110'],
      party: 'X Co',
      description: 'Zero',
      lines: [{ accountId: ids['5150'], amount: '0' }],
    });
    expect(zero.status).toBe(422);
  });
});

describe('automatic entries from the outboxes (D86, D95)', () => {
  it('posts billing and payroll events once, marks them consumed and lists failures', async () => {
    const issued = await billingEvent('invoice.issued', '120.00');
    await billingEvent('payment.succeeded', '120.00', { subjectId: 4 });
    await billingEvent('invoice.teleported', '1.00');
    await ctx.prisma.payrollEvent.create({
      data: {
        type: 'payslip.approved',
        aggregateType: 'Payslip',
        aggregateId: 8,
        occurredAt: new Date('2026-11-02T09:00:00Z'),
        payload: {
          period: '2026-10',
          userId: 2,
          currency: 'EGP',
          net: '2900.00',
          lines: [
            { code: 'hour_earning', sign: 1, amount: '3000.00' },
            { code: 'fine', sign: -1, amount: '100.00' },
          ],
        },
      },
    });
    await ctx.prisma.payrollEvent.create({
      data: {
        type: 'payroll_run.approved',
        aggregateType: 'PayrollRun',
        aggregateId: 1,
        occurredAt: new Date('2026-11-02T09:00:00Z'),
        payload: {},
      },
    });

    const pending = await accounts.get('/accounting/outbox');
    expect(pending.body.data.pending).toEqual({ billing: 3, payroll: 2 });

    const run = await accounts.post('/accounting/outbox/process');
    expect(run.body.data).toEqual({ posted: 3, skipped: 1, failed: 1 });
    expect(
      (await ctx.prisma.billingEvent.findUniqueOrThrow({ where: { id: issued.id } })).consumedAt,
    ).not.toBeNull();

    const status = (await accounts.get('/accounting/outbox')).body.data;
    expect(status.pending).toEqual({ billing: 1, payroll: 0 });
    expect(status.failures).toMatchObject([
      { source: 'billing', eventType: 'invoice.teleported', attempts: 1 },
    ]);

    const again = await accounts.post('/accounting/outbox/process');
    expect(again.body.data).toEqual({ posted: 0, skipped: 0, failed: 1 });
    expect((await accounts.get('/accounting/outbox')).body.data.failures[0].attempts).toBe(2);

    const journal = (await accounts.get('/accounting/journal?source=billing')).body;
    expect(journal.meta.total).toBe(2);
    // Source tabs count over the same filters, ignoring the source filter.
    expect(journal.meta.counts).toEqual({
      all: 3,
      manual: 0,
      voucher: 0,
      billing: 2,
      payroll: 1,
      reversal: 0,
    });
    const inv = journal.data.find(
      (e: { sourceRef: string }) => e.sourceRef === `billing_event:${issued.id}`,
    );
    expect(inv).toMatchObject({ date: '2026-11-05', currency: 'USD', total: '120.00' });

    const slip = (await accounts.get('/accounting/journal?source=payroll')).body.data[0];
    const full = (await accounts.get(`/accounting/journal/${slip.id}`)).body.data;
    expect(
      full.lines.map((l: { accountCode: string; debit: string; credit: string }) => [
        l.accountCode,
        l.debit,
        l.credit,
      ]),
    ).toEqual([
      ['5110', '3000.00', '0.00'],
      ['4200', '0.00', '100.00'],
      ['2110', '0.00', '2900.00'],
    ]);
    expect(full.lines[2]).toMatchObject({ partyType: 'user', partyId: 2 });
  });
});

describe('period close', () => {
  it('closes an ended month without pending events, refuses entries in it and reopens with a reason', async () => {
    expect((await accounts.post('/accounting/periods/2026-11/close')).body.code).toBe(
      'period_not_ended',
    );
    await billingEvent('invoice.issued', '50.00', { occurredAt: '2026-10-20T10:00:00Z' });
    expect((await accounts.post('/accounting/periods/2026-10/close')).body.code).toBe(
      'outbox_pending',
    );
    await accounts.post('/accounting/outbox/process');

    const closed = await accounts.post('/accounting/periods/2026-10/close');
    expect(closed.status).toBe(200);
    expect(closed.body.data[9]).toMatchObject({ period: '2026-10', status: 'closed', entries: 1 });
    expect((await accounts.post('/accounting/periods/2026-10/close')).body.code).toBe(
      'period_already_closed',
    );

    const late = await accounts.post(
      '/accounting/journal',
      entry(
        [
          ['1110', '5', null],
          ['3100', null, '5'],
        ],
        { date: '2026-10-31' },
      ),
    );
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('period_closed');

    // An automatic entry of a closed month is dated on the first open day after it.
    await billingEvent('invoice.issued', '70.00', {
      occurredAt: '2026-10-25T10:00:00Z',
      subjectId: 2,
    });
    await accounts.post('/accounting/outbox/process');
    const moved = (await accounts.get('/accounting/journal?source=billing&from=2026-11-01')).body
      .data[0];
    expect(moved.date).toBe('2026-11-01');
    expect(moved.memo).toContain('(dated 2026-10-25)');

    expect(
      (await accounts.post('/accounting/periods/2026-10/reopen', { reason: 'x' })).status,
    ).toBe(422);
    const reopened = await accounts.post('/accounting/periods/2026-10/reopen', {
      reason: 'Late bank charge',
    });
    expect(reopened.body.data[9]).toMatchObject({
      status: 'open',
      reopenReason: 'Late bank charge',
    });
    expect(
      (
        await accounts.post(
          '/accounting/journal',
          entry(
            [
              ['5320', '5', null],
              ['1120', null, '5'],
            ],
            { date: '2026-10-31' },
          ),
        )
      ).status,
    ).toBe(201);
    expect((await accounts.post('/accounting/periods/2026-13/close')).status).toBe(404);
    expect(await ctx.prisma.auditLog.count({ where: { subjectType: 'accounting_period' } })).toBe(
      2,
    );
  });
});

describe('reports', () => {
  beforeEach(async () => {
    const post = async (
      date: string,
      currency: string,
      lines: Array<[string, string | null, string | null]>,
    ) => {
      const res = await accounts.post('/accounting/journal', entry(lines, { date, currency }));
      expect(res.status).toBe(201);
    };
    await post('2026-10-01', 'USD', [
      ['1120', '1000', null],
      ['3100', null, '1000'],
    ]);
    await post('2026-11-02', 'USD', [
      ['1210', '400', null],
      ['4100', null, '400'],
    ]);
    await post('2026-11-03', 'USD', [
      ['1130', '300', null],
      ['1210', null, '300'],
    ]);
    await post('2026-11-04', 'USD', [
      ['5130', '150', null],
      ['1120', null, '150'],
    ]);
    await post('2026-11-05', 'USD', [
      ['4150', '20', null],
      ['1210', null, '20'],
    ]);
    await post('2026-11-05', 'EGP', [
      ['1110', '999', null],
      ['3100', null, '999'],
    ]);
  });

  it('trial balance: opening, period and closing columns that balance', async () => {
    const tb = (
      await accounts.get(
        '/accounting/reports/trial-balance?currency=USD&from=2026-11-01&to=2026-11-30',
      )
    ).body.data;
    expect(tb.balanced).toBe(true);
    expect(tb.totals).toMatchObject({
      openingDebit: '1000.00',
      openingCredit: '1000.00',
      periodDebit: '870.00',
      periodCredit: '870.00',
    });
    const bank = tb.rows.find((r: { code: string }) => r.code === '1120');
    expect(bank).toMatchObject({
      openingDebit: '1000.00',
      periodCredit: '150.00',
      closingDebit: '850.00',
    });
    expect(tb.rows.some((r: { code: string }) => r.code === '1110')).toBe(false);
  });

  it('profit and loss, balance sheet (balanced, with the result in equity) and cash per currency', async () => {
    const pl = (
      await accounts.get(
        '/accounting/reports/profit-and-loss?currency=USD&from=2026-11-01&to=2026-11-30',
      )
    ).body.data;
    expect(pl.income.total).toBe('380.00');
    expect(pl.income.rows.map((r: { code: string; amount: string }) => [r.code, r.amount])).toEqual(
      [
        ['4100', '400.00'],
        ['4150', '-20.00'],
      ],
    );
    expect(pl.expense.total).toBe('150.00');
    expect(pl.netProfit).toBe('230.00');

    const bs = (
      await accounts.get('/accounting/reports/balance-sheet?currency=USD&asOf=2026-11-30')
    ).body.data;
    expect(bs).toMatchObject({
      balanced: true,
      retainedEarnings: '230.00',
      totalLiabilitiesAndEquity: '1230.00',
    });
    expect(bs.assets.total).toBe('1230.00');
    const early = (
      await accounts.get('/accounting/reports/balance-sheet?currency=USD&asOf=2026-10-31')
    ).body.data;
    expect(early).toMatchObject({ balanced: true, retainedEarnings: '0.00' });

    const cash = (await accounts.get('/accounting/reports/cash?from=2026-11-01&to=2026-11-30')).body
      .data;
    expect(cash.currencies.map((c: { currency: string }) => c.currency)).toEqual(['EGP', 'USD']);
    const usd = cash.currencies[1];
    expect(usd).toMatchObject({
      opening: '1000.00',
      inflow: '300.00',
      outflow: '150.00',
      closing: '1150.00',
    });
    expect(usd.accounts.map((a: { code: string }) => a.code)).toEqual(['1120', '1130']);
    const egpOnly = (
      await accounts.get('/accounting/reports/cash?currency=EGP&from=2026-11-01&to=2026-11-30')
    ).body.data;
    expect(egpOnly.currencies).toHaveLength(1);

    expect(
      (
        await accounts.get(
          '/accounting/reports/profit-and-loss?currency=USD&from=2026-11-30&to=2026-11-01',
        )
      ).status,
    ).toBe(422);
    expect(
      (await accounts.get('/accounting/reports/balance-sheet?currency=usdx&asOf=2026-11-30'))
        .status,
    ).toBe(422);
  });

  it('account statement: opening, running balance across pages, closing', async () => {
    const p1 = (
      await accounts.get(
        `/accounting/accounts/${ids['1210']}/statement?currency=USD&from=2026-11-01&to=2026-11-30&perPage=2`,
      )
    ).body;
    expect(p1).toMatchObject({
      opening: '0.00',
      closing: '80.00',
      meta: { total: 3, lastPage: 2 },
    });
    expect(p1.rows.map((r: { balance: string }) => r.balance)).toEqual(['400.00', '100.00']);
    const p2 = (
      await accounts.get(
        `/accounting/accounts/${ids['1210']}/statement?currency=USD&from=2026-11-01&to=2026-11-30&perPage=2&page=2`,
      )
    ).body;
    expect(p2.rows.map((r: { balance: string; credit: string }) => [r.credit, r.balance])).toEqual([
      ['20.00', '80.00'],
    ]);
    const income = (
      await accounts.get(
        `/accounting/accounts/${ids['4100']}/statement?currency=USD&from=2026-10-01&to=2026-11-30`,
      )
    ).body;
    expect(income.closing).toBe('400.00');
    expect(
      (
        await accounts.get(
          '/accounting/accounts/9999/statement?currency=USD&from=2026-11-01&to=2026-11-30',
        )
      ).status,
    ).toBe(404);
  });
});
