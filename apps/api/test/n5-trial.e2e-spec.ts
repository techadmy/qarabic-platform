import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Crypto } from '../src/common/crypto.js';
import {
  type Client,
  clock,
  createTestApp,
  createUser,
  m2Enrollment,
  m2Session,
  m2Student,
  m2Teacher,
  makeCourse,
  makeCustomRole,
  makeFamily,
  makeStudent,
  resetState,
  signedIn,
  signInAs,
  type TestContext,
  zoomDriver,
} from './helpers.js';
import { crmAt, crmLead, resetCrm } from './n5-helpers.js';

/*
| Port of Laravel tests/Feature/Crm/{TrialConversionTest, TrialMeetingLinkTest} (docs/26 §6,
| D109–D111): account → trial class → outcome → regular family. The family lives in London, the
| teacher in Cairo; times are typed in the family's zone.
*/

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

let csr: { id: number };
let client: Client;
let leadId: number;
let courseId: number;
let teacherId: number;

beforeEach(async () => {
  await resetState(ctx);
  resetCrm(ctx);
  crmAt(ctx, '2026-11-16T09:00:00Z');
  ({ user: csr, client } = await signedIn(ctx, 'csr'));
  leadId = (
    await crmLead(ctx, {
      status: 'contacted',
      assignedToId: csr.id,
      countryCode: 'GB',
      email: 'umm.maryam@example.com',
    })
  ).id;
  courseId = (await makeCourse(ctx)).id;
  teacherId = (await m2Teacher(ctx, 'Africa/Cairo')).id;
});

const account = (extra: Record<string, unknown> = {}) =>
  client.post(`/leads/${leadId}/account`, {
    parentName: 'Umm Maryam',
    email: 'Umm.Maryam@example.com',
    phone: '+447700900123',
    timezone: 'Europe/London',
    countryCode: 'GB',
    children: [{ name: 'Maryam', age: 8, gender: 'female', courseId }],
    ...extra,
  });

const trial = (
  studentId: number,
  date: string,
  time: string,
  extra: Record<string, unknown> = {},
) =>
  client.post(`/leads/${leadId}/trials`, {
    studentId,
    courseId,
    teacherId,
    localDate: date,
    localTime: time,
    ...extra,
  });

const lastStudentId = async () =>
  (await ctx.prisma.student.findFirstOrThrow({ orderBy: { id: 'desc' } })).id;

