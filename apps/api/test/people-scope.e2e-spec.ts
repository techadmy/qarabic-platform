import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  createUser,
  makeCustomRole,
  makeFamily,
  makeStudent,
  makeTeacher,
  resetState,
  signedIn,
  signInAs,
  type TestContext,
} from './helpers.js';

/*
| Row scoping (D138), ported from Laravel tests/Feature/Security/TeacherScopeTest.php, the
| teacher-search case of PeopleReviewFixesTest.php and tests/Feature/M4/ParentPortalTest.php
| (the People parts). A teacher sees only their own students, without the parent's contact or
| billing data; a parent only their own family and children; 404 (never 403) for other rows.
| Past students through ended enrollments arrive with N2.
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
});

async function world() {
  const me = await makeTeacher(ctx);
  const other = await makeTeacher(ctx);
  const family = await makeFamily(ctx, {
    timezone: 'Europe/London',
    user: { name: 'Huda Saleh', phone: '+447700900123' },
  });
  const mine = await makeStudent(ctx, family, me, { name: 'Bilal', email: 'kid@example.com' });
  const otherFamily = await makeFamily(ctx, { timezone: 'America/Toronto' });
  const theirs = await makeStudent(ctx, otherFamily, other, { name: 'Other' });
  return { me, other, family, mine, otherFamily, theirs };
}

describe('teacher privacy (TeacherScopeTest)', () => {
  it.each([
    ['teachers list', '/teachers'],
    ['families list', '/families'],
    ['employees', '/staff'],
    ['people lookups', '/people/lookups'],
    ['roles', '/roles'],
    ['permission catalog', '/roles/catalog'],
  ])('forbids a teacher the staff-wide %s', async (_name, path) => {
    const { me } = await world();
    const client = await signInAs(ctx, me.user);
    expect((await client.get(path)).status).toBe(403);
  });

  it('never opens another teacher or a family record for a teacher', async () => {
    const { me, other, family } = await world();
    const client = await signInAs(ctx, me.user);
    expect((await client.get(`/teachers/${other.id}`)).status).toBe(403);
    expect((await client.get(`/teachers/${me.id}`)).status).toBe(403);
    expect((await client.get(`/families/${family.id}`)).status).toBe(403);
  });

  it('lists only the teacher’s own students, without parent contact or the login email', async () => {
    const { me, mine, family } = await world();
    const client = await signInAs(ctx, me.user);

    const res = await client.get('/students');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta.total).toBe(1);
    const row = res.body.data[0];
    expect(row).toMatchObject({
      id: mine.id,
      family: { id: family.id, timezone: 'Europe/London' },
    });
    expect(row).not.toHaveProperty('email');
    expect(row.family).not.toHaveProperty('parentName');
    const json = JSON.stringify(row);
    expect(json).not.toContain('+447700900123');
    expect(json).not.toContain(family.user.email);
    expect(json).not.toContain('Huda');
  });

  it('does not let a teacher find students by parent contact details', async () => {
    const { me, mine, family } = await world();
    const client = await signInAs(ctx, me.user);

    expect((await client.get('/students?q=Huda')).body.data).toEqual([]);
    expect((await client.get('/students?q=900123')).body.data).toEqual([]);
    expect(
      (await client.get(`/students?q=${encodeURIComponent(family.user.email)}`)).body.data,
    ).toEqual([]);
    expect((await client.get('/students?q=kid@example')).body.data).toEqual([]);
    expect(
      (await client.get('/students?q=Bil')).body.data.map((s: { id: number }) => s.id),
    ).toEqual([mine.id]);
  });

  it('opens own students but 404s on another teacher’s student', async () => {
    const { me, mine, theirs } = await world();
    const client = await signInAs(ctx, me.user);

    const own = await client.get(`/students/${mine.id}`);
    expect(own.status).toBe(200);
    expect(own.body.data).not.toHaveProperty('email');
    expect(own.body.data.family).not.toHaveProperty('parentName');
    expect(own.body.data.teacher).toEqual({ id: me.id, name: `Teacher ${me.lastName}` });
    expect(own.body.data.statusHistory).toEqual([]);
    expect((await client.get(`/students/${theirs.id}`)).status).toBe(404);
  });

  it('never shows a teacher archived students, even when asked', async () => {
    const { me, mine } = await world();
    await ctx.prisma.student.update({
      where: { id: mine.id },
      data: { status: 'inactive', archivedAt: new Date() },
    });
    const client = await signInAs(ctx, me.user);
    expect((await client.get('/students?archived=1')).body.data).toEqual([]);
    expect((await client.get(`/students/${mine.id}`)).status).toBe(404);
  });

  it('never lets sessions.conduct on a staff role stand in for the staff permissions', async () => {
    const { mine } = await world();
    const role = await makeCustomRole(ctx, ['sessions.view', 'sessions.conduct'], 'منفّذ');
    const { client } = await signedIn(ctx, role.name);
    expect((await client.get('/students')).status).toBe(403);
    expect((await client.get(`/students/${mine.id}`)).status).toBe(403);
  });

  it('cannot write students or families even for their own students', async () => {
    const { me, mine } = await world();
    const client = await signInAs(ctx, me.user);
    expect((await client.patch(`/students/${mine.id}`, { name: 'x' })).status).toBe(403);
    expect(
      (await client.post(`/students/${mine.id}/status`, { status: 'inactive', reason: 'xyz' }))
        .status,
    ).toBe(403);
  });

  it('leaves staff unaffected', async () => {
    const { mine, family, other } = await world();
    const { client } = await signedIn(ctx, 'monitor');

    expect((await client.get('/teachers')).body.meta.total).toBe(2);
    expect((await client.get(`/teachers/${other.id}`)).status).toBe(200);
    expect((await client.get('/students')).body.meta.total).toBe(2);
    const student = await client.get(`/students/${mine.id}`);
    expect(student.body.data).toMatchObject({
      email: 'kid@example.com',
      family: { id: family.id, parentName: 'Huda Saleh' },
    });
    expect((await client.get(`/families/${family.id}`)).status).toBe(200);
  });
});

describe('parent portal (ParentPortalTest)', () => {
  it('returns 404 for another family’s student and family records', async () => {
    const { family, mine, otherFamily, theirs } = await world();
    const client = await signInAs(ctx, family.user);

    expect((await client.get(`/students/${theirs.id}`)).status).toBe(404);
    expect((await client.get(`/families/${otherFamily.id}`)).status).toBe(404);

    const child = await client.get(`/students/${mine.id}`);
    expect(child.status).toBe(200);
    expect(child.body.data.name).toBe('Bilal');
    expect((await client.get('/students')).body.data.map((s: { id: number }) => s.id)).toEqual([
      mine.id,
    ]);
    // Asking for the other family by filter returns nothing.
    expect((await client.get(`/students?familyId=${otherFamily.id}`)).body.data).toEqual([]);
  });

  it('limits a parent to their own family, without staff notes', async () => {
    const { family } = await world();
    await ctx.prisma.family.update({
      where: { id: family.id },
      data: { comment: 'Internal: slow payer', statusReason: 'Unpaid' },
    });
    const client = await signInAs(ctx, family.user);

    const list = await client.get('/families');
    expect(list.status).toBe(200);
    expect(list.body.data.map((f: { id: number }) => f.id)).toEqual([family.id]);
    const own = await client.get(`/families/${family.id}`);
    expect(own.status).toBe(200);
    expect(own.body.data).toMatchObject({
      comment: null,
      status: { reason: null },
      statusHistory: [],
    });
  });

  it('cannot write their family or children', async () => {
    const { family, mine } = await world();
    const client = await signInAs(ctx, family.user);
    expect((await client.patch(`/families/${family.id}`, { comment: 'x' })).status).toBe(403);
    expect((await client.patch(`/students/${mine.id}`, { name: 'x' })).status).toBe(403);
    expect((await client.get('/teachers')).status).toBe(403);
    expect((await client.get('/staff')).status).toBe(403);
  });

  it('keeps staff with full access', async () => {
    const { theirs, otherFamily } = await world();
    const csr = await createUser(ctx, 'csr');
    const client = await signInAs(ctx, csr);
    expect((await client.get(`/students/${theirs.id}`)).status).toBe(200);
    expect((await client.get(`/families/${otherFamily.id}`)).status).toBe(200);
  });
});
