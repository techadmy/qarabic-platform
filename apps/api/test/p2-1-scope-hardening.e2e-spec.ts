import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clock,
  createTestApp,
  m2Enrollment,
  m2Student,
  m2Teacher,
  makeCourse,
  makeFamily,
  resetState,
  signedIn,
  signInAs,
  type TestContext,
} from './helpers.js';
import { crmAt, publicPost, resetCrm, setSetting } from './n5-helpers.js';

/*
| P2-1 (docs/39 ISO-2, ISO-4, ISO-6, ISO-7; ISO-5 is in mobile.e2e-spec): family data in the
| support off-ramp needs families.view; a teacher's reach is their live students; the public form
| confirms once per address a day and takes no raw family id as a referral; staff link a child to a
| ticket only with family access.
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
  resetCrm(ctx);
  crmAt(ctx, '2026-11-16T09:00:00Z');
});

describe('ISO-2 support off-ramp needs families.view', () => {
  it('accounts (support.view, no families.view): 403 on links and on a family render', async () => {
    const family = await makeFamily(ctx);
    const { client: accounts } = await signedIn(ctx, 'accounts');
    expect((await accounts.get(`/support/links?familyId=${family.id}`)).status).toBe(403);
    const { client: monitor } = await signedIn(ctx, 'monitor');
    expect((await monitor.get(`/support/links?familyId=${family.id}`)).status).toBe(200);
  });
});

describe('ISO-4 a former teacher loses the student', () => {
  it('the old teacher gets 404 on a test the new teacher made', async () => {
    clock(ctx).set('2026-11-16T09:00:00Z');
    const student = await m2Student(ctx, 'Europe/London');
    const oldTeacher = await m2Teacher(ctx, 'Africa/Cairo', 'Amina');
    const newTeacher = await m2Teacher(ctx, 'Africa/Cairo', 'Basma');
    await m2Enrollment(ctx, student, oldTeacher, { status: 'ended' });
    await m2Enrollment(ctx, student, newTeacher);
    await ctx.prisma.student.update({
      where: { id: student.id },
      data: { teacherId: newTeacher.id },
    });
    const newUser = await ctx.prisma.user.findUniqueOrThrow({ where: { id: newTeacher.userId } });
    const created = await (
      await signInAs(ctx, newUser)
    ).post('/tests', {
      studentId: student.id,
      track: 'hifz',
      sections: ['makharij'],
      scheduledAt: '2026-11-20T16:00:00Z',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const test = { id: created.body.data.id as number };
    const oldUser = await ctx.prisma.user.findUniqueOrThrow({ where: { id: oldTeacher.userId } });
    expect((await (await signInAs(ctx, oldUser)).get(`/tests/${test.id}`)).status).toBe(404);
    expect((await (await signInAs(ctx, newUser)).get(`/tests/${test.id}`)).status).toBe(200);
  });
});

describe('ISO-6 public intake', () => {
  it('three requests with the same email in a day send one confirmation', async () => {
    await setSetting(ctx, 'crm.trial_form_confirmation', true);
    const courseId = (await makeCourse(ctx)).id;
    const body = {
      parentName: 'Umm Yusuf',
      phone: '+447700900123',
      email: 'target@example.com',
      countryCode: 'GB',
      timezone: 'Europe/London',
      children: [{ name: 'Yusuf', age: 8, gender: 'male', courseId }],
      preferredDays: [6],
      preferredPeriods: ['evening'],
      teacherGenderPref: 'any',
      heardFrom: 'instagram',
    };
    for (let i = 0; i < 3; i++) await publicPost(ctx, '/public/trial-requests', body);
    expect(ctx.mailer.sent.filter((m) => m.kind === 'trial_request_received')).toHaveLength(1);
  });

  it('a raw family id in the old form is not a referral', async () => {
    const family = await makeFamily(ctx);
    await publicPost(ctx, '/api/class-request', {
      Name: 'Umm Yusuf',
      Email: 'ref@example.com',
      Phone: '+1 (555) 000-1111',
      Country: 'CA',
      Gender: 'Female',
      Age: '8',
      Course: 'Quran',
      referral_id: String(family.id),
    });
    const lead = await ctx.prisma.lead.findFirstOrThrow({ where: { email: 'ref@example.com' } });
    expect(lead.referralFamilyId).toBeNull();
  });
});

describe('ISO-7 staff link a child to a ticket only with family access', () => {
  it('accounts cannot attach a student; a monitor can', async () => {
    const family = await makeFamily(ctx);
    const student = await ctx.prisma.student.create({
      data: { familyId: family.id, name: 'Zaid' } as never,
    });
    const body = {
      category: 'classes',
      subjectType: 'student',
      subjectId: student.id,
      familyId: family.id,
      description: 'The family called about the child',
    };
    const { client: accounts } = await signedIn(ctx, 'accounts');
    const refused = await accounts.post('/feedback/tickets', body);
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toHaveProperty('subjectId');
    const { client: monitor } = await signedIn(ctx, 'monitor');
    expect((await monitor.post('/feedback/tickets', body)).status).toBe(201);
  });
});
