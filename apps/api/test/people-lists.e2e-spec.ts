import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  createUser,
  makeCourse,
  makeFamily,
  makeStudent,
  makeTeacher,
  resetState,
  signedIn,
  type TestContext,
} from './helpers.js';

/*
| The list-page standard (docs/15 §5.4.1, D129): instant search, filters, status tabs with counts,
| sort and page pagination, the same on Families, Students, Teachers and Staff.
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

const ids = (res: { body: { data: Array<{ id: number }> } }) => res.body.data.map((r) => r.id);

describe('families list', () => {
  it('pages newest first, with status-tab counts that ignore the status filter', async () => {
    const { client } = await signedIn(ctx, 'csr');
    const a = await makeFamily(ctx, { status: 'regular' });
    const b = await makeFamily(ctx, { status: 'trial' });
    const c = await makeFamily(ctx, { status: 'suspended' });
    await makeFamily(ctx, { status: 'deactivated', archivedAt: new Date() });

    const page1 = await client.get('/families?perPage=2');
    expect(page1.status).toBe(200);
    expect(ids(page1)).toEqual([c.id, b.id]);
    expect(page1.body.meta).toEqual({
      page: 1,
      perPage: 2,
      total: 3,
      lastPage: 2,
      counts: { all: 3, regular: 1, trial: 1, on_leave: 0, suspended: 1, deactivated: 0 },
    });
    expect(ids(await client.get('/families?perPage=2&page=2'))).toEqual([a.id]);

    const trial = await client.get('/families?status=trial');
    expect(ids(trial)).toEqual([b.id]);
    expect(trial.body.meta.total).toBe(1);
    expect(trial.body.meta.counts.all).toBe(3);

    const archived = await client.get('/families?archived=true');
    expect(archived.body.meta.counts).toMatchObject({ all: 1, deactivated: 1 });
  });

  it('sorts by parent name and filters by manager and country', async () => {
    const { client, user: csr } = await signedIn(ctx, 'csr');
    const zed = await makeFamily(ctx, { user: { name: 'Zed' } });
    const amy = await makeFamily(ctx, { user: { name: 'Amy' } });
    await ctx.prisma.family.update({
      where: { id: zed.id },
      data: { managerId: csr.id, countryCode: 'GB' },
    });

    expect(ids(await client.get('/families?sort=parentName'))).toEqual([amy.id, zed.id]);
    expect(ids(await client.get('/families?sort=parentName&order=desc'))).toEqual([zed.id, amy.id]);
    expect(ids(await client.get(`/families?managerId=${csr.id}`))).toEqual([zed.id]);
    expect(ids(await client.get('/families?countryCode=gb'))).toEqual([zed.id]);
    const row = (await client.get(`/families?managerId=${csr.id}`)).body.data[0];
    expect(row.manager).toEqual({ id: csr.id, name: csr.name });
  });

  it('rejects bad query params with 422', async () => {
    const { client } = await signedIn(ctx, 'csr');
    for (const q of ['perPage=101', 'page=0', 'status=gone', 'sort=password', 'countryCode=ZZ']) {
      const res = await client.get(`/families?${q}`);
      expect(res.status, q).toBe(422);
      expect(res.body.code).toBe('validation_failed');
    }
  });
});

describe('students list', () => {
  it('filters by family, teacher, course and status, with counts', async () => {
    const { client } = await signedIn(ctx, 'manager');
    const family = await makeFamily(ctx);
    const teacher = await makeTeacher(ctx);
    const course = await makeCourse(ctx);
    const one = await makeStudent(ctx, family, teacher, { name: 'Aisha' });
    const two = await makeStudent(ctx, family, null, { name: 'Bilal', status: 'inactive' });
    const three = await makeStudent(ctx, await makeFamily(ctx), null, { name: 'Zaid' });
    await ctx.prisma.student.update({
      where: { id: three.id },
      data: { additionalCourseId: course.id },
    });

    expect(ids(await client.get(`/students?familyId=${family.id}&sort=name`))).toEqual([
      one.id,
      two.id,
    ]);
    expect(ids(await client.get(`/students?teacherId=${teacher.id}`))).toEqual([one.id]);
    expect(ids(await client.get(`/students?courseId=${course.id}`))).toEqual([three.id]);
    const inactive = await client.get('/students?status=inactive');
    expect(ids(inactive)).toEqual([two.id]);
    expect(inactive.body.meta.counts).toEqual({ all: 3, active: 2, inactive: 1 });
  });
});

describe('teachers list', () => {
  it('searches by name and filters by course and status', async () => {
    const { client } = await signedIn(ctx, 'monitor');
    const course = await makeCourse(ctx);
    const mahmoud = await makeTeacher(ctx, { firstName: 'Mahmoud', lastName: 'Fathy' });
    const other = await makeTeacher(ctx, { firstName: 'Omar', status: 'inactive' });
    await ctx.prisma.teacherCourse.create({ data: { teacherId: mahmoud.id, courseId: course.id } });

    expect(ids(await client.get('/teachers?q=Mahm'))).toEqual([mahmoud.id]);
    expect(ids(await client.get('/teachers?q=fath'))).toEqual([mahmoud.id]);
    expect(ids(await client.get(`/teachers?courseId=${course.id}`))).toEqual([mahmoud.id]);
    const inactive = await client.get('/teachers?status=inactive');
    expect(ids(inactive)).toEqual([other.id]);
    expect(inactive.body.meta.counts).toEqual({ all: 2, active: 1, inactive: 1 });
    expect(ids(await client.get('/teachers?sort=name'))).toEqual([mahmoud.id, other.id]);
  });
});

describe('staff list', () => {
  it('sorts by name and counts active and inactive', async () => {
    const { client, user: me } = await signedIn(ctx, 'admin');
    const zara = await createUser(ctx, 'monitor', { name: 'Zara' });
    const adam = await createUser(ctx, 'billing', { name: 'Adam', isActive: false });

    const res = await client.get('/staff');
    expect(ids(res)).toEqual([adam.id, me.id, zara.id]);
    expect(res.body.meta.counts).toEqual({ all: 3, active: 2, inactive: 1 });
    expect(ids(await client.get('/staff?status=inactive'))).toEqual([adam.id]);
    expect(ids(await client.get('/staff?role=monitor'))).toEqual([zara.id]);
    expect((await client.get('/staff?role=nope')).status).toBe(422);
  });
});
