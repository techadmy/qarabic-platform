import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { billingCommand } from '../src/billing/cli.js';
import { InvoiceReminderService } from '../src/billing/reminders.service.js';
import {
  type Client,
  clock,
  createTestApp,
  makeFamily,
  makeStudent,
  resetState,
  signedIn,
  type TestContext,
} from './helpers.js';
import {
  billingFamily,
  issuedInvoice,
  makeFeePackage,
  notifyParents,
  resetBilling,
} from './n6-helpers.js';

/*
| Ports of Laravel tests/Feature/M5/InvoiceRunTest.php (D84, D85: preview writes nothing, issue is
| idempotent per family and period, custom fee or the children's packages in the family currency)
| and FamilyBillingAndRemindersTest.php (D84, D88), plus the D140 rule: no email to a family
| while `billing.notify_parents` is off (the default), and the N1 follow-up (archive refused while
| a family has open invoices).
*/

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

const invoiceMails = () => ctx.mailer.sent.filter((m) => m.kind.startsWith('invoice_'));

describe('monthly invoice run', () => {
  let billing: Client;
  let two: { id: number };
  let three: { id: number };

  beforeEach(async () => {
    await resetState(ctx);
    resetBilling(ctx);
    clock(ctx).set('2026-11-25T10:00:00Z');
    ({ client: billing } = await signedIn(ctx, 'billing'));
    two = await makeFeePackage(ctx, { USD: '60.00', GBP: '50.00' });
    three = await makeFeePackage(
      ctx,
      { USD: '90.00' },
      { name: '3 days a week', classesPerWeek: 3 },
    );
  });

  it("previews the sum of the children's packages without writing anything", async () => {
    const family = await billingFamily(ctx, 'USD', [two, three]);
    const res = await billing.post('/invoice-runs/preview', { period: '2026-12' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.meta).toEqual({ families: 1, willIssue: 1, totals: { USD: '150.00' } });
    expect(res.body.data[0]).toMatchObject({
      familyId: family.id,
      total: '150.00',
      periodStart: '2026-12-01',
      periodEnd: '2026-12-31',
      willIssue: true,
      existingInvoiceId: null,
    });
    expect(res.body.data[0].lines).toHaveLength(2);
    expect(await ctx.prisma.invoice.count()).toBe(0);
  });

  it('uses the family custom fee when set (old account.fee)', async () => {
    await billingFamily(ctx, 'GBP', [two, two], { customFee: '88.00' });
    const row = (await billing.post('/invoice-runs/preview', { period: '2026-12' })).body.data[0];
    expect(row).toMatchObject({ total: '88.00', currency: 'GBP' });
    expect(row.lines).toHaveLength(1);
    expect(row.lines[0].meta).toMatchObject({ source: 'custom_fee', children: 2 });
  });

  it('skips a family whose child has no price in the family currency', async () => {
    await billingFamily(ctx, 'GBP', [two, three]); // three has no GBP price
    const row = (await billing.post('/invoice-runs/preview', { period: '2026-12' })).body.data[0];
    expect(row).toMatchObject({ willIssue: false, total: '0.00' });
    const res = await billing.post('/invoice-runs', { period: '2026-12', dueDate: '2026-12-07' });
    expect(res.status).toBe(201);
    expect(res.body.data.issuedCount).toBe(0);
    expect(res.body.data.skipped[0].reason).toMatch(/^missing_price:/);
  });

  it('issues numbered invoices once per family and period and records the ledger event', async () => {
    const a = await billingFamily(ctx, 'USD', [two]);
    await billingFamily(ctx, 'GBP', [two]);
    await billingFamily(ctx, 'USD', [two], { enabled: false });
    await billingFamily(ctx, 'USD', [two], { status: 'suspended' });
    await billingFamily(ctx, 'USD', [two], { billingDay: 15 });

    const res = await billing.post('/invoice-runs', { period: '2026-12', dueDate: '2026-12-07' });
    expect(res.status).toBe(201);
    expect(res.body.data.issuedCount).toBe(2);

    const invoices = await ctx.prisma.invoice.findMany({ orderBy: { id: 'asc' } });
    expect(invoices).toHaveLength(2);
    expect(invoices[0]).toMatchObject({
      familyId: a.id,
      number: 'INV-2026-000001',
      status: 'issued',
    });
    expect(invoices[1]).toMatchObject({ number: 'INV-2026-000002', currency: 'GBP' });
    expect(invoices[1]!.total.toFixed(2)).toBe('50.00');
    expect(invoices[0]!.periodStart?.toISOString().slice(0, 10)).toBe('2026-12-01');
    expect(invoices[0]!.periodEnd?.toISOString().slice(0, 10)).toBe('2026-12-31');
    expect(invoices[0]!.issueDate?.toISOString().slice(0, 10)).toBe('2026-11-25');
    expect(await ctx.prisma.billingEvent.count({ where: { type: 'invoice.issued' } })).toBe(2);
    // D140: parent emails are off by default.
    expect(invoiceMails()).toHaveLength(0);

    // Second run: nothing new.
    const again = await billing.post('/invoice-runs', { period: '2026-12', dueDate: '2026-12-07' });
    expect(again.body.data.issuedCount).toBe(0);
    expect(again.body.data.skipped[0].reason).toBe('exists');
    expect(await ctx.prisma.invoice.count()).toBe(2);
    const preview = await billing.post('/invoice-runs/preview', { period: '2026-12' });
    expect(preview.body.data[0].existingInvoiceId).toBe(invoices[0]!.id);
  });

  it('emails the parent when an invoice is issued, only with billing.notify_parents on', async () => {
    await notifyParents(ctx, true);
    await billingFamily(ctx, 'USD', [two]);
    await billingFamily(ctx, 'GBP', [two]);
    await billing.post('/invoice-runs', { period: '2026-12', dueDate: '2026-12-07' });
    expect(invoiceMails().map((m) => m.kind)).toEqual(['invoice_issued', 'invoice_issued']);
  });

  it('bills the 15th cycle from the 15th to the 14th', async () => {
    const family = await billingFamily(ctx, 'USD', [two], { billingDay: 15 });
    const res = await billing.post('/invoice-runs', {
      period: '2026-12',
      billingDay: 15,
      dueDate: '2026-12-20',
    });
    expect(res.body.data.issuedCount).toBe(1);
    const invoice = await ctx.prisma.invoice.findFirstOrThrow();
    expect(invoice.familyId).toBe(family.id);
    expect(invoice.periodStart?.toISOString().slice(0, 10)).toBe('2026-12-15');
    expect(invoice.periodEnd?.toISOString().slice(0, 10)).toBe('2027-01-14');
  });

  it('prorates the first invoice by days when billing starts inside the period (D85)', async () => {
    const family = await billingFamily(ctx, 'USD', [two], { startsOn: '2026-12-16' });
    const invoice = await issuedInvoice(ctx, family);
    const line = await ctx.prisma.invoiceLine.findFirstOrThrow({
      where: { invoiceId: invoice.id },
    });
    // 16 of 31 days of 60.00 = 30.967… → 30.97
    expect(invoice.total.toFixed(2)).toBe('30.97');
    expect(line.meta).toMatchObject({
      prorated: true,
      days: 16,
      periodDays: 31,
      fullAmount: '60.00',
    });

    // A family that starts after the period is not billed yet.
    await billingFamily(ctx, 'USD', [two], { startsOn: '2027-02-01' });
    const res = await billing.post('/invoice-runs/preview', { period: '2026-12' });
    expect(res.body.data[1].warnings).toEqual(['not_started']);
  });

  it('can be re-billed for the period after a void', async () => {
    const family = await billingFamily(ctx, 'USD', [two]);
    const invoice = await issuedInvoice(ctx, family);
    expect(
      (await billing.post(`/invoices/${invoice.id}/void`, { reason: 'Wrong package' })).status,
    ).toBe(200);
    const res = await billing.post('/invoice-runs', { period: '2026-12', dueDate: '2026-12-07' });
    expect(res.body.data.issuedCount).toBe(1);
  });

  it('does not bill an inactive or archived child', async () => {
    const family = await billingFamily(ctx, 'USD', [two, three]);
    await ctx.prisma.student.update({
      where: { id: family.students[1]!.id },
      data: { status: 'inactive' },
    });
    const row = (await billing.post('/invoice-runs/preview', { period: '2026-12' })).body.data[0];
    expect(row.total).toBe('60.00');
    // The preview's child count follows the same rule as the fee.
    expect(row.children).toBe(1);
  });

  it('runs from the command line with a dry run', async () => {
    await billingFamily(ctx, 'USD', [two]);
    const dry = await billingCommand(ctx.app, 'invoices:generate', [
      '--period=2026-12',
      '--dry-run',
    ]);
    expect(dry?.code).toBe(0);
    expect(dry?.out[1]).toContain('60.00');
    expect(await ctx.prisma.invoice.count()).toBe(0);
    for (let i = 0; i < 2; i++) {
      const run = await billingCommand(ctx.app, 'invoices:generate', [
        '--period=2026-12',
        '--due=2026-12-07',
      ]);
      expect(run?.code).toBe(0);
    }
    expect(await ctx.prisma.invoice.count()).toBe(1);
    expect((await billingCommand(ctx.app, 'invoices:generate', ['--period=2026-13']))?.code).toBe(
      2,
    );
    expect((await billingCommand(ctx.app, 'invoices:generate', ['--period=2026-12']))?.code).toBe(
      2,
    );
    expect(await billingCommand(ctx.app, 'sessions:generate', [])).toBeNull();
  });

  it('validates the run and keeps it to billing staff', async () => {
    const res = await billing.post('/invoice-runs', { period: '2026-13' });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.errors).sort()).toEqual(['dueDate', 'period']);
    expect(
      (await billing.post('/invoice-runs/preview', { period: '2026-12', billingDay: 3 })).status,
    ).toBe(422);
    for (const role of ['csr', 'manager', 'accounts', 'parent', 'teacher']) {
      const { client } = await signedIn(ctx, role);
      expect((await client.post('/invoice-runs/preview', { period: '2026-12' })).status, role).toBe(
        403,
      );
    }
  });
});

