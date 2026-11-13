import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { median, rate } from '../src/crm/kpis.service.js';
import {
  Client,
  createTestApp,
  m2Teacher,
  makeCourse,
  resetState,
  signedIn,
  type TestContext,
  zoomDriver,
} from './helpers.js';
import { crmAt, crmLead, resetCrm } from './n5-helpers.js';

/*
| T5 (docs/33 §6): the CRM rates from real data, and the lost reasons. Now: Mon 2026-11-16
| 09:00 UTC (11:00 Cairo, inside the 10:00–22:00 working hours).
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
let courseId: number;
let teacherId: number;

/** A lead with a family account and a trial booked with the teacher, then set to `stage`. */
async function withTrial(
  source: 'web_form' | 'phone',
  firstResponseAt: string | null,
  stage: 'taken' | 'absent',
  email: string,
) {
  const lead = await crmLead(ctx, {
    status: 'contacted',
    source,
    assignedToId: csrId,
    firstResponseAt: firstResponseAt ? new Date(firstResponseAt) : null,
  });
  const account = await csr.post(`/leads/${lead.id}/account`, {
    parentName: 'Parent',
    email,
    timezone: 'Europe/London',
    children: [{ name: 'Child', age: 8, gender: 'female', courseId }],
  });
  const booked = await csr.post(`/leads/${lead.id}/trials`, {
    studentId: account.body.data.students[0].id,
    courseId,
    teacherId,
    localDate: '2026-11-17',
    localTime: email.startsWith('a') ? '17:00' : '18:00',
    acknowledgeWarnings: ['outside_work_hours'],
  });
  expect(booked.status).toBe(201);
  await ctx.prisma.classSession.update({
    where: { id: booked.body.meta.trial.sessionId },
    data: { stage },
  });
  return lead;
}

beforeEach(async () => {
  await resetState(ctx);
  resetCrm(ctx);
  zoomDriver(ctx, 'fake');
  crmAt(ctx, '2026-11-16T09:00:00Z');
  const signed = await signedIn(ctx, 'csr');
  csr = signed.client;
  csrId = signed.user.id;
  courseId = (await makeCourse(ctx)).id;
  const t = await m2Teacher(ctx, 'Africa/Cairo', 'Amina');
  teacherId = t.id;
  await ctx.prisma.teacherCourse.create({ data: { teacherId, courseId } });
});

describe('T5 CRM rates', () => {
  it('computes the rates in total, by source, owner, teacher and course', async () => {
    // Answered in 20 min (inside the SLA), trial held, converted 2 days later.
    const a = await withTrial('web_form', '2026-11-16T09:20:00Z', 'taken', 'a@example.com');
    await ctx.prisma.lead.update({
      where: { id: a.id },
      data: { status: 'converted', convertedAt: new Date('2026-11-18T09:00:00Z') },
    });
    // Answered in 60 min (outside), the child did not come.
    await withTrial('web_form', '2026-11-16T10:00:00Z', 'absent', 'b@example.com');
    // Never answered, lost because of the teacher.
    await crmLead(ctx, {
      status: 'lost',
      source: 'phone',
      assignedToId: csrId,
      lostReason: 'teacher',
    });
    // Spam is not a lead.
    await crmLead(ctx, { status: 'spam', source: 'web_form' });

    const res = await csr.get('/leads/kpis?from=2026-11-16&to=2026-11-16');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.total).toEqual({
      leads: 3,
      firstResponse: {
        measured: 2,
        medianMinutes: 40,
        withinSla: { numerator: 1, denominator: 2, pct: 50 },
      },
      leadToTrial: { numerator: 2, denominator: 3, pct: 66.7 },
      trialShowUp: { numerator: 1, denominator: 2, pct: 50 },
      trialToRegular: { numerator: 1, denominator: 1, pct: 100 },
      medianDaysToRegular: 2,
    });
    expect(d.bySource.map((r: { source: string; leads: number }) => [r.source, r.leads])).toEqual([
      ['web_form', 2],
      ['phone', 1],
    ]);
    expect(d.bySource[1].leadToTrial).toEqual({ numerator: 0, denominator: 1, pct: 0 });
    expect(d.bySource[1].trialShowUp.pct).toBeNull();
    expect(d.byAssignee).toEqual([
      expect.objectContaining({ user: { id: csrId, name: expect.any(String) }, leads: 3 }),
    ]);
    expect(d.byTeacher).toEqual([
      {
        teacher: { id: teacherId, name: expect.stringContaining('Amina') },
        trials: 2,
        showUp: { numerator: 1, denominator: 2, pct: 50 },
        toRegular: { numerator: 1, denominator: 1, pct: 100 },
      },
    ]);
    expect(d.byCourse[0]).toMatchObject({ course: { id: courseId }, trials: 2 });
    const teacherReason = d.lostReasons.find((r: { reason: string }) => r.reason === 'teacher');
    expect(teacherReason).toEqual({
      reason: 'teacher',
      count: 1,
      bySource: [{ source: 'phone', count: 1 }],
    });
    expect(d.lostReasons).toHaveLength(7);
    expect(d.lostTotal).toBe(1);
  });

  it('says nothing when there is nothing: zeros and null rates, never invented numbers', async () => {
    const res = await csr.get('/leads/kpis');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      from: '2026-11-01',
      to: '2026-11-16',
      total: {
        leads: 0,
        firstResponse: { measured: 0, medianMinutes: null, withinSla: { pct: null } },
        leadToTrial: { pct: null },
        medianDaysToRegular: null,
      },
      bySource: [],
      byTeacher: [],
      lostTotal: 0,
    });
  });

  it('refuses a reversed or too long period; staff with leads.view only', async () => {
    expect((await csr.get('/leads/kpis?from=2026-11-10&to=2026-11-01')).status).toBe(422);
    const long = await csr.get('/leads/kpis?from=2025-01-01&to=2026-11-01');
    expect(long.status).toBe(422);
    expect(long.body.code).toBe('range_too_long');
    const anon = await new Client(ctx.app).init();
    expect((await anon.get('/leads/kpis')).status).toBe(401);
    const { client: teacher } = await signedIn(ctx, 'teacher');
    expect((await teacher.get('/leads/kpis')).status).toBe(403);
  });

  it('accepts «المعلم» as a lost reason on the trial outcome', async () => {
    const lead = await withTrial('web_form', null, 'taken', 'c@example.com');
    await ctx.prisma.classSession.updateMany({ data: { stage: 'scheduled' } });
    const res = await csr.post(`/leads/${lead.id}/trial-outcome`, {
      outcome: 'not_interested',
      lostReason: 'teacher',
    });
    expect(res.status).toBe(200);
    expect((await ctx.prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).lostReason).toBe(
      'teacher',
    );
  });
});

describe('rate helpers', () => {
  it('rounds to one decimal and finds the median', () => {
    expect(rate(2, 3).pct).toBe(66.7);
    expect(rate(0, 0).pct).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
