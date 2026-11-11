import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RATE_LIMIT_KEY } from '../src/auth/decorators.js';
import {
  FamiliesController,
  StaffController,
  StudentsController,
  TeachersController,
} from '../src/people/people.controllers.js';
import {
  createTestApp,
  createUser,
  makeFamily,
  makeStudent,
  makeTeacher,
  resetState,
  signedIn,
  type TestContext,
} from './helpers.js';

/*
| Port of Laravel tests/Feature/People/PeopleReviewFixesTest.php (S0 review of #39): LIKE wildcards,
| archived records read-only, valid family / teacher on a student, restore order, staff writes.
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

describe('S0 review fixes', () => {
  it.each(['%', '_', '%%', '\\'])(
    'treats %s as literal text in every instant search',
    async (wildcard) => {
      const { client } = await signedIn(ctx, 'admin');
      const family = await makeFamily(ctx);
      await makeStudent(ctx, family);
      await makeTeacher(ctx);
      await createUser(ctx, 'csr');
      const q = encodeURIComponent(wildcard);

      for (const path of ['/families', '/students', '/teachers', '/staff']) {
        const res = await client.get(`${path}?q=${q}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
      }
    },
  );

  it('keeps archived records read-only until restored', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const now = new Date();
    const family = await makeFamily(ctx, { status: 'deactivated', archivedAt: now });
    const student = await makeStudent(ctx, await makeFamily(ctx), null, {
      status: 'inactive',
      archivedAt: now,
    });
    const teacher = await makeTeacher(ctx, { status: 'inactive', archivedAt: now });
    const staff = await createUser(ctx, 'csr', { isActive: false });
    await ctx.prisma.user.update({ where: { id: staff.id }, data: { archivedAt: now } });

    const archived = async (res: Promise<{ status: number; body: { code: string } }>) => {
      const r = await res;
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('archived');
    };
    await archived(client.patch(`/families/${family.id}`, { comment: 'x' }));
    await archived(client.post(`/families/${family.id}/status`, { status: 'regular' }));
    await archived(client.patch(`/students/${student.id}`, { name: 'x' }));
    await archived(client.post(`/students/${student.id}/status`, { status: 'active' }));
    await archived(client.patch(`/teachers/${teacher.id}`, { experience: 'x' }));
    await archived(client.post(`/teachers/${teacher.id}/status`, { status: 'active' }));
    await archived(client.patch(`/staff/${staff.id}`, { name: 'x' }));
    await archived(client.post(`/staff/${staff.id}/status`, { status: 'active' }));
    await archived(client.delete(`/students/${student.id}`, { reason: 'again' }));
  });

  it('does not put a student in an archived or deactivated family, or with an archived or inactive teacher', async () => {
    const { client } = await signedIn(ctx, 'csr');
    const archivedFamily = await makeFamily(ctx, { archivedAt: new Date() });
    const deactivatedFamily = await makeFamily(ctx, { status: 'deactivated' });
    const inactiveTeacher = await makeTeacher(ctx, { status: 'inactive' });
    const archivedTeacher = await makeTeacher(ctx, { archivedAt: new Date() });

    for (const familyId of [archivedFamily.id, deactivatedFamily.id]) {
      const res = await client.post('/students', { familyId, name: 'A' });
      expect(res.status).toBe(422);
      expect(res.body.errors).toHaveProperty('familyId');
    }
    const family = await makeFamily(ctx);
    for (const teacherId of [inactiveTeacher.id, archivedTeacher.id]) {
      const res = await client.post('/students', { familyId: family.id, name: 'A', teacherId });
      expect(res.status).toBe(422);
      expect(res.body.errors).toHaveProperty('teacherId');
    }

    // Editing a child who already has that (now inactive) teacher, in a now deactivated family, still works.
    const student = await makeStudent(ctx, deactivatedFamily, inactiveTeacher);
    const res = await client.patch(`/students/${student.id}`, {
      familyId: deactivatedFamily.id,
      teacherId: inactiveTeacher.id,
      age: 9,
    });
    expect(res.status).toBe(200);
  });

  it('restores a student only after its family', async () => {
    const { client } = await signedIn(ctx, 'csr');
    const family = await makeFamily(ctx, { status: 'deactivated' });
    const student = await makeStudent(ctx, family, null, { status: 'inactive' });
    expect((await client.delete(`/families/${family.id}`, { reason: 'Left' })).status).toBe(200);

    const early = await client.post(`/students/${student.id}/restore`);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('family_archived');
    expect((await client.post(`/families/${family.id}/restore`)).status).toBe(200);
    expect(
      (await ctx.prisma.student.findUniqueOrThrow({ where: { id: student.id } })).archivedAt,
    ).toBeNull();
  });

  it('keeps a child archived on its own when the family is restored', async () => {
    const { client } = await signedIn(ctx, 'csr');
    const family = await makeFamily(ctx, { status: 'deactivated' });
    const earlier = await makeStudent(ctx, family, null, { status: 'inactive' });
    expect((await client.delete(`/students/${earlier.id}`, { reason: 'Duplicate' })).status).toBe(
      200,
    );
    const sibling = await makeStudent(ctx, family);
    await client.delete(`/families/${family.id}`, { reason: 'Left' });
    await client.post(`/families/${family.id}/restore`);

    expect(
      (await ctx.prisma.student.findUniqueOrThrow({ where: { id: sibling.id } })).archivedAt,
    ).toBeNull();
    expect(
      (await ctx.prisma.student.findUniqueOrThrow({ where: { id: earlier.id } })).archivedAt,
    ).not.toBeNull();
  });

  it('throttles every instant-search list (120 a minute)', () => {
    for (const controller of [
      FamiliesController,
      StudentsController,
      TeachersController,
      StaffController,
    ]) {
      expect(
        Reflect.getMetadata(
          RATE_LIMIT_KEY,
          Object.getOwnPropertyDescriptor(controller.prototype, 'list')!.value,
        ),
      ).toBe('search');
    }
  });

  it.each(['manager', 'csr'] as const)('refuses staff creation to %s', async (role) => {
    const { client } = await signedIn(ctx, role);
    const res = await client.post('/staff', {
      name: 'N',
      email: 'n@example.com',
      phone: '+201005550111',
      role: 'csr',
    });
    expect(res.status).toBe(403);
  });
});
