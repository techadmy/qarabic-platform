import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, resetState, signInAs, type TestContext } from './helpers.js';
import { m6At, m6Enrollment, m6Session, m6Teacher, userWithRole } from './payroll-helpers.js';

/*
| N7 leftovers (docs/21 §7, §12): a run transition with a stale `expectedUpdatedAt` answers 409
| `stale_run`; the approve note is optional (blank = none) and, when written, has 3+ characters.
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
  m6At(ctx, '2026-11-15T08:00:00Z');
});

describe('stale_run (docs/21 §7)', () => {
  it('refuses a transition on a run that changed since the client loaded it', async () => {
    const teacher = await m6Teacher(ctx, { hourlyRate: '300.00' });
    await m6Session(ctx, await m6Enrollment(ctx, teacher), '2026-10-05T10:00:00Z', 'taken');
    const { client: accounts } = await userWithRole(ctx, 'accounts');
    const { client: senior } = await userWithRole(ctx, 'senior_manager');
    const created = (await accounts.post('/payroll/runs', { period: '2026-10' })).body.data;
    expect(created.updatedAt).toEqual(expect.any(String));
    const seen = created.updatedAt as string;

    // Someone recomputes meanwhile: the old version is now stale.
    m6At(ctx, '2026-11-15T08:05:00Z');
    const recomputed = await accounts.post(`/payroll/runs/${created.id}/recompute`, {
      expectedUpdatedAt: seen,
    });
    expect(recomputed.status).toBe(200);
    const fresh = recomputed.body.data.updatedAt as string;
    expect(fresh).not.toBe(seen);

    const stale = await senior.post(`/payroll/runs/${created.id}/review`, {
      expectedUpdatedAt: seen,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      code: 'stale_run',
      data: { status: 'draft', updatedAt: fresh },
    });

    m6At(ctx, '2026-11-15T08:10:00Z');
    const reviewed = await senior.post(`/payroll/runs/${created.id}/review`, {
      expectedUpdatedAt: fresh,
    });
    expect(reviewed.status).toBe(200);
    const afterReview = reviewed.body.data.updatedAt as string;
    expect(
      (await accounts.post(`/payroll/runs/${created.id}/approve`, { expectedUpdatedAt: fresh }))
        .body.code,
    ).toBe('stale_run');
    m6At(ctx, '2026-11-15T08:15:00Z');
    const approved = await accounts.post(`/payroll/runs/${created.id}/approve`, {
      expectedUpdatedAt: afterReview,
    });
    expect(approved.status).toBe(200);
    expect(
      (
        await accounts.post(`/payroll/runs/${created.id}/reopen`, {
          note: 'Wrong rate',
          expectedUpdatedAt: afterReview,
        })
      ).body.code,
    ).toBe('stale_run');

    // Without the field (old clients) the status check still applies: 409 invalid_run_status.
    expect((await senior.post(`/payroll/runs/${created.id}/review`)).body.code).toBe(
      'invalid_run_status',
    );
    expect(
      (
        await accounts.post(`/payroll/runs/${created.id}/approve`, {
          expectedUpdatedAt: 'yesterday',
        })
      ).status,
    ).toBe(422);
  });
});

describe('approve note (docs/21: optional)', () => {
  it('accepts no note or a blank one, refuses 1–2 characters with a clear message', async () => {
    const teacher = await m6Teacher(ctx);
    const client = await signInAs(
      ctx,
      await ctx.prisma.user.findUniqueOrThrow({ where: { id: teacher.userId } }),
    );
    const { client: manager } = await userWithRole(ctx, 'manager');
    const leave = async (startsOn: string) =>
      (
        await client.post('/leave-requests', {
          startsOn,
          endsOn: startsOn,
          leaveType: 'paid',
          reason: 'Family matter',
        })
      ).body.data.id as number;

    const a = await leave('2026-11-20');
    const short = await manager.post(`/leave-requests/${a}/approve`, { note: 'ok' });
    expect(short.status).toBe(422);
    expect(short.body.errors.note).toEqual([
      'Write at least 3 characters, or leave the note empty.',
    ]);
    const blank = await manager.post(`/leave-requests/${a}/approve`, { note: '   ' });
    expect(blank.status).toBe(200);
    expect(blank.body.data.decisionNote ?? null).toBeNull();

    const b = await leave('2026-11-21');
    const noted = await manager.post(`/leave-requests/${b}/approve`, { note: 'Enjoy' });
    expect(noted.status).toBe(200);
    expect(noted.body.data.decisionNote).toBe('Enjoy');
  });
});
