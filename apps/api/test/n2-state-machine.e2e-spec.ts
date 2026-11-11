import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiException } from '../src/common/errors.js';
import type { SessionStage } from '../src/generated/prisma/enums.js';
import { SessionPresenter } from '../src/sessions/presenter.js';
import { Actor, SessionStateMachine, StaleSessionError } from '../src/sessions/state-machine.js';
import {
  authUser,
  clock,
  createTestApp,
  createUser,
  m2Enrollment,
  m2Session,
  m2Student,
  m2Teacher,
  resetState,
  type TestContext,
} from './helpers.js';

/* Port of Laravel tests/Feature/M2/StateMachineTest.php (docs/14 §3). */

let ctx: TestContext;
let machine: SessionStateMachine;

beforeAll(async () => {
  ctx = await createTestApp();
  machine = ctx.app.get(SessionStateMachine);
});
afterAll(async () => {
  await ctx.app.close();
});

let teacher: Awaited<ReturnType<typeof m2Teacher>>;
let enrollment: Awaited<ReturnType<typeof m2Enrollment>>;
let sessionId: number;
let own: Actor;
let manager: Actor;
let otherTeacher: Actor;
let parent: Actor;

const actorOf = async (user: { id: number }) => Actor.of(ctx.prisma, await authUser(ctx, user));
const at = (iso: string) => clock(ctx).set(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
const row = (id = sessionId) => ctx.prisma.classSession.findUniqueOrThrow({ where: { id } });
const apply = (
  action: Parameters<SessionStateMachine['apply']>[1],
  actor: Actor,
  input = {},
  id = sessionId,
) => machine.apply(id, action, actor, input);

async function code(promise: Promise<unknown>): Promise<[number, string]> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StaleSessionError) return [409, 'stale_session'];
    if (error instanceof ApiException) {
      return [error.getStatus(), (error.getResponse() as { code: string }).code];
    }
    throw error;
  }
  return [0, 'ok'];
}

async function allowed(actor: Actor, id = sessionId): Promise<string[]> {
  const s = await ctx.prisma.classSession.findUniqueOrThrow({
    where: { id },
    include: (await import('../src/sessions/presenter.js')).sessionInclude,
  });
  return (await ctx.app.get(SessionPresenter).one(s, actor.user)).allowedActions;
}

beforeEach(async () => {
  await resetState(ctx);
  at('2026-11-10 15:00:00'); // class time
  teacher = await m2Teacher(ctx);
  enrollment = await m2Enrollment(ctx, await m2Student(ctx), teacher);
  sessionId = (await m2Session(ctx, enrollment, '2026-11-10T15:00:00Z')).id;
  own = await actorOf(teacher.user);
  manager = await actorOf(await createUser(ctx, 'monitor'));
  otherTeacher = await actorOf((await m2Teacher(ctx)).user);
  parent = await actorOf(await createUser(ctx, 'parent'));
});

const ALL = [
  'activate',
  'undo_activate',
  'start',
  'end',
  'mark_absent',
  'mark_declined',
  'mark_leave',
  'cancel',
  'revert',
] as const;
const ALLOWED: Record<string, string[]> = {
  scheduled: ['activate', 'mark_leave', 'cancel'],
  activated: ['undo_activate', 'start', 'end', 'mark_absent', 'mark_declined', 'mark_leave'],
  in_progress: ['undo_activate', 'end', 'mark_declined'],
  ended: ['revert', 'submit_report'], // the report is sent with N3's lesson report
  taken: ['revert', 'submit_report'], // staff may always edit (D70)
  absent: ['revert'],
  declined: ['revert'],
  leave: ['revert'],
  cancelled: ['revert'],
};
const TARGET: Record<string, string> = {
  activate: 'activated',
  undo_activate: 'scheduled',
  start: 'in_progress',
  end: 'ended',
  mark_absent: 'absent',
  mark_declined: 'declined',
  mark_leave: 'leave',
  cancel: 'cancelled',
  revert: 'scheduled',
};

