import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
| T2 (docs/33 §4.1–4.2, D136): which teachers can take a trial, ranked with the factors shown;
| booking a teacher who is not eligible needs a reason; the teacher is told without any family
| contact details. The family lives in London; the trial is Wed 2026-11-18 17:00 London.
*/

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

let client: Client;
let leadId: number;
let courseId: number;
let studentId: number;

const teacher = async (
  name: string,
  data: Record<string, unknown> = {},
  teaches = true,
): Promise<{ id: number; userId: number }> => {
  const t = await m2Teacher(ctx, 'Africa/Cairo', name);
  if (teaches) await ctx.prisma.teacherCourse.create({ data: { teacherId: t.id, courseId } });
  if (Object.keys(data).length) await ctx.prisma.teacher.update({ where: { id: t.id }, data });
  return t;
};

const query = (extra = '') =>
  client.get(
    `/leads/${leadId}/trial-teachers?studentId=${studentId}&courseId=${courseId}&localDate=2026-11-18&localTime=17:00${extra}`,
  );

const book = (teacherId: number, extra: Record<string, unknown> = {}) =>
  client.post(`/leads/${leadId}/trials`, {
    studentId,
    courseId,
    teacherId,
    localDate: '2026-11-18',
    localTime: '17:00',
    acknowledgeWarnings: ['outside_work_hours'],
    ...extra,
  });

beforeEach(async () => {
  await resetState(ctx);
  resetCrm(ctx);
  zoomDriver(ctx, 'fake');
  crmAt(ctx, '2026-11-16T09:00:00Z');
  const signed = await signedIn(ctx, 'csr');
  client = signed.client;
  leadId = (
    await crmLead(ctx, {
      status: 'contacted',
      assignedToId: signed.user.id,
      countryCode: 'GB',
      email: 'umm.maryam@example.com',
    })
  ).id;
  await ctx.prisma.lead.update({ where: { id: leadId }, data: { teacherGenderPref: 'female' } });
  courseId = (await makeCourse(ctx)).id;
  const account = await client.post(`/leads/${leadId}/account`, {
    parentName: 'Umm Maryam',
    email: 'umm.maryam@example.com',
    phone: '+447700900123',
    timezone: 'Europe/London',
    countryCode: 'GB',
    children: [{ name: 'Maryam', age: 8, gender: 'female', courseId }],
  });
  expect(account.status).toBe(201);
  studentId = account.body.data.students[0].id;
  await ctx.prisma.student.update({ where: { id: studentId }, data: { language: 'english' } });
});

