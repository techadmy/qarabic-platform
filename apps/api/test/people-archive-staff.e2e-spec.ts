import type { Role } from '@qarabic/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthUser } from '../src/auth/auth.types.js';
import { StaffService } from '../src/people/staff.service.js';
import {
  createTestApp,
  createUser,
  makeFamily,
  makeStudent,
  makeTeacher,
  resetState,
  roleId,
  signedIn,
  signInAs,
  type TestContext,
} from './helpers.js';

/*
| Port of Laravel tests/Feature/People/PeopleArchiveAndStaffTest.php (docs/28 §10): instant search
| on the People lists, "delete" = archive (D128), staff CRUD (D130). The open-invoice guard on
| family archive arrives with billing (N6).
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

describe('instant search', () => {
  it('finds a family by parent phone, family ID or a child name, and hides archived ones', async () => {
    const { client } = await signedIn(ctx, 'csr');
    const family = await makeFamily(ctx, {
      user: { name: 'Amina Khan', phone: '+447700900123' },
    });
    await makeStudent(ctx, family, null, { name: 'Yusuf Zaid' });
    const other = await makeFamily(ctx);

    const search = async (q: string) =>
      ids(await client.get(`/families?q=${encodeURIComponent(q)}`));
    expect(await search('7700 900')).toEqual([family.id]);
    expect(await search(String(other.id))).toContain(other.id);
    expect(await search('Yusuf Z')).toEqual([family.id]);
    expect(await search('amina')).toEqual([family.id]);

    await ctx.prisma.family.update({ where: { id: family.id }, data: { archivedAt: new Date() } });
    expect(await search('amina')).toEqual([]);
    expect(ids(await client.get('/families?archived=1'))).toEqual([family.id]);
  });

  it('finds students by parent name and teachers by phone', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const family = await makeFamily(ctx, { user: { name: 'Huda Saleh' } });
    const student = await makeStudent(ctx, family, null, { name: 'Bilal' });
    const teacher = await makeTeacher(ctx, { user: { phone: '+201001234567' } });

    expect(ids(await client.get('/students?q=Huda'))).toEqual([student.id]);
    expect(ids(await client.get('/teachers?q=1001234'))).toEqual([teacher.id]);
  });
});

describe('archive', () => {
  it('archives a family only once deactivated, with its children, and restores them', async () => {
    const { client, user: actor } = await signedIn(ctx, 'csr');
    const family = await makeFamily(ctx, { status: 'regular' });
    const child = await makeStudent(ctx, family);
    const parent = await signInAs(ctx, family.user);

    const noReason = await client.delete(`/families/${family.id}`, {});
    expect(noReason.status).toBe(422);
    expect(noReason.body.errors).toHaveProperty('reason');
    const notYet = await client.delete(`/families/${family.id}`, { reason: 'Left the academy' });
    expect(notYet.status).toBe(409);
    expect(notYet.body.code).toBe('must_deactivate_first');

    await ctx.prisma.family.update({ where: { id: family.id }, data: { status: 'deactivated' } });
    const res = await client.delete(`/families/${family.id}`, { reason: 'Left the academy' });
    expect(res.status).toBe(200);
    expect(res.body.data.archive).toMatchObject({
      reason: 'Left the academy',
      by: { id: actor.id },
    });

    expect(
      (await ctx.prisma.student.findUniqueOrThrow({ where: { id: child.id } })).archivedAt,
    ).not.toBeNull();
    expect(
      (await ctx.prisma.user.findUniqueOrThrow({ where: { id: family.userId } })).isActive,
    ).toBe(false);
    // The parent's open session is gone too.
    expect((await parent.get('/auth/me')).status).toBe(401);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'archived' } })).toBe(1);

    const restored = await client.post(`/families/${family.id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.data.archive).toBeNull();
    expect(
      (await ctx.prisma.student.findUniqueOrThrow({ where: { id: child.id } })).archivedAt,
    ).toBeNull();
    expect(
      (await ctx.prisma.user.findUniqueOrThrow({ where: { id: family.userId } })).isActive,
    ).toBe(true);
    const again = await client.post(`/families/${family.id}/restore`);
    expect(again.status).toBe(422);
    expect(again.body.code).toBe('not_archived');
  });

  it('archives an inactive student or teacher only', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const student = await makeStudent(ctx, await makeFamily(ctx));
    const teacher = await makeTeacher(ctx);

    expect((await client.delete(`/students/${student.id}`, { reason: 'Duplicate' })).status).toBe(
      409,
    );
    await ctx.prisma.student.update({ where: { id: student.id }, data: { status: 'inactive' } });
    const archived = await client.delete(`/students/${student.id}`, { reason: 'Duplicate' });
    expect(archived.status).toBe(200);
    expect(archived.body.data.archive.reason).toBe('Duplicate');

    expect((await client.delete(`/teachers/${teacher.id}`, { reason: 'Left' })).status).toBe(409);
    await ctx.prisma.teacher.update({ where: { id: teacher.id }, data: { status: 'inactive' } });
    expect((await client.delete(`/teachers/${teacher.id}`, { reason: 'Left' })).status).toBe(200);
    expect(
      (await ctx.prisma.user.findUniqueOrThrow({ where: { id: teacher.userId } })).isActive,
    ).toBe(false);
    const restored = await client.post(`/teachers/${teacher.id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.data.archive).toBeNull();
    expect(
      (await ctx.prisma.user.findUniqueOrThrow({ where: { id: teacher.userId } })).isActive,
    ).toBe(true);
  });
});

describe('staff', () => {
  it('adds, edits, deactivates, archives and restores a staff member', async () => {
    const { client, user: admin } = await signedIn(ctx, 'admin');

    const created = await client.post('/staff', {
      name: 'Salma Monitor',
      email: 'Salma@Example.com',
      phone: '+20 100 555 0101',
      role: 'monitor',
      timezone: 'Africa/Cairo',
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      email: 'salma@example.com',
      phone: '+201005550101',
      role: { name: 'monitor', kind: 'staff' },
      status: { value: 'active' },
    });
    const id = created.body.data.id as number;

    const teacherRole = await client.post('/staff', {
      name: 'X',
      email: 'y@example.com',
      phone: '+201005550102',
      role: 'teacher',
    });
    expect(teacherRole.status).toBe(422);
    expect(teacherRole.body.errors).toHaveProperty('role');

    const edit = await client.patch(`/staff/${id}`, { role: 'csr', name: 'Salma Ali' });
    expect(edit.status).toBe(200);
    expect(edit.body.data).toMatchObject({ role: { name: 'csr' }, name: 'Salma Ali' });

    expect((await client.get('/staff?q=salma')).body.data[0].id).toBe(id);
    expect((await client.get('/staff?role=billing')).body.data).toHaveLength(0);
    // Teachers and parents are not staff.
    await makeTeacher(ctx);
    await makeFamily(ctx);
    const roles = (await client.get('/staff?perPage=100')).body.data.map(
      (s: { role: { name: string } }) => s.role.name,
    );
    expect(roles).not.toContain('teacher');
    expect(roles).not.toContain('parent');

    const notYet = await client.delete(`/staff/${id}`, { reason: 'Left' });
    expect(notYet.status).toBe(409);
    expect(notYet.body.code).toBe('must_deactivate_first');
    expect(
      (await client.post(`/staff/${id}/status`, { status: 'inactive' })).body.errors,
    ).toHaveProperty('reason');
    const deactivated = await client.post(`/staff/${id}/status`, {
      status: 'inactive',
      reason: 'Contract ended',
    });
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.data.status).toMatchObject({
      value: 'inactive',
      reason: 'Contract ended',
      changedBy: { id: admin.id },
    });
    const archived = await client.delete(`/staff/${id}`, { reason: 'Contract ended' });
    expect(archived.status).toBe(200);
    expect(archived.body.data.archive.reason).toBe('Contract ended');
    expect((await client.get('/staff?q=salma')).body.data).toHaveLength(0);
    expect((await client.get('/staff?archived=1')).body.data[0].id).toBe(id);
    const restored = await client.post(`/staff/${id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.data.archive).toBeNull();

    // Never yourself.
    const self = await client.post(`/staff/${admin.id}/status`, {
      status: 'inactive',
      reason: 'Oops',
    });
    expect(self.status).toBe(409);
    expect(self.body.code).toBe('cannot_archive_self');
  });

  it('signs a deactivated staff member out everywhere', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const target = await createUser(ctx, 'monitor');
    const theirs = await signInAs(ctx, target);
    expect((await theirs.get('/auth/me')).status).toBe(200);

    await client.post(`/staff/${target.id}/status`, { status: 'inactive', reason: 'Left us' });
    expect((await theirs.get('/auth/me')).status).toBe(401);
  });

  it('keeps at least one active owner', async () => {
    // Laravel acts as an inactive admin; a session needs an active login here, so the service
    // is called directly with an owner actor that is not counted (inactive).
    const target = await createUser(ctx, 'admin');
    const ghost = await createUser(ctx, 'admin', { isActive: false });
    const staff = ctx.app.get(StaffService);
    const actor: AuthUser = {
      id: ghost.id,
      name: ghost.name,
      email: ghost.email,
      locale: 'ar',
      timezone: 'Africa/Cairo',
      phone: null,
      role: {
        id: await roleId(ctx, 'admin'),
        name: 'admin',
        kind: 'owner',
        labelAr: '',
        labelEn: '',
      },
      permissions: new Set(),
    };

    await expect(
      staff.changeStatus(target.id, { status: 'inactive', reason: 'Left' }, actor),
    ).rejects.toMatchObject({ response: { code: 'last_admin' }, status: 409 });
    await expect(staff.update(target.id, { role: 'manager' }, actor)).rejects.toMatchObject({
      response: { code: 'last_admin' },
    });

    await createUser(ctx, 'admin');
    await staff.changeStatus(target.id, { status: 'inactive', reason: 'Left' }, actor);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: target.id } })).isActive).toBe(
      false,
    );
  });

  const staffRoles: Array<[Role, boolean, boolean]> = [
    ['admin', true, true],
    ['senior_manager', true, false],
    ['manager', false, false],
    ['csr', false, false],
    ['monitor', false, false],
    ['billing', false, false],
    ['accounts', false, false],
    ['teacher', false, false],
    ['parent', false, false],
  ];

  it.each(staffRoles)(
    'lets only users.manage write staff, users.view read them (%s)',
    async (role, canRead, canWrite) => {
      const target = await createUser(ctx, 'billing', { isActive: false });
      const { client } = await signedIn(ctx, role);
      expect((await client.get('/staff')).status).toBe(canRead ? 200 : 403);
      expect((await client.get(`/staff/${target.id}`)).status).toBe(canRead ? 200 : 403);

      const expectWrite = (status: number, ok: number) => expect(status).toBe(canWrite ? ok : 403);
      expectWrite(
        (
          await client.post('/staff', {
            name: 'N',
            email: `${role}@example.com`,
            phone: '+201005550199',
            role: 'csr',
          })
        ).status,
        201,
      );
      expectWrite((await client.patch(`/staff/${target.id}`, { name: 'Renamed' })).status, 200);
      expectWrite((await client.delete(`/staff/${target.id}`, { reason: 'Left' })).status, 200);
    },
  );

  it('protects archive routes like the write routes', async () => {
    const student = await makeStudent(ctx, await makeFamily(ctx), null, { status: 'inactive' });
    const teacher = await makeTeacher(ctx, { status: 'inactive' });
    const { client: monitor } = await signedIn(ctx, 'monitor');
    expect((await monitor.delete(`/students/${student.id}`, { reason: 'x x x' })).status).toBe(403);
    const { client: manager } = await signedIn(ctx, 'manager');
    expect((await manager.delete(`/teachers/${teacher.id}`, { reason: 'x x x' })).status).toBe(403);
  });
});