describe('TrialConversion (Zoom configured)', () => {
  beforeEach(() => {
    zoomDriver(ctx, 'fake');
  });

  it('creates the trial family, parent and children from the lead', async () => {
    const res = await account();
    expect(res.status).toBe(201);
    expect(res.body.data.family).toMatchObject({ status: 'trial', timezone: 'Europe/London' });
    expect(res.body.data.students[0].name).toBe('Maryam');
    expect(res.body.data.allowedActions).toContain('book_trial');
    expect(res.body.data.allowedActions).not.toContain('create_account');

    const lead = await ctx.prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    const family = await ctx.prisma.family.findUniqueOrThrow({
      where: { id: lead.familyId! },
      include: { user: { include: { role: true } }, students: true },
    });
    expect(family.status).toBe('trial');
    expect(family.managerId).toBe(csr.id);
    expect(family.user.email).toBe('umm.maryam@example.com');
    expect(family.user.phone).toBe('+447700900123');
    expect(family.user.role?.name).toBe('parent');
    expect(family.students.map((s) => s.regularCourseId)).toEqual([courseId]);
    // Booking the trial moves the lead, not the account.
    expect(lead.status).toBe('contacted');

    const again = await account();
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('already_has_family');
    // No password mail on account creation.
    expect(ctx.mailer.sent).toHaveLength(0);
  });

  it('refuses an email that already has an account and offers that family', async () => {
    const family = await makeFamily(ctx, { user: { email: 'umm.maryam@example.com' } });
    const res = await account();
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('email_taken');
    expect(res.body.data.familyId).toBe(family.id);

    // Linking keeps the regular family as it is and adds the sibling.
    const linked = await account({ familyId: family.id });
    expect(linked.status).toBe(201);
    expect(linked.body.data.family).toMatchObject({ id: family.id, status: 'regular' });
    expect(await ctx.prisma.student.count({ where: { familyId: family.id } })).toBe(1);
  });

  it('validates the account form', async () => {
    const res = await client.post(`/leads/${leadId}/account`, {
      children: [{ name: 'M', courseId: 999999 }],
    });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.errors)).toEqual(
      expect.arrayContaining(['parentName', 'email', 'timezone', 'children.0.name']),
    );
    const course = await account({ children: [{ name: 'Maryam', courseId: 999999 }] });
    expect(course.status).toBe(422);
    expect(course.body.errors['children.0.courseId']).toBeDefined();
  });

  it('books a trial in the family zone and shows both local times', async () => {
    expect((await account()).status).toBe(201);
    const studentId = await lastStudentId();

    const res = await trial(studentId, '2026-11-18', '17:00');
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('trial_scheduled');
    expect(res.body.meta.trial).toMatchObject({
      startsAt: '2026-11-18T17:00:00Z', // London = UTC in November
      familyLocal: '2026-11-18T17:00',
      teacherLocal: '2026-11-18T19:00', // Cairo = UTC+2
      familyZone: 'Europe/London',
      teacherZone: 'Africa/Cairo',
      stage: 'scheduled',
      durationMinutes: 30,
    });
    expect(res.body.data.trials[0].stage).toBe('scheduled');
    expect(res.body.data.trial.sessionId).toBe(res.body.meta.trial.sessionId);

    const session = await ctx.prisma.classSession.findUniqueOrThrow({
      where: { id: res.body.meta.trial.sessionId },
      include: { enrollment: true },
    });
    expect(session.kind).toBe('trial');
    expect(session.enrollment?.kind).toBe('trial');
    expect(session.enrollment?.meetingMode).toBe('zoom');
    expect(session.teacherId).toBe(teacherId);
    const family = await ctx.prisma.family.findFirstOrThrow({
      where: { students: { some: { id: studentId } } },
    });
    expect(family.trialDate?.toISOString().slice(0, 10)).toBe('2026-11-18');
    const booked = await ctx.prisma.leadActivity.findFirstOrThrow({
      where: { type: 'trial_booked' },
    });
    expect(booked.meta).toMatchObject({
      familyLocal: '2026-11-18 17:00 Europe/London',
      teacherLocal: '2026-11-18 19:00 Africa/Cairo',
      rebooked: false,
    });
  });

  it('converts summer wall time to UTC across both DST calendars', async () => {
    crmAt(ctx, '2027-03-30T09:00:00Z');
    expect((await account()).status).toBe(201);
    // 5 Apr 2027: London is on BST (UTC+1); Egypt's DST only starts on 30 Apr, so Cairo is UTC+2.
    const res = await trial(await lastStudentId(), '2027-04-05', '17:00');
    expect(res.status).toBe(201);
    expect(res.body.meta.trial).toMatchObject({
      startsAt: '2027-04-05T16:00:00Z',
      teacherLocal: '2027-04-05T18:00',
    });
  });

  it('rejects a local time skipped by the clock change and times in the past', async () => {
    crmAt(ctx, '2027-03-20T09:00:00Z');
    expect((await account()).status).toBe(201);
    const studentId = await lastStudentId();
    const gap = await trial(studentId, '2027-03-28', '01:30');
    expect(gap.status).toBe(422);
    expect(gap.body.errors.localTime).toBeDefined();
    const past = await trial(studentId, '2027-03-19', '17:00');
    expect(past.status).toBe(422);
    expect(past.body.errors.localTime).toBeDefined();
  });

  it('needs the account first and only books children of the lead family', async () => {
    const other = await makeStudent(ctx, await makeFamily(ctx));
    const noFamily = await trial(other.id, '2026-11-18', '17:00');
    expect(noFamily.status).toBe(422);
    expect(noFamily.body.code).toBe('no_family');

    expect((await account()).status).toBe(201);
    expect((await trial(other.id, '2026-11-18', '17:00')).status).toBe(404);
  });

  it('refuses a trial that clashes with the teacher and keeps nothing', async () => {
    expect((await account()).status).toBe(201);
    const studentId = await lastStudentId();
    const busy = await m2Enrollment(ctx, await m2Student(ctx), { id: teacherId });
    await m2Session(ctx, busy, '2026-11-18T17:10:00Z');

    const res = await trial(studentId, '2026-11-18', '17:00');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('schedule_conflict');
    expect(await ctx.prisma.enrollment.count({ where: { studentId } })).toBe(0);
    expect((await ctx.prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe(
      'contacted',
    );
  });

  it('refuses a trial in a course the student is already enrolled in', async () => {
    expect((await account()).status).toBe(201);
    const studentId = await lastStudentId();
    const student = await ctx.prisma.student.findUniqueOrThrow({
      where: { id: studentId },
      include: { family: true },
    });
    await m2Enrollment(ctx, student, { id: teacherId }, { courseId });
    const res = await trial(studentId, '2026-11-18', '17:00');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('already_enrolled');
  });

  it('rebooks by moving the earlier trial out', async () => {
    expect((await account()).status).toBe(201);
    const studentId = await lastStudentId();
    const first = (await trial(studentId, '2026-11-18', '17:00')).body.meta.trial
      .sessionId as number;
    const res = await trial(studentId, '2026-11-19', '16:00');
    expect(res.status).toBe(201);
    const second = res.body.meta.trial.sessionId as number;

    const old = await ctx.prisma.classSession.findUniqueOrThrow({ where: { id: first } });
    expect(old.stage).toBe('moved_out');
    expect(old.stageReason).toBe('rescheduled'); // unpaid, unbilled (docs/04)
    expect((await ctx.prisma.classSession.findUniqueOrThrow({ where: { id: second } })).stage).toBe(
      'scheduled',
    );
    expect(await ctx.prisma.enrollment.count({ where: { studentId } })).toBe(1);
    expect(
      await ctx.prisma.leadActivity.count({ where: { leadId, type: 'trial_cancelled' } }),
    ).toBe(1);
  });

  it.each([
    ['interested', 'trial_done', null],
    ['no_show', 'contacted', null],
    ['not_interested', 'lost', 'not_interested'],
  ])('maps the trial outcome %s to the next stage', async (outcome, status, reason) => {
    expect((await account()).status).toBe(201);
    expect((await trial(await lastStudentId(), '2026-11-18', '17:00')).status).toBe(201);
    const res = await client.post(`/leads/${leadId}/trial-outcome`, {
      outcome,
      note: 'Called after class',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status, trialOutcome: outcome, lostReason: reason });
  });

  it('refuses an outcome before a trial is booked', async () => {
    const res = await client.post(`/leads/${leadId}/trial-outcome`, { outcome: 'interested' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_transition');
  });

  it('converts to a regular family with a weekly schedule in the family zone', async () => {
    expect((await account()).status).toBe(201);
    const studentId = await lastStudentId();
    expect((await trial(studentId, '2026-11-18', '17:00')).status).toBe(201);
    expect(
      (await client.post(`/leads/${leadId}/trial-outcome`, { outcome: 'interested' })).status,
    ).toBe(200);

    const res = await client.post(`/leads/${leadId}/convert`, {
      students: [
        {
          studentId,
          courseId,
          teacherId,
          startsOn: '2026-11-23',
          sessionMinutes: 30,
          slots: [
            { weekday: 1, localStartTime: '17:00' },
            { weekday: 3, localStartTime: '17:00' },
          ],
        },
      ],
      sendWelcome: true,
      acknowledgeWarnings: ['dst_shift'],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.status).toBe('converted');
    expect(res.body.data.convertedBy.id).toBe(csr.id);

    const trialEnrollment = await ctx.prisma.enrollment.findFirstOrThrow({
      where: { studentId, kind: 'trial' },
    });
    const regular = await ctx.prisma.enrollment.findUniqueOrThrow({
      where: { id: res.body.meta.enrollmentIds[0] },
      include: { slots: { orderBy: { weekday: 'asc' } } },
    });
    const family = await ctx.prisma.family.findFirstOrThrow({
      where: { students: { some: { id: studentId } } },
      include: { user: true },
    });
    expect(trialEnrollment.status).toBe('ended');
    expect(trialEnrollment.endsOn?.toISOString().slice(0, 10)).toBe('2026-11-22');
    expect(regular).toMatchObject({ kind: 'regular', status: 'active', timezone: 'Europe/London' });
    expect(regular.slots.map((s) => [s.weekday, s.timezone])).toEqual([
      [1, 'Europe/London'],
      [3, 'Europe/London'],
    ]);
    expect(family.status).toBe('regular');
    expect(family.startDate?.toISOString().slice(0, 10)).toBe('2026-11-16');
    expect(family.managerId).toBe(csr.id);
    const lead = await ctx.prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.convertedAt?.toISOString()).toBe('2026-11-16T09:00:00.000Z');
    // The past trial class keeps its kind (D110).
    expect(await ctx.prisma.classSession.count({ where: { studentId, kind: 'trial' } })).toBe(1);
    // The generator made the regular classes.
    expect(
      await ctx.prisma.classSession.count({ where: { enrollmentId: regular.id, kind: 'regular' } }),
    ).toBeGreaterThan(0);

    // The welcome mail is a set-password link (D111).
    const mail = ctx.mailer.sent.find((m) => m.kind === 'password_reset');
    expect(mail?.to).toBe(family.user.email);
    expect(mail?.text).toContain('/reset-password?token=');
    expect((await client.post(`/leads/${leadId}/status`, { status: 'reopen' })).status).toBe(422);
  });

  it('rolls the whole conversion back on a clash', async () => {
    expect((await account()).status).toBe(201);
    const studentId = await lastStudentId();
    expect((await trial(studentId, '2026-11-18', '17:00')).status).toBe(201);
    const busy = await m2Enrollment(ctx, await m2Student(ctx), { id: teacherId });
    await m2Session(ctx, busy, '2026-11-23T17:00:00Z');

    const res = await client.post(`/leads/${leadId}/convert`, {
      students: [
        {
          studentId,
          courseId,
          teacherId,
          startsOn: '2026-11-23',
          slots: [{ weekday: 1, localStartTime: '17:00' }],
        },
      ],
      sendWelcome: true,
      acknowledgeWarnings: ['dst_shift'],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('schedule_conflict');

    const family = await ctx.prisma.family.findFirstOrThrow({
      where: { students: { some: { id: studentId } } },
    });
    expect(family.status).toBe('trial');
    expect((await ctx.prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe(
      'trial_scheduled',
    );
    const enrollments = await ctx.prisma.enrollment.findMany({ where: { studentId } });
    expect(enrollments.map((e) => [e.kind, e.status])).toEqual([['trial', 'active']]);
    expect(ctx.mailer.sent).toHaveLength(0);
  });

  it('asks to acknowledge scheduling warnings and sends no welcome mail unless asked (D140)', async () => {
    expect((await account()).status).toBe(201);
    const studentId = await lastStudentId();
    const payload = {
      students: [
        {
          studentId,
          courseId,
          teacherId,
          startsOn: '2026-11-23',
          slots: [{ weekday: 8, localStartTime: '17:00' }],
        },
      ],
    };
    const bad = await client.post(`/leads/${leadId}/convert`, payload);
    expect(bad.status).toBe(422);
    expect(bad.body.errors['students.0.slots.0.weekday']).toBeDefined();

    payload.students[0]!.slots[0]!.weekday = 6;
    // London and Cairo change clocks on different dates, so the teacher's local time moves.
    const warn = await client.post(`/leads/${leadId}/convert`, payload);
    expect(warn.status).toBe(422);
    expect(warn.body.code).toBe('warnings_not_acknowledged');

    const ok = await client.post(`/leads/${leadId}/convert`, {
      ...payload,
      acknowledgeWarnings: ['dst_shift'],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('converted');
    expect(ctx.mailer.sent).toHaveLength(0);
  });

  it.each([
    ['lost', { status: 'lost', lostReason: 'price' }],
    ['spam', { status: 'spam' }],
    ['job applicant', { status: 'job_applicant' }],
  ])('cancels the booked trial when the lead is closed: %s', async (_name, payload) => {
    expect((await account()).status).toBe(201);
    const sessionId = (await trial(await lastStudentId(), '2026-11-18', '17:00')).body.meta.trial
      .sessionId as number;
    expect((await client.post(`/leads/${leadId}/status`, payload)).status).toBe(200);
    const session = await ctx.prisma.classSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.stage).toBe('cancelled');
    expect(session.stageReason).toBe('admin');
    expect(
      await ctx.prisma.leadActivity.count({ where: { leadId, type: 'trial_cancelled' } }),
    ).toBe(1);
  });

  it('cancels the booked trial when the outcome is not interested', async () => {
    expect((await account()).status).toBe(201);
    const first = (await trial(await lastStudentId(), '2026-11-18', '17:00')).body.meta.trial
      .sessionId as number;
    expect(
      (await client.post(`/leads/${leadId}/trial-outcome`, { outcome: 'not_interested' })).status,
    ).toBe(200);
    expect((await ctx.prisma.classSession.findUniqueOrThrow({ where: { id: first } })).stage).toBe(
      'cancelled',
    );
  });

  it('refuses a regular start date in the past (academy zone)', async () => {
    expect((await account()).status).toBe(201);
    const res = await client.post(`/leads/${leadId}/convert`, {
      students: [
        {
          studentId: await lastStudentId(),
          courseId,
          teacherId,
          startsOn: '2026-11-15',
          slots: [{ weekday: 1, localStartTime: '17:00' }],
        },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.errors['students.0.startsOn']).toBeDefined();
  });

  it('shows trials and the latest trial on the queue row', async () => {
    expect((await account()).status).toBe(201);
    const id = (await trial(await lastStudentId(), '2026-11-18', '17:00')).body.meta.trial
      .sessionId as number;
    const list = await client.get('/leads');
    expect(list.body.data[0].trial).toEqual({
      sessionId: id,
      startsAt: '2026-11-18T17:00:00Z',
      stage: 'scheduled',
    });
    crmAt(ctx, '2026-11-18T18:00:00Z');
    expect(
      (await client.get('/leads?awaitingOutcome=1')).body.data.map((r: { id: number }) => r.id),
    ).toEqual([leadId]);
    expect((await client.get('/leads/summary?tz=Europe/London')).body.data).toMatchObject({
      trialsToday: 1,
      awaitingOutcome: 1,
    });
  });
});

describe('TrialMeetingLink (no Zoom on the system)', () => {
  let studentId: number;
  const book = (extra: Record<string, unknown> = {}) =>
    trial(studentId, '2026-11-18', '17:00', {
      acknowledgeWarnings: ['outside_work_hours', 'dst_shift'],
      ...extra,
    });

  beforeEach(async () => {
    zoomDriver(ctx, 'none');
    expect((await account({ email: 'trial.link@example.com' })).status).toBe(201);
    studentId = await lastStudentId();
  });

  it('uses the link given with the booking, and the family can join with it', async () => {
    const res = await book({ meetingUrl: 'https://meet.google.com/trial-zaid' });
    expect(res.status).toBe(201);
    const s = await ctx.prisma.classSession.findUniqueOrThrow({
      where: { id: res.body.meta.trial.sessionId },
      include: { enrollment: true },
    });
    expect(s.zoomStatus).toBe('external');
    expect(ctx.app.get(Crypto).tryDecrypt(s.zoomJoinUrl)).toBe(
      'https://meet.google.com/trial-zaid',
    );
    expect(s.enrollment?.meetingMode).toBe('external');

    // 30 min before: the family can join with the link (no 503).
    clock(ctx).set(new Date(s.startsAt.getTime() - 30 * 60_000));
    const lead = await ctx.prisma.lead.findUniqueOrThrow({
      where: { id: leadId },
      include: { family: { include: { user: true } } },
    });
    // The parent login has a random password (set by reset link, D111): give it the test one.
    const known = await createUser(ctx, null);
    await ctx.prisma.user.update({
      where: { id: lead.family!.userId },
      data: { passwordHash: known.passwordHash },
    });
    const parent = await signInAs(ctx, lead.family!.user);
    const join = await parent.get(`/sessions/${s.id}/zoom/join`);
    expect(join.status).toBe(200);
    expect(join.body.data.joinUrl).toBe('https://meet.google.com/trial-zaid');
  });

  it("falls back to the teacher's fixed class link", async () => {
    await m2Enrollment(
      ctx,
      await m2Student(ctx),
      { id: teacherId },
      {
        meetingMode: 'external',
        externalMeetingUrl: 'https://zoom.us/j/teacher-room',
      },
    );
    const res = await book();
    expect(res.status).toBe(201);
    const s = await ctx.prisma.classSession.findUniqueOrThrow({
      where: { id: res.body.meta.trial.sessionId },
    });
    expect(ctx.app.get(Crypto).tryDecrypt(s.zoomJoinUrl)).toBe('https://zoom.us/j/teacher-room');
  });

  it('asks for the link when the teacher has none, and books nothing', async () => {
    const res = await book();
    expect(res.status).toBe(422);
    expect(res.body.errors.meetingUrl).toBeDefined();
    expect(await ctx.prisma.classSession.count({ where: { kind: 'trial' } })).toBe(0);
    expect(await ctx.prisma.enrollment.count({ where: { kind: 'trial' } })).toBe(0);
    const http = await book({ meetingUrl: 'http://not-https.example.test' });
    expect(http.status).toBe(422);
    expect(http.body.errors.meetingUrl).toBeDefined();
  });

  it('carries the trial link into the regular enrollment on conversion', async () => {
    expect((await book({ meetingUrl: 'https://meet.google.com/trial-zaid' })).status).toBe(201);
    const res = await client.post(`/leads/${leadId}/convert`, {
      students: [
        {
          studentId,
          courseId,
          teacherId,
          startsOn: '2026-11-23',
          slots: [{ weekday: 1, localStartTime: '17:00' }],
        },
      ],
      acknowledgeWarnings: ['dst_shift', 'outside_work_hours'],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const regular = await ctx.prisma.enrollment.findUniqueOrThrow({
      where: { id: res.body.meta.enrollmentIds[0] },
    });
    expect(regular.meetingMode).toBe('external');
    expect(ctx.app.get(Crypto).tryDecrypt(regular.externalMeetingUrl)).toBe(
      'https://meet.google.com/trial-zaid',
    );
  });

  it('keeps Zoom trials when Zoom is configured', async () => {
    zoomDriver(ctx, 'fake');
    const res = await book();
    expect(res.status).toBe(201);
    const s = await ctx.prisma.classSession.findUniqueOrThrow({
      where: { id: res.body.meta.trial.sessionId },
      include: { enrollment: true },
    });
    expect(s.enrollment?.meetingMode).toBe('zoom');
  });
});

describe('Trial flow permissions', () => {
  it('lets a manager without families.manage book but not create the account', async () => {
    // csr has families.* and schedule.*; a custom role with leads.manage + schedule.manage only.
    const role = await makeCustomRole(ctx, ['leads.view', 'leads.manage', 'schedule.manage']);
    const { client: limited } = await signedIn(ctx, role.name);
    expect((await limited.post(`/leads/${leadId}/account`, {})).status).toBe(403);
    expect((await limited.post(`/leads/${leadId}/trials`, {})).status).toBe(422);
    expect((await limited.post(`/leads/${leadId}/convert`, {})).status).toBe(403);
    expect(await createUser(ctx, 'csr')).toBeTruthy();
  });
});
