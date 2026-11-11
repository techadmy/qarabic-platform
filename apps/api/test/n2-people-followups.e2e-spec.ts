import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SessionGenerator } from '../src/sessions/generator.js';
import {
  clock,
  createTestApp,
  m2Enrollment,
  m2Slot,
  m2Student,
  m2Teacher,
  resetState,
  signedIn,
  signInAs,
  type TestContext,
} from './helpers.js';

/*
| N1 follow-ups made possible by N2 (Laravel PeopleService + Scope): a teacher's current students
| come from live enrollments too (and a past one opens by id), an inactive student's enrollments
| end, a teacher with live enrollments cannot be deactivated, and class rows are scoped (D138).
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
  clock(ctx).set('2026-11-09T08:00:00Z');
});

describe('People × enrollments', () => {
  it('lists a teacher’s students through live enrollments, and opens a past student by id', async () => {
    const teacher = await m2Teacher(ctx);
    const current = await m2Student(ctx);
    const past = await m2Student(ctx);
    const stranger = await m2Student(ctx);
    await m2Enrollment(ctx, current, teacher);
    await m2Enrollment(ctx, past, teacher, { status: 'ended' });
    await m2Enrollment(ctx, stranger, await m2Teacher(ctx));

    const asTeacher = await signInAs(ctx, teacher.user);
    const list = await asTeacher.get('/students');
    expect(list.body.data.map((s: { id: number }) => s.id)).toEqual([current.id]);
    expect((await asTeacher.get(`/students/${past.id}`)).status).toBe(200);
    expect((await asTeacher.get(`/students/${stranger.id}`)).status).toBe(404);
  });

  it('ends an inactive student’s live enrollments and removes their future classes', async () => {
    const teacher = await m2Teacher(ctx);
    const student = await m2Student(ctx);
    const e = await m2Enrollment(ctx, student, teacher, { startsOn: '2026-11-01' });
    await m2Slot(ctx, e, 3, '17:00', { validFrom: '2026-11-01' });
    await ctx.app.get(SessionGenerator).run();
    expect(await ctx.prisma.classSession.count({ where: { deletedAt: null } })).toBe(2);

    const { client } = await signedIn(ctx, 'manager');
    const res = await client.post(`/students/${student.id}/status`, {
      status: 'inactive',
      reason: 'Stopped classes',
    });
    expect(res.status).toBe(200);
    const after = await ctx.prisma.enrollment.findUniqueOrThrow({ where: { id: e.id } });
    expect([after.status, after.endsOn?.toISOString().slice(0, 10)]).toEqual([
      'ended',
      '2026-11-09',
    ]);
    expect(await ctx.prisma.classSession.count({ where: { deletedAt: null } })).toBe(0);
  });

  it('refuses to deactivate a teacher who still has live enrollments', async () => {
    const teacher = await m2Teacher(ctx);
    await m2Enrollment(ctx, await m2Student(ctx), teacher, {
      status: 'paused',
      pausedReason: 'admin',
    });
    const { client } = await signedIn(ctx, 'senior_manager');
    const res = await client.post(`/teachers/${teacher.id}/status`, {
      status: 'inactive',
      reason: 'Left',
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'teacher_has_students',
      data: { activeStudents: 0, liveEnrollments: 1 },
    });
  });
});

describe('class permissions (403 on every N2 write for portal roles)', () => {
  it.each([
    ['POST', '/enrollments'],
    ['POST', '/enrollments/1/pause'],
    ['PATCH', '/schedule-slots/1'],
    ['POST', '/holidays'],
    ['POST', '/sessions'],
    ['PATCH', '/sessions/1'],
    ['POST', '/sessions/generate'],
    ['POST', '/session-requests/1/approve'],
    ['GET', '/schedule/availability'],
    ['GET', '/settings/sessions'],
    ['GET', '/zoom-hosts'],
  ])('a teacher gets 403 on %s %s', async (method, path) => {
    const teacher = await m2Teacher(ctx);
    const client = await signInAs(ctx, teacher.user);
    const res =
      method === 'GET'
        ? await client.get(path)
        : method === 'PATCH'
          ? await client.patch(path, {})
          : await client.post(path, {});
    expect(res.status).toBe(403);
  });

  it.each([
    ['POST', '/sessions/1/transitions'],
    ['GET', '/sessions/1/zoom/start'],
    ['POST', '/enrollments'],
  ])('a parent gets 403 on %s %s', async (method, path) => {
    const { client } = await signedIn(ctx, 'parent');
    const res = method === 'GET' ? await client.get(path) : await client.post(path, {});
    expect(res.status).toBe(403);
  });

  it('never shows a teacher timetable to a parent (404, like Laravel)', async () => {
    const teacher = await m2Teacher(ctx);
    const { client } = await signedIn(ctx, 'parent');
    expect((await client.get(`/teachers/${teacher.id}/timetable`)).status).toBe(404);
  });
});
