import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TrialFollowUp } from '../src/crm/followup.service.js';
import { SettingsService } from '../src/settings/settings.service.js';
import {
  Client,
  clock,
  createTestApp,
  createUser,
  m2Teacher,
  makeCourse,
  resetState,
  signedIn,
  signInAs,
  type TestContext,
  zoomDriver,
} from './helpers.js';
import { crmAt, crmLead, resetCrm } from './n5-helpers.js';

/*
| T4 (docs/33 §3.5–3.7, B85, B86): reminders before a trial, the monitors' late alert and
| checklist, the teacher's trial report (required to close the class) with the CSR's follow-up
| task, and the stale rule. Now: Mon 2026-11-16 09:00 UTC; the trial is Wed 2026-11-18 17:00 UTC
| (London = UTC in November; 19:00 Cairo).
*/

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

let csr: Client;
let csrId: number;
let leadId: number;
let courseId: number;
let studentId: number;
let teacher: { id: number; userId: number; client: Client };
let sessionId: number;

const run = () => ctx.app.get(TrialFollowUp);
const report = {
  attendance: 'on_time',
  level: 'beginner',
  classesPerWeek: 2,
  minutesPerClass: 30,
  engagement: 'high',
  notes: 'Knows the alphabet; shy at first',
};
const ended = () =>
  ctx.prisma.classSession.update({
    where: { id: sessionId },
    data: {
      stage: 'ended',
      startedAt: new Date('2026-11-18T17:01:00Z'),
      endedAt: new Date('2026-11-18T17:30:00Z'),
    },
  });

beforeEach(async () => {
  await resetState(ctx);
  resetCrm(ctx);
  zoomDriver(ctx, 'fake');
  crmAt(ctx, '2026-11-16T09:00:00Z');
  const signed = await signedIn(ctx, 'csr');
  csr = signed.client;
  csrId = signed.user.id;
  leadId = (
    await crmLead(ctx, {
      status: 'contacted',
      assignedToId: csrId,
      parentName: 'Umm Maryam',
      countryCode: 'GB',
    })
  ).id;
  courseId = (await makeCourse(ctx)).id;
  const account = await csr.post(`/leads/${leadId}/account`, {
    parentName: 'Umm Maryam',
    email: 'umm.maryam@example.com',
    timezone: 'Europe/London',
    children: [{ name: 'Maryam', age: 8, gender: 'female', courseId }],
  });
  studentId = account.body.data.students[0].id;
  const t = await m2Teacher(ctx, 'Africa/Cairo', 'Amina');
  await ctx.prisma.teacherCourse.create({ data: { teacherId: t.id, courseId } });
  const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: t.userId } });
  teacher = { id: t.id, userId: t.userId, client: await signInAs(ctx, user) };
  const booked = await csr.post(`/leads/${leadId}/trials`, {
    studentId,
    courseId,
    teacherId: t.id,
    localDate: '2026-11-18',
    localTime: '17:00',
    acknowledgeWarnings: ['outside_work_hours'],
  });
  expect(booked.status).toBe(201);
  sessionId = booked.body.meta.trial.sessionId;
});

