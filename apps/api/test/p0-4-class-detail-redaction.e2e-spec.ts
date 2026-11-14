import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clock,
  createTestApp,
  createUser,
  m2Enrollment,
  m2Session,
  m2Student,
  m2Teacher,
  resetState,
  signInAs,
  type TestContext,
} from './helpers.js';

/*
| P0-4 (docs/39 ISO-1, ISO-3; B118): a parent or teacher reading a class gets the class's own
| story — no monitor notes, reasons or overrides, staff by role only (never a name), no join
| evidence or review flag. Staff who manage classes see everything.
*/

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

let sessionId: number;
let studentId: number;
let parentUser: { email: string };
let teacherUser: { email: string; id: number };
let monitor: { id: number; email: string; name: string };

beforeEach(async () => {
  await resetState(ctx);
  clock(ctx).set(new Date('2026-11-16T12:00:00Z'));
  const student = await m2Student(ctx, 'Europe/London');
  studentId = student.id;
  parentUser = student.family.user;
  const teacher = await m2Teacher(ctx);
  teacherUser = await ctx.prisma.user.findUniqueOrThrow({ where: { id: teacher.userId } });
  const enrollment = await m2Enrollment(ctx, student, teacher);
  const session = await m2Session(ctx, enrollment, '2026-11-16T10:00:00Z', { stage: 'absent' });
  sessionId = session.id;
  monitor = await createUser(ctx, 'monitor', { name: 'Hana Monitor' });
  await ctx.prisma.classSession.update({
    where: { id: sessionId },
    data: {
      needsReview: true,
      reviewReason: 'Teacher joined 20 minutes late',
      teacherJoinedAt: new Date('2026-11-16T10:20:00Z'),
    },
  });
  await ctx.prisma.sessionEvent.createMany({
    data: [
      {
        sessionId,
        type: 'marked',
        fromStage: 'activated',
        toStage: 'absent',
        actorUserId: monitor.id,
        actorRole: 'monitor',
        payload: {
          action: 'mark_absent',
          note: 'X — the teacher was rude on the phone',
          reason: 'internal',
          override: true,
          stageReason: 'student_absent',
        },
        occurredAt: new Date('2026-11-16T10:30:00Z'),
      },
      {
        sessionId,
        type: 'note',
        actorUserId: monitor.id,
        actorRole: 'monitor',
        payload: { note: 'Call the family about payment' },
        occurredAt: new Date('2026-11-16T10:31:00Z'),
      },
      {
        sessionId,
        type: 'zoom_start_url_issued',
        actorUserId: teacherUser.id,
        actorRole: 'teacher',
        occurredAt: new Date('2026-11-16T09:55:00Z'),
      },
    ],
  });
  await ctx.prisma.sessionRequest.create({
    data: {
      sessionId,
      studentId,
      type: 'leave',
      status: 'rejected',
      reason: 'Staff filed: family said travel',
      requestedById: monitor.id,
      requesterRole: 'monitor',
      decisionNote: 'Too late; counted as absent',
      decidedAt: new Date('2026-11-16T09:00:00Z'),
    },
  });
});

const detail = async (user: { email: string }) => {
  const client = await signInAs(ctx, user);
  const res = await client.get(`/sessions/${sessionId}`);
  expect(res.status).toBe(200);
  return res.body.data as {
    events: Array<{
      type: string;
      actor: { id: number | null; name: string | null; role: string | null } | null;
      payload: Record<string, unknown> | null;
    }>;
    requests: Array<{
      reason: string;
      decisionNote: string | null;
      requestedBy: { name: string | null };
    }>;
    needsReview: boolean;
    reviewReason: string | null;
    evidence: { teacherJoinedAt: string | null };
  };
};

describe('P0-4 class detail is viewer-aware', () => {
  for (const who of ['parent', 'teacher'] as const) {
    it(`a ${who} sees no notes, reasons, overrides or staff names`, async () => {
      const d = await detail(who === 'parent' ? parentUser : teacherUser);
      const text = JSON.stringify(d);
      expect(text).not.toContain('rude');
      expect(text).not.toContain('payment');
      expect(text).not.toContain('Hana Monitor');
      expect(text).not.toContain('family said travel');
      expect(text).not.toContain('Too late');
      expect(text).not.toContain('Teacher joined 20 minutes late');
      expect(d.events.map((e) => e.type)).toEqual(['marked']);
      expect(d.events[0]).toMatchObject({
        actor: { id: null, name: null, role: 'monitor' },
        payload: { action: 'mark_absent', stageReason: 'student_absent' },
      });
      expect(d.events[0]!.payload).not.toHaveProperty('override');
      expect(d.requests[0]).toMatchObject({
        reason: '',
        decisionNote: null,
        requestedBy: { name: null },
      });
      expect(d.needsReview).toBe(false);
      expect(d.reviewReason).toBeNull();
      expect(d.evidence.teacherJoinedAt).toBeNull();
    });
  }

  it('a monitor (sessions.manage) sees the whole timeline with names', async () => {
    const d = await detail(monitor);
    expect(d.events.map((e) => e.type)).toEqual(['zoom_start_url_issued', 'marked', 'note']);
    const marked = d.events.find((e) => e.type === 'marked')!;
    expect(marked.actor).toMatchObject({ id: monitor.id, name: 'Hana Monitor' });
    expect(marked.payload).toMatchObject({
      note: 'X — the teacher was rude on the phone',
      override: true,
    });
    expect(d.requests[0]).toMatchObject({
      reason: 'Staff filed: family said travel',
      decisionNote: 'Too late; counted as absent',
    });
    expect(d).toMatchObject({ needsReview: true, reviewReason: 'Teacher joined 20 minutes late' });
    expect(d.evidence.teacherJoinedAt).toBe('2026-11-16T10:20:00Z');
  });

  it('a requester keeps their own request’s reason and decision note', async () => {
    const parent = await ctx.prisma.user.findUniqueOrThrow({ where: { email: parentUser.email } });
    await ctx.prisma.sessionRequest.updateMany({
      data: { requestedById: parent.id, requesterRole: 'parent', reason: 'We travel' },
    });
    const d = await detail(parentUser);
    expect(d.requests[0]).toMatchObject({
      reason: 'We travel',
      decisionNote: 'Too late; counted as absent',
      requestedBy: { name: expect.any(String) },
    });
  });
});

describe('ISO-3 student record for portal viewers', () => {
  beforeEach(async () => {
    await ctx.prisma.student.update({
      where: { id: studentId },
      data: {
        remarkParent: 'For the parent',
        remarkTeacher: 'For the teacher',
        status: 'inactive',
        statusReason: 'Unpaid since October',
        statusChangedById: monitor.id,
        statusChangedAt: new Date('2026-11-10T10:00:00Z'),
      },
    });
  });

  it('a parent gets no staff reason or who changed it, and not the teacher remark', async () => {
    const client = await signInAs(ctx, parentUser);
    const res = await client.get(`/students/${studentId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toMatchObject({ reason: null, changedBy: null });
    expect(res.body.data).toMatchObject({ remarkParent: 'For the parent', remarkTeacher: null });
  });
});