describe('state machine (StateMachineTest)', () => {
  it.each(Object.keys(ALLOWED))(
    'allows exactly the transitions of the table for a manager (§3.2): %s',
    async (stage) => {
      at('2026-11-10 15:26:00'); // inside every time window
      const unstarted = ['scheduled', 'leave', 'cancelled'].includes(stage);
      await ctx.prisma.classSession.update({
        where: { id: sessionId },
        data: {
          stage: stage as SessionStage,
          activatedAt: unstarted ? null : new Date('2026-11-10T15:00:00Z'),
        },
      });
      expect((await allowed(manager)).sort()).toEqual([...ALLOWED[stage]!].sort());

      for (const action of ALL.filter((a) => !ALLOWED[stage]!.includes(a))) {
        if (TARGET[action] === stage) continue; // repeating an action on its target is a no-op
        expect(
          await code(
            apply(action, manager, {
              note: 'n',
              reason: 'r',
              stageReason: 'admin',
              override: true,
            }),
          ),
          `${stage} → ${action}`,
        ).toEqual([409, 'invalid_transition']);
      }
    },
  );

  it('gives the own teacher only the conduct actions', async () => {
    expect(await allowed(own)).toEqual(['activate', 'mark_leave']);
    expect(await allowed(otherTeacher)).toEqual([]);
    expect(await allowed(parent)).toEqual([]);
  });

  it('records an event with from/to stage and actor for each transition', async () => {
    await apply('activate', own);
    const events = await ctx.prisma.sessionEvent.findMany({ where: { sessionId } });
    expect(events).toHaveLength(1);
    expect([
      events[0]!.type,
      events[0]!.fromStage,
      events[0]!.toStage,
      events[0]!.actorUserId,
      events[0]!.actorRole,
    ]).toEqual(['activated', 'scheduled', 'activated', teacher.user.id, 'teacher']);
  });

  it('lets only the own teacher (or staff) conduct a class', async () => {
    expect(await code(apply('activate', otherTeacher))).toEqual([403, 'forbidden']);
    expect(await code(apply('activate', parent))).toEqual([403, 'forbidden']);
    expect(await code(apply('cancel', own, { stageReason: 'admin' }))).toEqual([403, 'forbidden']);
  });

  it('opens activation 10 minutes before the start and closes 30 minutes after the end', async () => {
    at('2026-11-10T14:49:59Z');
    expect(await code(apply('activate', own))).toEqual([422, 'outside_window']);

    at('2026-11-10T14:50:00Z');
    await apply('activate', own);
    expect((await row()).stage).toBe('activated');
    await apply('undo_activate', own);

    const late = await m2Session(ctx, enrollment, '2026-11-11T15:00:00Z');
    at('2026-11-11T16:00:01Z');
    expect(await code(apply('activate', own, {}, late.id))).toEqual([422, 'outside_window']);
    // staff may override, with a reason
    expect(await code(apply('activate', manager, { override: true }, late.id))).toEqual([
      422,
      'validation_failed',
    ]);
    await apply('activate', manager, { override: true, reason: 'teacher forgot' }, late.id);
    expect((await row(late.id)).stage).toBe('activated');
  });

  it('allows one running class per teacher (invariant 5)', async () => {
    await apply('activate', own);
    const second = await m2Session(
      ctx,
      await m2Enrollment(ctx, await m2Student(ctx), teacher),
      '2026-11-10T15:00:00Z',
    );
    expect(await code(apply('activate', own, {}, second.id))).toEqual([409, 'invalid_transition']);
  });

  it('lets the teacher undo an activation within 10 minutes only', async () => {
    await apply('activate', own);
    at('2026-11-10T15:10:00Z');
    await apply('undo_activate', own);
    expect((await row()).activatedAt).toBeNull();

    await apply('activate', own);
    at('2026-11-10T15:20:01Z');
    expect(await code(apply('undo_activate', own))).toEqual([422, 'outside_window']);
    await apply('undo_activate', manager);
    expect((await row()).stage).toBe('scheduled');
  });

  it('ends only after 25 minutes for a teacher; staff end early with a reason and a review flag', async () => {
    await apply('activate', own);
    at('2026-11-10T15:24:59Z');
    expect(await code(apply('end', own))).toEqual([422, 'outside_window']);
    expect(await code(apply('end', manager))).toEqual([422, 'validation_failed']);

    await apply('end', manager, { reason: 'internet cut' });
    const s = await row();
    expect([s.stage, s.needsReview, s.reviewReason]).toEqual(['ended', true, 'short_duration']);

    const other = await m2Session(ctx, enrollment, '2026-11-12T15:00:00Z');
    at('2026-11-12T15:00:00Z');
    await apply('activate', own, {}, other.id);
    at('2026-11-12T15:25:00Z');
    await apply('end', own, {}, other.id);
    expect((await row(other.id)).needsReview).toBe(false);
  });

  it('marks absent only 25 minutes after the start, with a note', async () => {
    await apply('activate', own);
    at('2026-11-10T15:24:59Z');
    expect(await code(apply('mark_absent', own, { note: 'called' }))).toEqual([
      422,
      'outside_window',
    ]);
    expect(await allowed(own)).not.toContain('mark_absent');

    at('2026-11-10T15:25:00Z');
    expect(await allowed(own)).toContain('mark_absent');
    expect(await code(apply('mark_absent', own))).toEqual([422, 'validation_failed']);

    await apply('mark_absent', own, { note: 'called the parent' });
    const s = await row();
    expect([s.stage, s.markedById]).toEqual(['absent', teacher.user.id]);
    expect(s.markedAt?.toISOString()).toBe('2026-11-10T15:25:00.000Z');
  });

  it('takes a leave from the teacher only with 2 hours notice; staff any time', async () => {
    const s = await m2Session(ctx, enrollment, '2026-11-10T18:00:00Z');
    at('2026-11-10T16:00:01Z');
    expect(await code(apply('mark_leave', own, {}, s.id))).toEqual([422, 'outside_window']);
    await apply('mark_leave', own, { notifiedAt: '2026-11-10T15:00:00Z' }, s.id);
    expect((await row(s.id)).stage).toBe('leave');

    const t = await m2Session(ctx, enrollment, '2026-11-10T16:30:00Z');
    expect(
      await code(
        apply(
          'mark_leave',
          own,
          { stageReason: 'teacher', notifiedAt: '2026-11-10T10:00:00Z' },
          t.id,
        ),
      ),
    ).toEqual([422, 'validation_failed']);
    await apply('mark_leave', manager, { stageReason: 'teacher' }, t.id);
    expect((await row(t.id)).stageReason).toBe('teacher');
  });

  it('requires a cancel reason from the list', async () => {
    expect(await code(apply('cancel', manager, { stageReason: 'bored' }))).toEqual([
      422,
      'validation_failed',
    ]);
    await apply('cancel', manager, { stageReason: 'teacher_unavailable' });
    expect((await row()).stageReason).toBe('teacher_unavailable');
  });

  it('is double-click safe and detects stale clients', async () => {
    await apply('activate', own, { expectedStage: 'scheduled' });
    await apply('activate', own, { expectedStage: 'scheduled' });
    expect((await row()).stage).toBe('activated');
    expect(await ctx.prisma.sessionEvent.count({ where: { sessionId } })).toBe(1);

    expect(
      await code(apply('mark_declined', own, { expectedStage: 'scheduled', note: 'x' })),
    ).toEqual([409, 'stale_session']);
    expect(await code(apply('start', own, { lockVersion: 0 }))).toEqual([409, 'stale_session']);
  });

  it('lets the marker undo a mark within 2 minutes (the Undo toast)', async () => {
    await apply('activate', own);
    at('2026-11-10T15:26:00Z');
    await apply('mark_absent', own, { note: 'n' });

    expect(await code(apply('undo_mark', manager))).toEqual([409, 'invalid_transition']);
    await apply('undo_mark', own);
    const s = await row();
    expect([s.stage, s.markedAt]).toEqual(['activated', null]);
    const last = await ctx.prisma.sessionEvent.findFirstOrThrow({
      where: { sessionId },
      orderBy: { id: 'desc' },
    });
    expect((last.payload as { undo?: boolean }).undo).toBe(true);

    await apply('mark_absent', own, { note: 'n' });
    at('2026-11-10T15:28:01Z');
    expect(await code(apply('undo_mark', own))).toEqual([409, 'invalid_transition']);
  });

  it('reverts a terminal class with a reason, clearing the mark', async () => {
    await apply('activate', own);
    at('2026-11-10T15:30:00Z');
    await apply('mark_absent', own, { note: 'n' });

    expect(await code(apply('revert', manager))).toEqual([422, 'validation_failed']);
    await apply('revert', manager, { reason: 'wrong class' });
    const s = await row();
    expect([s.stage, s.markedAt, s.activatedAt, s.stageReason]).toEqual([
      'scheduled',
      null,
      null,
      null,
    ]);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'keeps the §3.3 invariants over random transition sequences (seed %i)',
    async (seed) => {
      let state = seed;
      const rand = (n: number) => {
        state = (state * 1103515245 + 12345) % 2 ** 31;
        return state % n;
      };
      const actors = [own, manager];
      const actions = [
        'activate',
        'undo_activate',
        'start',
        'end',
        'mark_absent',
        'mark_declined',
        'mark_leave',
        'cancel',
        'undo_mark',
        'revert',
      ] as const;
      for (let i = 0; i < 25; i++) {
        at(new Date(Date.parse('2026-11-10T14:50:00Z') + rand(61) * 60_000).toISOString());
        const action = actions[rand(actions.length)]!;
        try {
          await apply(action, actors[rand(2)]!, {
            note: 'n',
            reason: 'r',
            ...(action === 'cancel' ? { stageReason: 'admin' } : {}),
          });
        } catch {
          // refused: the state must still hold
        }
        const s = await row();
        expect(s.endsAt.getTime() - s.startsAt.getTime()).toBe(s.durationMinutes * 60_000);
        if (s.stage === 'scheduled') expect(s.activatedAt).toBeNull();
        else if (!['leave', 'cancelled', 'moved_out'].includes(s.stage)) {
          expect(s.activatedAt).not.toBeNull();
        }
        const terminal = ['taken', 'absent', 'declined', 'leave', 'cancelled', 'moved_out'];
        if (terminal.includes(s.stage)) expect(s.markedAt).not.toBeNull();
        else expect(s.markedAt).toBeNull();
        expect(
          await ctx.prisma.classSession.count({
            where: { teacherId: teacher.id, stage: { in: ['activated', 'in_progress'] } },
          }),
        ).toBeLessThanOrEqual(1);
      }
    },
  );
});