describe('T4 reminders and the monitors', () => {
  it('reminds the teacher 24 h and 1 h before, once each; the family only when allowed', async () => {
    expect(await run().reminders()).toBe(0); // 2 days ahead
    clock(ctx).set(new Date('2026-11-17T18:00:00Z'));
    expect(await run().reminders()).toBe(1);
    expect(await run().reminders()).toBe(0);
    clock(ctx).set(new Date('2026-11-18T16:15:00Z'));
    expect(await run().reminders()).toBe(1);
    const rows = await ctx.prisma.notification.findMany({
      where: { userId: teacher.userId, event: 'trial_reminder' },
      orderBy: { id: 'asc' },
    });
    expect(rows.map((r) => (r.data as { window: string }).window)).toEqual([
      'before_24h',
      'before_1h',
    ]);
    expect(rows[0]!.data).toMatchObject({ sessionId, teacherLocal: '2026-11-18 19:00' });
    // D140: no family reminder unless switched on.
    const family = await ctx.prisma.lead.findUniqueOrThrow({
      where: { id: leadId },
      include: { family: true },
    });
    expect(await ctx.prisma.notification.count({ where: { userId: family.family!.userId } })).toBe(
      0,
    );
  });

  it('sends the family reminder when the academy switches it on', async () => {
    await ctx.app.get(SettingsService).set('crm.trial_family_reminders', true, null);
    clock(ctx).set(new Date('2026-11-17T18:00:00Z'));
    expect(await run().reminders()).toBe(2);
    const lead = await ctx.prisma.lead.findUniqueOrThrow({
      where: { id: leadId },
      include: { family: true },
    });
    expect(
      await ctx.prisma.notification.findFirst({
        where: { userId: lead.family!.userId, event: 'trial_upcoming' },
      }),
    ).not.toBeNull();
  });

  it('alerts the monitors once when the teacher has not started 5 minutes in', async () => {
    const monitor = await createUser(ctx, 'monitor');
    clock(ctx).set(new Date('2026-11-18T17:03:00Z'));
    expect(await run().lateAlerts()).toBe(0);
    clock(ctx).set(new Date('2026-11-18T17:06:00Z'));
    expect(await run().lateAlerts()).toBeGreaterThanOrEqual(1);
    expect(await run().lateAlerts()).toBe(0);
    const alert = await ctx.prisma.notification.findFirstOrThrow({
      where: { userId: monitor.id, event: 'trial_late' },
    });
    expect(alert.data).toMatchObject({ sessionId, lateMinutes: 6 });

    const { client: mon } = await signedIn(ctx, 'monitor');
    const today = await mon.get('/trials/today?date=2026-11-18&tz=UTC');
    expect(today.status).toBe(200);
    expect(today.body.data).toEqual([
      expect.objectContaining({
        sessionId,
        leadId,
        teacherStarted: false,
        lateMinutes: 6,
        reportSubmitted: false,
        alerts: ['not_started'],
      }),
    ]);
  });

  it('the checklist shows a late start and a missing report', async () => {
    await ctx.prisma.classSession.update({
      where: { id: sessionId },
      data: {
        stage: 'ended',
        startedAt: new Date('2026-11-18T17:09:00Z'),
        endedAt: new Date('2026-11-18T17:30:00Z'),
      },
    });
    clock(ctx).set(new Date('2026-11-18T18:00:00Z'));
    const res = await csr.get('/trials/today?date=2026-11-18&tz=UTC');
    expect(res.body.data[0]).toMatchObject({
      teacherStarted: true,
      lateMinutes: 9,
      alerts: ['started_late', 'no_report'],
    });
  });
});

