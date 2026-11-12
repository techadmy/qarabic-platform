import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InvoiceService } from '../src/billing/invoices.service.js';
import { canReferenceInvoice } from '../src/billing/scope.js';
import {
  authUser,
  type Client,
  clock,
  createTestApp,
  m2Enrollment,
  m2Session,
  m2Teacher,
  resetState,
  signedIn,
  signInAs,
  type TestContext,
} from './helpers.js';
import {
  billingFamily,
  enableStripe,
  issuedInvoice,
  makeFeePackage,
  resetBilling,
} from './n6-helpers.js';

/*
| Port of Laravel tests/Feature/M5/ParentBillingTest.php (D87): a parent sees and pays only their
| own family's issued invoices; anything else is 404. Teachers and monitors have no billing access.
| Plus the package usage (B24), the printable invoice and the support-centre hook.
*/

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

let family: Awaited<ReturnType<typeof billingFamily>>;
let other: Awaited<ReturnType<typeof billingFamily>>;
let mine: { id: number };
let theirs: { id: number };
let draftId: number;
let parent: Client;

beforeEach(async () => {
  await resetState(ctx);
  resetBilling(ctx);
  clock(ctx).set('2026-12-02T09:00:00Z');
  const pkg = await makeFeePackage(ctx, { USD: '60.00' });
  family = await billingFamily(ctx, 'USD', [pkg]);
  mine = await issuedInvoice(ctx, family);
  other = await billingFamily(ctx, 'USD', [pkg]);
  theirs = await issuedInvoice(ctx, other);
  const { user: billingUser } = await signedIn(ctx, 'billing');
  draftId = await ctx.app
    .get(InvoiceService)
    .createManual(
      family.id,
      [{ description: 'Draft', amount: '1.00' }],
      null,
      null,
      await authUser(ctx, billingUser),
      false,
    );
  parent = await signInAs(ctx, family.user);
});