describe('family billing profile', () => {
  let billing: Client;
  let pkg: { id: number };

  beforeEach(async () => {
    await resetState(ctx);
    resetBilling(ctx);
    clock(ctx).set('2026-11-20T09:00:00Z');
    ({ client: billing } = await signedIn(ctx, 'billing'));
    pkg = await makeFeePackage(ctx, { USD: '60.00', GBP: '50.00' });
  });

  it("saves the billing profile and the children's packages, with a next-invoice preview", async () => {
    const family = await makeFamily(ctx);
    const child = await makeStudent(ctx, family);
    const stranger = await makeStudent(ctx, await makeFamily(ctx));

    let res = await billing.get(`/families/${family.id}/billing`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      billingEnabled: false,
      billingCurrency: null,
      billingDay: 1,
      nextInvoice: { warnings: ['missing_currency'] },
      balance: [],
    });

    res = await billing.put(`/families/${family.id}/billing`, {
      billingCurrency: 'gbp',
      billingDay: 15,
      billingEnabled: true,
      students: [{ id: child.id, feePackageId: pkg.id }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      billingCurrency: 'GBP',
      billingDay: 15,
      students: [{ id: child.id, feePackageId: pkg.id }],
      nextInvoice: {
        periodStart: '2026-12-15',
        periodEnd: '2027-01-14',
        total: '50.00',
        currency: 'GBP',
      },
    });

    res = await billing.put(`/families/${family.id}/billing`, {
      billingCurrency: 'GBP',
      billingDay: 1,
      billingEnabled: true,
      students: [{ id: stranger.id, feePackageId: pkg.id }],
    });
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty('students');
    expect(await ctx.prisma.studentFeePackage.count({ where: { studentId: stranger.id } })).toBe(0);

    res = await billing.put(`/families/${family.id}/billing`, {
      billingCurrency: 'XYZ',
      billingDay: 3,
      billingEnabled: true,
    });
    expect(Object.keys(res.body.errors).sort()).toEqual(['billingCurrency', 'billingDay']);
    res = await billing.put(`/families/${family.id}/billing`, {
      billingCurrency: 'USD',
      billingDay: 1,
      billingEnabled: true,
      students: [{ id: child.id, feePackageId: 999999 }],
    });
    expect(res.body.errors).toHaveProperty(['students.0.feePackageId']);

    // Clearing a child's package; a custom fee; the audit row.
    res = await billing.put(`/families/${family.id}/billing`, {
      billingCurrency: 'USD',
      billingDay: 1,
      billingEnabled: true,
      customFee: '45.5',
      billingStartsOn: '2026-12-01',
      students: [{ id: child.id, feePackageId: null }],
    });
    expect(res.body.data).toMatchObject({
      customFee: '45.50',
      billingStartsOn: '2026-12-01',
      students: [{ id: child.id, feePackageId: null }],
      nextInvoice: { periodStart: '2026-12-01', total: '45.50' },
    });
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'billing_profile_updated', subjectId: family.id },
      }),
    ).toBe(2);
    expect((await billing.get('/families/999999/billing')).status).toBe(404);
  });

  it('shows what the family owes per currency (open invoices, overdue part)', async () => {
    const family = await billingFamily(ctx, 'USD', [pkg]);
    await issuedInvoice(ctx, family, '2026-11', '2026-11-15');
    await issuedInvoice(ctx, family, '2026-12', '2026-12-07');
    const res = await billing.get(`/families/${family.id}/billing`);
    expect(res.body.data.balance).toEqual([
      { currency: 'USD', due: '120.00', overdue: '60.00', openInvoices: 2 },
    ]);
  });

  it('refuses to archive a family with open invoices (409 has_open_invoices)', async () => {
    const family = await billingFamily(ctx, 'USD', [pkg]);
    const invoice = await issuedInvoice(ctx, family);
    await ctx.prisma.family.update({ where: { id: family.id }, data: { status: 'deactivated' } });
    const { client: admin } = await signedIn(ctx, 'admin');
    const res = await admin.delete(`/families/${family.id}`, { reason: 'Left the academy' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'has_open_invoices', data: { openInvoices: 1 } });

    await billing.post(`/invoices/${invoice.id}/payments`, {
      method: 'cash',
      amount: '60',
      receivedOn: '2026-11-20',
    });
    expect(
      (await admin.delete(`/families/${family.id}`, { reason: 'Left the academy' })).status,
    ).toBe(200);
  });
});