describe('T4 the teacher’s trial report', () => {
  it('is required to close the trial class (B85)', async () => {
    await ended();
    clock(ctx).set(new Date('2026-11-18T17:35:00Z'));
    const plain = await teacher.client.put(`/sessions/${sessionId}/report`, { summary: 'Done' });
    expect(plain.status).toBe(422);
    expect(plain.body.code).toBe('trial_report_required');
    // Before the class ends: 409.
    await ctx.prisma.classSession.update({
      where: { id: sessionId },
      data: { stage: 'scheduled' },
    });
    const early = await teacher.client.put(`/sessions/${sessionId}/trial-report`, report);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('trial_not_ended');
  });

  it('closes the class, moves the lead, tells the CSR and opens the follow-up task', async () => {
    await ended();
    clock(ctx).set(new Date('2026-11-18T17:35:00Z'));
    const res = await teacher.client.put(`/sessions/${sessionId}/trial-report`, {
      ...report,
      recommendedCourseId: courseId,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      sessionId,
      leadId,
      level: 'beginner',
      recommendedCourse: { id: courseId },
      classesPerWeek: 2,
      submittedBy: { id: teacher.userId },
    });
    const session = await ctx.prisma.classSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.stage).toBe('taken');
    const lead = await ctx.prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.status).toBe('trial_done');
    expect(
      await ctx.prisma.notification.count({
        where: { userId: csrId, kind: 'lead', event: 'trial_report' },
      }),
    ).toBe(1);
    const task = await ctx.prisma.task.findFirstOrThrow({
      where: { assigneeId: csrId, subjectType: 'lead', subjectId: leadId },
    });
    expect(task.priority).toBe('high');
    expect(task.dueAt?.toISOString()).toBe('2026-11-19T17:35:00.000Z');
    expect(task.description).toContain('مبتدئ');

    // The CSR reads it on the lead; an edit later does not open a second task.
    const list = await csr.get(`/leads/${leadId}/trial-reports`);
    expect(list.body.data).toHaveLength(1);
    const edit = await teacher.client.put(`/sessions/${sessionId}/trial-report`, {
      ...report,
      level: 'intermediate',
    });
    expect(edit.status).toBe(200);
    expect(edit.body.data.level).toBe('intermediate');
    expect(await ctx.prisma.task.count({ where: { subjectId: leadId } })).toBe(1);
    // The edit window (sessions.report_edit_hours) closes for the teacher, not for staff.
    clock(ctx).set(new Date('2026-12-01T00:00:00Z'));
    const locked = await teacher.client.put(`/sessions/${sessionId}/trial-report`, report);
    expect(locked.status).toBe(422);
    expect(locked.body.code).toBe('trial_report_locked');
  });

  it('only the class’s teacher or staff: 404 for another teacher, 403 for a parent, 401', async () => {
    await ended();
    const other = await m2Teacher(ctx, 'Africa/Cairo', 'Basma');
    const otherUser = await ctx.prisma.user.findUniqueOrThrow({ where: { id: other.userId } });
    const otherClient = await signInAs(ctx, otherUser);
    expect((await otherClient.put(`/sessions/${sessionId}/trial-report`, report)).status).toBe(404);
    expect((await otherClient.get(`/sessions/${sessionId}/trial-report`)).status).toBe(404);
    const { client: parent } = await signedIn(ctx, 'parent');
    expect((await parent.get(`/sessions/${sessionId}/trial-report`)).status).toBe(403);
    expect((await parent.get('/trials/today')).status).toBe(403);
    expect((await teacher.client.get('/trials/today')).status).toBe(403);
    expect((await teacher.client.get(`/leads/${leadId}/trial-reports`)).status).toBe(403);
    const anon = await new Client(ctx.app).init();
    expect((await anon.put(`/sessions/${sessionId}/trial-report`, report)).status).toBe(401);
    expect((await anon.get('/trials/today')).status).toBe(401);
    // Validation.
    expect(
      (await teacher.client.put(`/sessions/${sessionId}/trial-report`, { level: 'expert' })).status,
    ).toBe(422);
  });
});

describe('T4 the stale rule (B86)', () => {
  it('reminds after 3 days and suggests «مفقود» after 14, once each', async () => {
    await ctx.prisma.lead.update({
      where: { id: leadId },
      data: { status: 'trial_done', statusChangedAt: new Date('2026-11-16T09:00:00Z') },
    });
    expect(await run().staleRules()).toBe(0);
    clock(ctx).set(new Date('2026-11-19T10:00:00Z'));
    expect(await run().staleRules()).toBe(1);
    expect(await run().staleRules()).toBe(0);
    clock(ctx).set(new Date('2026-12-01T10:00:00Z'));
    expect(await run().staleRules()).toBe(1);
    const events = await ctx.prisma.notification.findMany({
      where: { userId: csrId, kind: 'lead', event: { in: ['trial_stale', 'trial_stale_lost'] } },
      orderBy: { id: 'asc' },
      select: { event: true },
    });
    expect(events.map((e) => e.event)).toEqual(['trial_stale', 'trial_stale_lost']);
    expect((await run().run()).stale).toBe(0);
  });
});