describe('parent billing (own family only)', () => {
  it("lists only the family's own issued invoices", async () => {
    let res = await parent.get('/invoices');
    expect(res.status).toBe(200);
    expect(res.body.data.map((i: { id: number }) => i.id)).toEqual([mine.id]);
    expect(res.body.meta.counts).not.toHaveProperty('draft');
    res = await parent.get(`/invoices?familyId=${other.id}`);
    expect(res.body.data.map((i: { id: number }) => i.id)).toEqual([mine.id]);
  });

  it("shows the own invoice with pay rights, and 404 for another family's or a draft", async () => {
    const res = await parent.get(`/invoices/${mine.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.can).toMatchObject({
      pay: true,
      recordPayment: false,
      void: false,
      issue: false,
    });
    expect((await parent.get(`/invoices/${theirs.id}`)).status).toBe(404);
    expect((await parent.get(`/invoices/${draftId}`)).status).toBe(404);
    expect((await parent.get(`/invoices/${theirs.id}/print`)).status).toBe(404);
    expect((await parent.get(`/families/${other.id}/billing`)).status).toBe(404);
    expect((await parent.get(`/families/${family.id}/billing`)).status).toBe(200);
    expect((await parent.get('/invoices/999999')).status).toBe(404);
  });

  it('hides staff-only payment fields from the parent', async () => {
    const { client: billing } = await signedIn(ctx, 'billing');
    await billing.post(`/invoices/${mine.id}/payments`, {
      method: 'cash',
      amount: '10',
      receivedOn: '2026-12-02',
      note: 'Internal: paid at the office',
    });
    const res = await parent.get(`/invoices/${mine.id}`);
    expect(res.body.data.payments).toHaveLength(1);
    expect(res.body.data.payments[0]).not.toHaveProperty('note');
    expect(res.body.data.payments[0]).not.toHaveProperty('recordedBy');
    expect(res.body.data.payments[0].receiptNumber).toMatch(/^RC-/);
    const staff = await billing.get(`/invoices/${mine.id}`);
    expect(staff.body.data.payments[0].note).toBe('Internal: paid at the office');
  });

  it("cannot pay another family's invoice nor use staff actions", async () => {
    enableStripe(ctx);
    expect(
      (await parent.post(`/invoices/${theirs.id}/checkout`, { provider: 'stripe' })).status,
    ).toBe(404);
    expect(
      (await parent.post(`/invoices/${draftId}/checkout`, { provider: 'stripe' })).status,
    ).toBe(404);
    expect(
      (
        await parent.post(`/invoices/${mine.id}/payments`, {
          method: 'cash',
          amount: '60',
          receivedOn: '2026-12-02',
        })
      ).status,
    ).toBe(403);
    expect(
      (await parent.post(`/invoices/${mine.id}/void`, { reason: 'I do not want it' })).status,
    ).toBe(403);
    expect(
      (
        await parent.put(`/families/${family.id}/billing`, {
          billingCurrency: 'USD',
          billingDay: 1,
          billingEnabled: false,
        })
      ).status,
    ).toBe(403);
    expect((await parent.get('/billing/summary')).status).toBe(403);
    expect((await parent.post('/invoices', { familyId: family.id, lines: [] })).status).toBe(403);
  });

  it.each(['teacher', 'monitor'])('keeps %s out of billing', async (role) => {
    const { client } = await signedIn(ctx, role);
    expect((await client.get('/invoices')).status).toBe(403);
    expect((await client.get(`/invoices/${mine.id}`)).status).toBe(403);
    expect((await client.get(`/families/${family.id}/billing`)).status).toBe(403);
  });

  it.each(['manager', 'accounts', 'csr'])(
    'lets read-only staff (%s) view but not change invoices',
    async (role) => {
      const { client } = await signedIn(ctx, role);
      const res = await client.get(`/invoices/${theirs.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.can).toMatchObject({ pay: false, edit: false, recordPayment: false });
      expect((await client.get('/invoices')).body.data).toHaveLength(3);
      expect(
        (await client.post(`/invoices/${theirs.id}/void`, { reason: 'Nope nope' })).status,
      ).toBe(403);
    },
  );

  it('shows package usage: taken, absent and declined count; leave and holidays do not (B24)', async () => {
    const teacher = await m2Teacher(ctx);
    const child = await ctx.prisma.student.update({
      where: { id: family.students[0]!.id },
      data: {},
      include: { family: true },
    });
    const enrollment = await m2Enrollment(ctx, child, teacher, {
      courseId: (await ctx.prisma.course.create({ data: { nameEn: 'Q', nameAr: 'ق' } })).id,
    });
    for (const [at, stage] of [
      ['2026-12-03T10:00:00Z', 'taken'],
      ['2026-12-05T10:00:00Z', 'absent'],
      ['2026-12-07T10:00:00Z', 'declined'],
      ['2026-12-10T10:00:00Z', 'leave'],
      ['2026-12-12T10:00:00Z', 'cancelled'],
      ['2026-12-14T10:00:00Z', 'scheduled'],
      ['2027-01-02T10:00:00Z', 'taken'],
    ] as const) {
      await m2Session(ctx, enrollment, at, { stage });
    }
    const res = await parent.get(`/invoices/${mine.id}`);
    expect(res.body.data.usage).toEqual([
      expect.objectContaining({
        studentId: child.id,
        allowance: 8,
        counted: 3,
        notCounted: 2,
        upcoming: 1,
        countedStages: ['taken', 'absent', 'declined'],
      }),
    ]);
  });

  it('serves a printable HTML invoice, escaped, in the viewer language', async () => {
    const { client: billing } = await signedIn(ctx, 'billing');
    await billing.post(`/invoices/${mine.id}/lines`, {
      type: 'adjustment',
      amount: '1',
      reason: '<script>alert(1)</script>',
    });
    const res = await parent.get(`/invoices/${mine.id}/print`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('INV-2026-000001');
    expect(res.text).toContain('dir="rtl"');
    expect(res.text).toContain('61.00 USD');
    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).toContain('&lt;script&gt;');
  });

  it('lets the support centre link only invoices the user may see (N4 hook)', async () => {
    const parentUser = await authUser(ctx, family.user);
    expect(await canReferenceInvoice(ctx.prisma, parentUser, mine.id)).toBe(true);
    expect(await canReferenceInvoice(ctx.prisma, parentUser, theirs.id)).toBe(false);
    expect(await canReferenceInvoice(ctx.prisma, parentUser, draftId)).toBe(false);
    const { user: csr } = await signedIn(ctx, 'csr');
    expect(await canReferenceInvoice(ctx.prisma, await authUser(ctx, csr), theirs.id)).toBe(true);
    const teacher = await m2Teacher(ctx);
    expect(await canReferenceInvoice(ctx.prisma, await authUser(ctx, teacher.user), mine.id)).toBe(
      false,
    );
  });

  it('a parent opens a «تواصل معنا» ticket about their own invoice, never another family’s', async () => {
    const c = await signInAs(ctx, family.user);
    const ticket = {
      category: 'billing',
      subcategory: 'invoice_question',
      subjectType: 'invoice',
      description: 'I paid this invoice but it still shows unpaid',
    };
    const ok = await c.post('/feedback/tickets', { ...ticket, subjectId: mine.id });
    expect(ok.status).toBe(201);
    expect(ok.body.data.subject).toEqual({ type: 'invoice', id: mine.id });
    for (const subjectId of [theirs.id, draftId]) {
      const res = await c.post('/feedback/tickets', { ...ticket, subjectId });
      expect(res.status, String(subjectId)).toBe(422);
      expect(res.body.errors).toHaveProperty('subjectId');
    }
  });
});