describe('payment reminders (D88, D140)', () => {
  let billing: Client;
  let pkg: { id: number };
  let reminders: InvoiceReminderService;

  beforeEach(async () => {
    await resetState(ctx);
    resetBilling(ctx);
    clock(ctx).set('2026-11-20T09:00:00Z');
    ({ client: billing } = await signedIn(ctx, 'billing'));
    pkg = await makeFeePackage(ctx, { USD: '60.00' });
    reminders = ctx.app.get(InvoiceReminderService);
  });

  it('sends nothing at all while billing.notify_parents is off (the default)', async () => {
    const family = await billingFamily(ctx, 'USD', [pkg]);
    const invoice = await issuedInvoice(ctx, family, '2026-12', '2026-12-07');
    clock(ctx).set('2026-12-07T08:00:00Z');
    expect(await reminders.sendDue()).toMatchObject({ disabled: true, checked: 0, sent: 0 });
    const res = await billing.post(`/invoices/${invoice.id}/remind`);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'parent_mail_off', data: { result: 'disabled' } });
    const cli = await billingCommand(ctx.app, 'billing:reminders', []);
    expect(cli?.out[0]).toContain('off');
    expect(ctx.mailer.sent).toHaveLength(0);
    expect(await ctx.prisma.invoiceReminder.count()).toBe(0);
  });

  it('sends reminders 3 days before, on, 3 and 7 days after the due date, once each', async () => {
    await notifyParents(ctx, true);
    const family = await billingFamily(ctx, 'USD', [pkg]);
    const invoice = await issuedInvoice(ctx, family, '2026-12', '2026-12-07');
    ctx.mailer.clear(); // forget the "issued" email

    const sentOn: string[] = [];
    for (let i = 0; i <= 20; i++) {
      const day = new Date(Date.UTC(2026, 11, 1 + i, 8));
      clock(ctx).set(day);
      for (let run = 0; run < 2; run++) {
        // two runs a day: still one email
        if ((await reminders.sendDue()).sent > 0) sentOn.push(day.toISOString().slice(0, 10));
      }
    }
    expect(sentOn).toEqual(['2026-12-04', '2026-12-07', '2026-12-10', '2026-12-14']);
    const mails = invoiceMails();
    expect(mails).toHaveLength(4);
    expect(
      mails.every(
        (m) => m.kind === 'invoice_reminder' && m.text.includes(`/invoices/${invoice.id}`),
      ),
    ).toBe(true);
  });

  it('stops reminding once paid and can be turned off by an empty day list', async () => {
    await notifyParents(ctx, true);
    const family = await billingFamily(ctx, 'USD', [pkg]);
    const invoice = await issuedInvoice(ctx, family, '2026-12', '2026-12-07');
    await billing.post(`/invoices/${invoice.id}/payments`, {
      method: 'cash',
      amount: '60',
      receivedOn: '2026-11-20',
    });
    clock(ctx).set('2026-12-07T08:00:00Z');
    expect((await reminders.sendDue()).checked).toBe(0);

    await issuedInvoice(ctx, await billingFamily(ctx, 'USD', [pkg]), '2026-12', '2026-12-07');
    ctx.mailer.clear();
    const put = await billing.put('/settings/billing', { 'billing.reminder_days': [] });
    expect(put.status).toBe(403); // billing has no settings.manage
    const { client: admin } = await signedIn(ctx, 'admin');
    expect((await admin.put('/settings/billing', { 'billing.reminder_days': [] })).status).toBe(
      200,
    );
    expect((await reminders.sendDue()).sent).toBe(0);
    expect(ctx.mailer.sent).toHaveLength(0);
  });

  it('sends a manual reminder at most once an hour', async () => {
    await notifyParents(ctx, true);
    const invoice = await issuedInvoice(
      ctx,
      await billingFamily(ctx, 'USD', [pkg]),
      '2026-12',
      '2026-12-07',
    );
    ctx.mailer.clear();
    let res = await billing.post(`/invoices/${invoice.id}/remind`);
    expect(res.status).toBe(200);
    expect(res.body.data.result).toBe('sent');
    res = await billing.post(`/invoices/${invoice.id}/remind`);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('remind_throttled');
    expect(invoiceMails()).toHaveLength(1);

    clock(ctx).set('2026-11-20T10:01:00Z');
    expect((await billing.post(`/invoices/${invoice.id}/remind`)).status).toBe(200);
    expect(await ctx.prisma.invoiceReminder.count({ where: { status: 'sent' } })).toBe(2);

    // A paid invoice: nothing to remind.
    await billing.post(`/invoices/${invoice.id}/payments`, {
      method: 'cash',
      amount: '60',
      receivedOn: '2026-11-20',
    });
    expect((await billing.post(`/invoices/${invoice.id}/remind`)).body.code).toBe('not_open');
  });

  it('writes the invoice email in both languages with the portal link and no password', async () => {
    await notifyParents(ctx, true);
    const family = await billingFamily(ctx, 'USD', [pkg]);
    await issuedInvoice(ctx, family, '2026-12', '2026-12-07');
    const [mail] = invoiceMails();
    expect(mail?.to).toBe(family.user.email);
    expect(mail?.subject).toBe('فاتورة أكاديمية قرآبيك INV-2026-000001'); // parent locale: ar
    expect(mail?.text).toContain('INV-2026-000001');
    expect(mail?.text).toContain('60.00 USD');
    expect(mail?.text).toContain('2026-12-07');
    expect(mail?.text).toContain('http://localhost:3000/invoices/');
    expect(mail?.text).toContain('فاتورتكم');
    expect(mail?.text).toContain('Your invoice');
    expect(mail?.text.indexOf('فاتورتكم')).toBeLessThan(mail!.text.indexOf('Your invoice'));
    expect(mail?.text.toLowerCase()).not.toContain('password:');
  });

  it('serves and updates the billing settings (flat keys, unknown key = 422)', async () => {
    const { client: admin } = await signedIn(ctx, 'admin');
    let res = await admin.get('/settings/billing');
    expect(res.body.data).toEqual({
      'billing.deducting_stages': ['taken', 'absent', 'declined'],
      'billing.reminder_days': [-3, 0, 3, 7],
      'billing.default_due_days': 7,
      'billing.notify_parents': false,
    });
    res = await admin.put('/settings/billing', {
      'billing.notify_parents': true,
      'billing.nope': 1,
    });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.errors)).toEqual(['billing.nope']);
    res = await admin.put('/settings/billing', {
      'billing.default_due_days': 10,
      'billing.notify_parents': true,
    });
    expect(res.body.data).toMatchObject({
      'billing.default_due_days': 10,
      'billing.notify_parents': true,
    });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'settings_updated' } })).toBe(1);
  });
});
