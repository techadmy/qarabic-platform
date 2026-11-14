import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SupportReports } from '../src/support/reports.service.js';
import {
  Client,
  clock,
  createTestApp,
  createUser,
  makeFamily,
  resetState,
  signedIn,
  signInAs,
  type TestContext,
} from './helpers.js';
import { fbTicket } from './n4-helpers.js';

/*
| S4 (docs/32 §5, §8): the first-response SLA breach notice (once per ticket, to the assignee and
| the support managers who may see it) and the support report. Now: Mon 2026-11-16 09:00 UTC.
*/

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

const NOW = new Date('2026-11-16T09:00:00Z');
const at = (iso: string) => new Date(iso);
let parent: { id: number; email: string };

beforeEach(async () => {
  await resetState(ctx);
  clock(ctx).set(NOW);
  parent = (await makeFamily(ctx)).user;
});

const billingTicket = (attrs: Record<string, unknown> = {}) =>
  fbTicket(ctx, parent, attrs, 'Question about the November invoice', {
    type: undefined,
    category: 'billing',
    context: {},
  });

describe('S4 SLA breach notices', () => {
  it('tells the assignee and the support managers once; not the answered or closed ones', async () => {
    const manager = await createUser(ctx, 'senior_manager');
    const billing = await createUser(ctx, 'billing');
    const late = await billingTicket({
      slaDueAt: at('2026-11-16T08:50:00Z'),
      assigneeId: billing.id,
    });
    await billingTicket({
      slaDueAt: at('2026-11-16T08:50:00Z'),
      firstResponseAt: at('2026-11-16T08:40:00Z'),
    });
    await billingTicket({
      slaDueAt: at('2026-11-16T08:50:00Z'),
      status: 'wont_fix',
      closedAt: at('2026-11-16T08:55:00Z'),
    });
    await billingTicket({ slaDueAt: at('2026-11-16T10:00:00Z') });

    const jobs = ctx.app.get(SupportReports);
    expect(await jobs.slaBreaches()).toBe(2);
    expect(await jobs.slaBreaches()).toBe(0);
    const notices = await ctx.prisma.notification.findMany({
      where: { kind: 'support', event: 'sla_breach' },
      select: { userId: true, data: true },
    });
    expect(notices.map((n) => n.userId).sort()).toEqual([manager.id, billing.id].sort());
    expect(notices[0]!.data).toMatchObject({ ticketId: late.id, queue: 'billing' });
    expect(
      (await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: late.id } })).slaBreachNotifiedAt,
    ).not.toBeNull();
  });

  it('a complaint goes only to those who may see it', async () => {
    const manager = await createUser(ctx, 'senior_manager');
    const monitor = await createUser(ctx, 'monitor');
    await fbTicket(
      ctx,
      parent,
      { slaDueAt: at('2026-11-16T08:00:00Z'), assigneeId: monitor.id },
      'The teacher was rude in the last class',
      { type: undefined, category: 'teacher', subcategory: 'teacher_feedback', context: {} },
    );
    await ctx.app.get(SupportReports).slaBreaches();
    const to = await ctx.prisma.notification.findMany({
      where: { kind: 'support' },
      select: { userId: true },
    });
    expect(to.map((n) => n.userId)).toEqual([manager.id]);
  });
});

describe('S4 the support report', () => {
  it('counts volume, first response, SLA met and time to resolve by queue, category, channel and week', async () => {
    // Answered in 30 min, inside the deadline, closed after 2 hours.
    await billingTicket({
      createdAt: at('2026-11-09T09:00:00Z'),
      slaDueAt: at('2026-11-09T12:00:00Z'),
      firstResponseAt: at('2026-11-09T09:30:00Z'),
      status: 'verified',
      closedAt: at('2026-11-09T11:00:00Z'),
    });
    // Answered late (90 min, deadline 60), still open.
    await billingTicket({
      createdAt: at('2026-11-16T07:00:00Z'),
      slaDueAt: at('2026-11-16T08:00:00Z'),
      firstResponseAt: at('2026-11-16T08:30:00Z'),
    });
    // Not answered yet, deadline still ahead: not decided.
    await billingTicket({
      createdAt: at('2026-11-16T08:00:00Z'),
      slaDueAt: at('2026-11-16T12:00:00Z'),
    });
    const { client } = await signedIn(ctx, 'senior_manager');
    const res = await client.get('/support/reports?from=2026-11-01&to=2026-11-16');
    expect(res.status).toBe(200);
    expect(res.body.data.total).toEqual({
      created: 3,
      open: 2,
      closed: 1,
      firstResponseMedianMinutes: 60,
      slaMet: { numerator: 1, denominator: 2, pct: 50 },
      resolveMedianHours: 2,
    });
    expect(res.body.data.byQueue).toEqual([
      expect.objectContaining({ queue: 'billing', created: 3 }),
    ]);
    expect(res.body.data.byCategory[0]).toMatchObject({ category: 'billing', created: 3 });
    expect(res.body.data.byChannel[0]).toMatchObject({ channel: 'in_app', created: 3 });
    expect(res.body.data.byWeek).toEqual([
      { weekStart: '2026-11-09', created: 1, closed: 1 },
      { weekStart: '2026-11-16', created: 2, closed: 0 },
    ]);
  });

  it('keeps to the viewer’s queues; staff only; a bounded period', async () => {
    await billingTicket();
    const { client: monitor } = await signedIn(ctx, 'monitor');
    const scoped = await monitor.get('/support/reports');
    expect(scoped.status).toBe(200);
    expect(scoped.body.data.total.created).toBe(0);
    expect((await monitor.get('/support/reports?from=2025-01-01&to=2026-11-01')).status).toBe(422);
    expect((await monitor.get('/support/reports?from=2026-11-10&to=2026-11-01')).status).toBe(422);
    const asParent = await signInAs(ctx, parent);
    expect((await asParent.get('/support/reports')).status).toBe(403);
    const anon = await new Client(ctx.app).init();
    expect((await anon.get('/support/reports')).status).toBe(401);
  });
});