describe('T2 trial teachers: eligibility and ranking', () => {
  it('ranks the eligible teachers and gives every other teacher its reasons', async () => {
    const plain = await teacher('Amina', { gender: 'female' });
    const speaks = await teacher('Basma', { gender: 'female', languages: ['english', 'arabic'] });
    const noTrials = await teacher('Dalia', { gender: 'female', acceptsTrials: false });
    const noCourse = await teacher('Eman', { gender: 'female' }, false);
    const male = await teacher('Fadi', { gender: 'male' });
    const adults = await teacher('Ghada', { gender: 'female', audience: 'adults' });
    const capped = await teacher('Hiba', { gender: 'female', maxTrialsPerWeek: 0 });
    const onLeave = await teacher('Iman', { gender: 'female' });
    await ctx.prisma.leaveRequest.create({
      data: {
        userId: onLeave.userId,
        startsOn: new Date('2026-11-17'),
        endsOn: new Date('2026-11-19'),
        days: 3,
        leaveType: 'paid',
        reason: 'Family visit',
        status: 'approved',
      },
    });
    const busy = await teacher('Jana', { gender: 'female' });
    // 17:00 London = 19:00 Cairo: a one-off block over it.
    await ctx.prisma.teacherBlock.create({
      data: {
        teacherId: busy.id,
        kind: 'one_off',
        startsAt: new Date('2026-11-18T16:30:00Z'),
        endsAt: new Date('2026-11-18T18:00:00Z'),
      },
    });

    const res = await query();
    expect(res.status).toBe(200);
    const { eligible, ineligible } = res.body.data;
    expect(eligible.map((o: { teacher: { id: number } }) => o.teacher.id)).toEqual([
      speaks.id,
      plain.id,
    ]);
    expect(eligible[0]).toMatchObject({
      rank: 1,
      eligible: true,
      reasons: [],
      languageMatch: true,
      teacherLocal: { date: '2026-11-18', time: '19:00' },
      conversion: { trials: 0, converted: 0, rate: null },
      trialsThisWeek: 0,
      recentTrials: 0,
    });
    expect(eligible[1]).toMatchObject({ rank: 2, languageMatch: false });
    const reasons = Object.fromEntries(
      ineligible.map((o: { teacher: { id: number }; reasons: string[] }) => [
        o.teacher.id,
        o.reasons,
      ]),
    );
    expect(reasons).toEqual({
      [noTrials.id]: ['not_accepting'],
      [noCourse.id]: ['course'],
      [male.id]: ['gender'],
      [adults.id]: ['audience'],
      [capped.id]: ['weekly_limit'],
      [onLeave.id]: ['on_leave'],
      [busy.id]: ['busy'],
    });
    // Bookable with a reason first, the busy one last.
    expect(ineligible.at(-1).teacher.id).toBe(busy.id);
    expect(ineligible.at(-1).overridable).toBe(false);
    expect(ineligible[0].overridable).toBe(true);
    expect(res.body.meta).toMatchObject({
      startsAt: '2026-11-18T17:00:00.000Z',
      familyZone: 'Europe/London',
      adult: false,
      teacherGenderPref: 'female',
    });
    // Staff-only list: no contact details of the teachers either.
    expect(JSON.stringify(res.body)).not.toMatch(/@|\+20/);
  });

  it('returns the booking’s own check per teacher: one-off classes on that date, warnings', async () => {
    const free = await teacher('Amina', { gender: 'female' });
    const taken = await teacher('Basma', { gender: 'female' });
    // Amina works Monday mornings only: Wednesday 19:00 Cairo is outside her hours.
    await ctx.prisma.teacherWorkHour.create({
      data: {
        teacherId: free.id,
        weekday: 1,
        localStartTime: '08:00',
        localEndTime: '10:00',
        timezone: 'Africa/Cairo',
      },
    });
    // A one-off trial of another lead's child with Basma at the same instant.
    const other = await crmLead(ctx, { status: 'contacted' });
    const acc = await client.post(`/leads/${other.id}/account`, {
      parentName: 'Abu Zaid',
      email: 'abu.zaid@example.com',
      timezone: 'Europe/London',
      children: [{ name: 'Zaid', age: 9, gender: 'male', courseId }],
    });
    const booked = await client.post(`/leads/${other.id}/trials`, {
      studentId: acc.body.data.students[0].id,
      courseId,
      teacherId: taken.id,
      localDate: '2026-11-18',
      localTime: '17:00',
      acknowledgeWarnings: ['outside_work_hours'],
    });
    expect(booked.status).toBe(201);
    const res = await query();
    const byId = (id: number) =>
      [...res.body.data.eligible, ...res.body.data.ineligible].find(
        (o: { teacher: { id: number } }) => o.teacher.id === id,
      );
    expect(byId(free.id).check.conflicts).toEqual([]);
    expect(byId(free.id).check.warnings.map((w: { code: string }) => w.code)).toContain(
      'outside_work_hours',
    );
    expect(byId(taken.id).reasons).toEqual(['busy']);
    expect(byId(taken.id).check.conflicts.map((c: { code: string }) => c.code)).toContain(
      'teacher_overlap',
    );
  });

  it('counts the conversion rate and the recent trials of each teacher', async () => {
    const t = await teacher('Amina', { gender: 'female' });
    expect((await book(t.id)).status).toBe(201);
    const res = await query();
    // Its own booked trial does not block a rebooking at the same time.
    expect(res.body.data.eligible[0]).toMatchObject({
      teacher: { id: t.id },
      conversion: { trials: 1, converted: 0, rate: 0 },
      recentTrials: 1,
    });
  });

  it('answers 422 without the family account, 404 for an unknown lead', async () => {
    const other = await crmLead(ctx, { status: 'contacted' });
    const noFamily = await client.get(
      `/leads/${other.id}/trial-teachers?studentId=${studentId}&courseId=${courseId}&localDate=2026-11-18&localTime=17:00`,
    );
    expect(noFamily.status).toBe(422);
    expect(noFamily.body.code).toBe('no_family');
    const missing = await client.get(
      `/leads/999999/trial-teachers?studentId=${studentId}&courseId=${courseId}&localDate=2026-11-18&localTime=17:00`,
    );
    expect(missing.status).toBe(404);
    const bad = await client.get(`/leads/${leadId}/trial-teachers?studentId=${studentId}`);
    expect(bad.status).toBe(422);
  });

  it('is staff only: 401 signed out, 403 for a teacher', async () => {
    const anon = await new Client(ctx.app).init();
    expect((await anon.get(`/leads/${leadId}/trial-teachers`)).status).toBe(401);
    const { client: t } = await signedIn(ctx, 'teacher');
    const res = await t.get(
      `/leads/${leadId}/trial-teachers?studentId=${studentId}&courseId=${courseId}&localDate=2026-11-18&localTime=17:00`,
    );
    expect(res.status).toBe(403);
  });
});

