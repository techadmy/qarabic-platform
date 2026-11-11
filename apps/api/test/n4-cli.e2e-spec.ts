import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TicketCli } from '../src/support/ticket-cli.js';
import { TicketsService } from '../src/support/tickets.service.js';
import { clock, createTestApp, createUser, resetState, type TestContext } from './helpers.js';
import { fbTicket, PNG } from './n4-helpers.js';

/*
 * Port of Laravel tests/Feature/Feedback/TicketCommandsTest.php (docs/22 §7, D100): Claude works
 * the queue with tickets:list / tickets:show / tickets:status / tickets:reply (Laravel
 * `tickets:triage`), with the same rules as the API, recorded as "Claude".
 */

let ctx: TestContext;
let cli: TicketCli;

beforeAll(async () => {
  ctx = await createTestApp();
  cli = ctx.app.get(TicketCli);
});
afterAll(async () => {
  await ctx.app.close();
});
beforeEach(async () => {
  await resetState(ctx);
  clock(ctx).set('2026-11-10T10:00:00Z');
});

const text = (r: { out: string[] }) => r.out.join('\n');

describe('ticket CLI (TicketCommandsTest)', () => {
  it('lists open tickets by priority and filters them', async () => {
    const a = await fbTicket(
      ctx,
      await createUser(ctx, 'monitor'),
      { priority: 'p0', status: 'triaged' },
      'Class cannot start at all',
    );
    await fbTicket(ctx, await createUser(ctx, 'parent'), {}, 'Invoice wording is odd');
    await fbTicket(
      ctx,
      await createUser(ctx, 'teacher'),
      { status: 'verified', priority: 'p2', closedAt: new Date() },
      'Old fixed thing',
    );

    const open = await cli.list([]);
    expect(open.code).toBe(0);
    expect(text(open)).toContain('Class cannot start at all');
    expect(text(open)).toContain('Invoice wording is odd');
    expect(text(open)).not.toContain('Old fixed thing');
    // Untriaged (no priority) first, then P0 …
    expect(text(open).indexOf('Invoice wording')).toBeLessThan(text(open).indexOf('Class cannot'));
    const p0 = await cli.list(['--priority=p0', '--json']);
    expect(JSON.parse(text(p0))).toEqual([expect.objectContaining({ id: a.id, priority: 'p0' })]);
    expect(text(await cli.list(['--status=closed']))).toContain('Old fixed thing');
    expect((await cli.list(['--status=nope'])).code).toBe(2);
    // No contact data in the output.
    expect(text(await cli.list(['--json']))).not.toContain('@example.test');
  });

  it('shows a ticket with its context and internal timeline, and copies attachments', async () => {
    const ticket = await fbTicket(ctx, await createUser(ctx, 'csr'), {
      priority: 'p2',
      status: 'triaged',
    });
    const service = ctx.app.get(TicketsService);
    await service.comment(
      ticket.id,
      { user: null, label: 'Claude' },
      'Reproduced on staging',
      true,
      [{ bytes: PNG, mime: 'image/png', originalName: 'shot.png', source: 'screenshot' }],
    );
    const dir = await mkdtemp(join(tmpdir(), 'ticket-cli-'));
    try {
      const shown = await cli.show([String(ticket.id), `--attachments=${dir}`]);
      expect(shown.code).toBe(0);
      expect(text(shown)).toContain('The board does not load after login');
      expect(text(shown)).toContain('[internal] Claude comment: Reproduced on staging');
      expect((await readdir(dir)).filter((f) => f.endsWith('.png'))).toHaveLength(1);
      const json = JSON.parse((await cli.show([String(ticket.id), '--json'])).out.at(-1)!);
      expect(json).toMatchObject({ id: ticket.id, queue: 'tech', context: { area: 'sessions' } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect((await cli.show(['99999'])).code).toBe(1);
  });

  it('triages with the same lifecycle rules and records Claude as the author', async () => {
    const reporter = await createUser(ctx, 'teacher');
    const ticket = await fbTicket(ctx, reporter);
    const id = String(ticket.id);

    const refused = await cli.status([id, '--status=triaged']);
    expect(refused.code).toBe(1);
    expect(text(refused)).toContain('priority');
    expect(
      (await cli.status([id, '--priority=p1', '--status=triaged', '--area=payroll'])).code,
    ).toBe(0);
    expect((await cli.reply([id, '--body=Looks like a zone bug', '--internal'])).code).toBe(0);
    expect(
      (
        await cli.status([
          id,
          '--status=in_progress',
          '--pr=https://github.com/qarabicacademy/qarabic-backend/pull/40',
        ])
      ).code,
    ).toBe(0);
    expect((await cli.status([id, '--status=fixed', "--note=Fixed in today's update"])).code).toBe(
      0,
    );
    expect((await cli.reply([id, '--body=Please check again'])).code).toBe(0);

    const t = await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(t.status).toBe('fixed');
    expect(t.area).toBe('payroll');
    expect(t.firstResponseAt).not.toBeNull(); // Claude's public status change answered it
    expect(
      await ctx.prisma.ticketComment.count({
        where: {
          ticketId: ticket.id,
          authorLabel: 'Claude',
          internal: true,
          body: 'Looks like a zone bug',
        },
      }),
    ).toBe(1);
    expect(
      await ctx.prisma.auditLog.count({
        where: { subjectType: 'ticket', subjectId: ticket.id, actorId: null },
      }),
    ).toBeGreaterThanOrEqual(3);

    expect((await cli.status([id, '--assign=nobody@example.com'])).code).toBe(1);
    expect((await cli.status([id, '--priority=p9'])).code).toBe(1);
    expect((await cli.status([id])).code).toBe(2);
    expect((await cli.reply([id])).code).toBe(2);
    expect((await cli.status(['99999', '--status=triaged'])).code).toBe(1);
  });
});