describe('T2 booking an ineligible teacher', () => {
  it('needs a reason, then books and records the override', async () => {
    const male = await teacher('Fadi', { gender: 'male' });
    const refused = await book(male.id);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('teacher_not_eligible');
    expect(refused.body.data.reasons).toEqual(['gender']);
    expect(refused.body.errors.overrideReason).toBeDefined();
    expect(await ctx.prisma.classSession.count()).toBe(0);

    const ok = await book(male.id, { overrideReason: 'The family agreed by phone' });
    expect(ok.status).toBe(201);
    const activity = await ctx.prisma.leadActivity.findFirstOrThrow({
      where: { leadId, type: 'trial_booked' },
    });
    expect(activity.meta).toMatchObject({
      eligibilityOverride: { reasons: ['gender'], reason: 'The family agreed by phone' },
    });
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'trial_booked', subjectId: leadId },
    });
    expect(audit.after).toMatchObject({ eligibilityOverride: { reasons: ['gender'] } });
  });

  it('keeps a clash a 409, reason or not', async () => {
    const busy = await teacher('Jana', { gender: 'female' });
    await ctx.prisma.teacherBlock.create({
      data: {
        teacherId: busy.id,
        kind: 'one_off',
        startsAt: new Date('2026-11-18T16:30:00Z'),
        endsAt: new Date('2026-11-18T18:00:00Z'),
      },
    });
    const res = await book(busy.id, { overrideReason: 'Please' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('schedule_conflict');
  });

  it('tells the teacher (no family details) and the replaced teacher on a rebooking', async () => {
    const first = await teacher('Amina', { gender: 'female' });
    const second = await teacher('Basma', { gender: 'female' });
    const booked = await book(first.id);
    expect(booked.status).toBe(201);
    const notice = await ctx.prisma.notification.findFirstOrThrow({
      where: { userId: first.userId, kind: 'trial' },
    });
    expect(notice.event).toBe('trial_booked');
    expect(notice.data).toMatchObject({
      sessionId: booked.body.meta.trial.sessionId,
      courseId,
      teacherLocal: '2026-11-18 19:00',
      durationMinutes: 30,
      studentAge: 8,
      studentGender: 'female',
    });
    const text = JSON.stringify(notice.data) + JSON.stringify(ctx.mailer.sent);
    expect(text).not.toMatch(/Maryam|umm\.maryam|7700900123/);

    expect((await book(second.id)).status).toBe(201);
    const events = await ctx.prisma.notification.findMany({
      where: { kind: 'trial' },
      orderBy: { id: 'asc' },
      select: { userId: true, event: true },
    });
    expect(events).toEqual([
      { userId: first.userId, event: 'trial_booked' },
      { userId: second.userId, event: 'trial_booked' },
      { userId: first.userId, event: 'trial_cancelled' },
    ]);
  });
});

describe('T2 teacher trial settings', () => {
  it('saves and shows accepts trials, weekly cap, age group and languages', async () => {
    const t = await teacher('Amina');
    const { client: admin } = await signedIn(ctx, 'admin');
    const res = await admin.patch(`/teachers/${t.id}`, {
      acceptsTrials: false,
      maxTrialsPerWeek: 3,
      audience: 'children',
      languages: ['arabic', 'english', 'arabic'],
    });
    expect(res.status).toBe(200);
    const shown = await admin.get(`/teachers/${t.id}`);
    expect(shown.body.data).toMatchObject({
      acceptsTrials: false,
      maxTrialsPerWeek: 3,
      audience: 'children',
      languages: ['arabic', 'english'],
    });
    const cleared = await admin.patch(`/teachers/${t.id}`, { maxTrialsPerWeek: null });
    expect(cleared.status).toBe(200);
    expect((await admin.get(`/teachers/${t.id}`)).body.data.maxTrialsPerWeek).toBeNull();
    expect((await admin.patch(`/teachers/${t.id}`, { audience: 'teens' })).status).toBe(422);
    expect((await admin.patch(`/teachers/${t.id}`, { languages: ['french'] })).status).toBe(422);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { subjectType: 'teacher', subjectId: t.id, action: 'updated' },
    });
    expect(audit.after).toMatchObject({ acceptsTrials: false, audience: 'children' });
  });
});
