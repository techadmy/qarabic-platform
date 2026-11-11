import {
  allPermissions,
  type PermissionCatalog,
  permissionsFor,
  type Role,
  type RoleDto,
  ROLES,
} from '@qarabic/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { syncRolesAndPermissions } from '../src/rbac/sync-roles.js';
import {
  createTestApp,
  createUser,
  makeCustomRole,
  resetState,
  roleId as roleIdOf,
  signedIn,
  type TestContext,
} from './helpers.js';

/*
| Port of Laravel tests/Feature/Roles/EditableRolesTest.php (docs/29, D132): CRUD, the owner role,
| no escalation, role in use, the seeder keeping edited presets, custom roles on staff and /me.
| N0's `PUT /roles/:id/permissions` became `PATCH /roles/:id` (Laravel's contract, 409 refusals).
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

const roleId = (name: string) => roleIdOf(ctx, name);

const permissionsOf = async (name: string) =>
  (
    await ctx.prisma.rolePermission.findMany({
      where: { role: { name } },
      include: { permission: true },
    })
  )
    .map((rp) => rp.permission.name)
    .sort();

const sorted = (list: readonly string[]) => [...list].sort();

describe('CRUD', () => {
  it('lists the system roles with labels, kinds and user counts, owner first', async () => {
    const { client } = await signedIn(ctx, 'admin');
    await createUser(ctx, 'monitor');

    const res = await client.get('/roles');
    expect(res.status).toBe(200);
    const roles = res.body.data as RoleDto[];
    expect(roles.map((r) => r.name).slice(0, 9)).toEqual([...ROLES]);
    const admin = roles.find((r) => r.name === 'admin')!;
    expect(admin).toMatchObject({
      labelAr: 'المالك (مدير النظام)',
      labelEn: 'Owner (super admin)',
      kind: 'owner',
      isSystem: true,
      editable: true,
      permissionsEditable: false,
      usersCount: 1,
    });
    expect(admin.permissions).toHaveLength(allPermissions().length);
    const monitor = roles.find((r) => r.name === 'monitor')!;
    expect(monitor).toMatchObject({
      labelAr: 'مشرف متابعة',
      kind: 'staff',
      permissionsEditable: true,
      usersCount: 1,
      customizedAt: null,
    });
    expect(monitor.permissions).toEqual(sorted(permissionsFor('monitor')));
    const teacher = roles.find((r) => r.name === 'teacher')!;
    expect(teacher).toMatchObject({ kind: 'teacher', permissionsEditable: false });
    expect(roles.find((r) => r.name === 'parent')!.kind).toBe('parent');
  });

  it('serves a catalog covering every permission with Arabic and English labels and hints', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const res = await client.get('/roles/catalog');
    expect(res.status).toBe(200);
    const catalog = res.body.data as PermissionCatalog;
    const names = catalog.flatMap((m) => m.actions.map((a) => a.permission)).sort();
    expect(names).toEqual(sorted(allPermissions()));
    for (const module of catalog) {
      for (const label of [
        module.labelAr,
        module.labelEn,
        module.groupLabelAr,
        module.groupLabelEn,
      ]) {
        expect(label).toBeTruthy();
      }
      for (const action of module.actions) {
        expect(action.hintAr).toBeTruthy();
        expect(action.hintEn).toBeTruthy();
      }
    }
    expect(catalog[0]).toMatchObject({
      module: 'leads',
      labelAr: 'العملاء المحتملون',
      group: 'people',
      groupLabelAr: 'الأشخاص',
    });
    expect(catalog[0]!.actions[0]).toEqual({
      key: 'view',
      permission: 'leads.view',
      labelAr: 'عرض',
      labelEn: 'View',
      hintAr: 'عرض العملاء المحتملين وطلبات التجربة.',
      hintEn: 'See leads and trial requests.',
    });
  });

  it('creates, shows, edits and deletes a custom role', async () => {
    const { client } = await signedIn(ctx, 'admin');

    const res = await client.post('/roles', {
      labelAr: ' مشرف ',
      labelEn: 'Supervisor',
      description: 'Classes and tests',
      permissions: ['tests.view', 'sessions.view', 'sessions.manage'],
    });
    expect(res.status).toBe(201);
    const id = res.body.data.id as number;
    expect(res.body.data).toMatchObject({
      name: `custom_${id}`,
      kind: 'staff',
      isSystem: false,
      labelAr: 'مشرف',
      usersCount: 0,
      permissions: ['sessions.manage', 'sessions.view', 'tests.view'],
    });
    expect(res.body.data.customizedAt).not.toBeNull();
    expect((await client.get(`/roles/${id}`)).body.data.labelEn).toBe('Supervisor');

    // Same Arabic name twice is refused; unknown permissions too; permissions or copyFrom needed.
    const dup = await client.post('/roles', { labelAr: 'مشرف', permissions: [] });
    expect(dup.status).toBe(422);
    expect(dup.body.errors).toHaveProperty('labelAr');
    const unknown = await client.post('/roles', { labelAr: 'آخر', permissions: ['sessions.fly'] });
    expect(unknown.body.errors).toHaveProperty(['permissions.0']);
    expect((await client.post('/roles', { labelAr: 'آخر' })).body.errors).toHaveProperty(
      'permissions',
    );

    const edit = await client.patch(`/roles/${id}`, {
      labelAr: 'مشرف الحصص',
      permissions: ['tests.view', 'tests.manage'],
    });
    expect(edit.status).toBe(200);
    expect(edit.body.data).toMatchObject({
      labelAr: 'مشرف الحصص',
      permissions: ['tests.manage', 'tests.view'],
    });

    // Duplicate an existing role.
    const copy = await client.post('/roles', {
      labelAr: 'نسخة من المشرف',
      copyFrom: await roleId('monitor'),
    });
    expect(copy.status).toBe(201);
    expect(copy.body.data.permissions).toEqual(sorted(permissionsFor('monitor')));

    const deleted = await client.delete(`/roles/${id}`);
    expect(deleted.status).toBe(204);
    expect((await client.get(`/roles/${id}`)).status).toBe(404);
    expect((await client.patch('/roles/999999', { labelAr: 'x' })).status).toBe(404);
    for (const bad of ['abc', '0', '99999999999']) {
      expect((await client.get(`/roles/${bad}`)).status).toBe(404);
    }
  });

  it('writes role_created, role_updated (permissions before and after) and role_deleted to the audit log', async () => {
    const { client, user: admin } = await signedIn(ctx, 'admin');
    const id = (await client.post('/roles', { labelAr: 'مشرف', permissions: ['tests.view'] })).body
      .data.id as number;
    await client.patch(`/roles/${id}`, { permissions: ['tests.view', 'sessions.view'] });
    await client.delete(`/roles/${id}`);

    const rows = await ctx.prisma.auditLog.findMany({
      where: { subjectType: 'role', subjectId: id },
      orderBy: { id: 'asc' },
    });
    expect(rows.map((r) => r.action)).toEqual(['role_created', 'role_updated', 'role_deleted']);
    expect(new Set(rows.map((r) => r.actorId))).toEqual(new Set([admin.id]));
    expect((rows[0]!.after as { permissions: string[] }).permissions).toEqual(['tests.view']);
    expect((rows[1]!.before as { permissions: string[] }).permissions).toEqual(['tests.view']);
    expect((rows[1]!.after as { permissions: string[] }).permissions).toEqual([
      'sessions.view',
      'tests.view',
    ]);
    expect((rows[2]!.before as { labelAr: string }).labelAr).toBe('مشرف');
  });

  it('stamps customized_at only when the permissions really change; reseeding keeps them', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const monitor = await roleId('monitor');

    const same = await client.patch(`/roles/${monitor}`, {
      labelAr: 'مشرف',
      permissions: permissionsFor('monitor'),
    });
    expect(same.status).toBe(200);
    expect(same.body.data).toMatchObject({ customizedAt: null, labelAr: 'مشرف' });

    const changed = await client.patch(`/roles/${monitor}`, { permissions: ['sessions.view'] });
    expect(changed.body.data.permissions).toEqual(['sessions.view']);
    expect(changed.body.data.customizedAt).not.toBeNull();

    await syncRolesAndPermissions(ctx.prisma);
    expect(await permissionsOf('monitor')).toEqual(['sessions.view']);
  });

  const guards: Array<[Role, boolean, boolean]> = [
    ['admin', true, true],
    ['senior_manager', false, false],
    ['manager', false, false],
    ['monitor', false, false],
    ['csr', false, false],
    ['billing', false, false],
    ['accounts', false, false],
    ['teacher', false, false],
    ['parent', false, false],
  ];

  it.each(guards)(
    'guards the roles API: roles.view to read, roles.manage to write (%s)',
    async (role, read, write) => {
      const { client } = await signedIn(ctx, role);
      const target = await makeCustomRole(ctx, ['tests.view'], 'هدف');

      expect((await client.get('/roles')).status).toBe(read ? 200 : 403);
      expect((await client.get('/roles/catalog')).status).toBe(read ? 200 : 403);
      expect((await client.get(`/roles/${target.id}`)).status).toBe(read ? 200 : 403);
      expect((await client.post('/roles', { labelAr: 'جديد', permissions: [] })).status).toBe(
        write ? 201 : 403,
      );
      expect((await client.patch(`/roles/${target.id}`, { labelAr: 'معدّل' })).status).toBe(
        write ? 200 : 403,
      );
      expect((await client.delete(`/roles/${target.id}`)).status).toBe(write ? 204 : 403);
    },
  );

  it('roles.view is not enough to write', async () => {
    const reader = await makeCustomRole(ctx, ['roles.view']);
    const { client } = await signedIn(ctx, reader.name);
    expect((await client.get('/roles')).status).toBe(200);
    expect(
      (await client.patch(`/roles/${await roleId('monitor')}`, { permissions: [] })).status,
    ).toBe(403);
  });
});

describe('custom role access', () => {
  it('lets a custom role reach exactly the modules its permissions allow, and /me shows it', async () => {
    const role = await makeCustomRole(ctx, ['families.view', 'staff.view']);
    const { client } = await signedIn(ctx, role.name);

    expect((await client.get('/families')).status).toBe(200);
    expect((await client.get('/teachers')).status).toBe(200);
    expect((await client.get('/staff')).status).toBe(403);
    expect((await client.get('/roles')).status).toBe(403);
    expect((await client.post('/families', {})).status).toBe(403);

    const me = await client.get('/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      role: { name: role.name, labelAr: 'مشرف', kind: 'staff' },
      roles: [role.name],
    });
    expect(me.body.permissions).toEqual(['families.view', 'staff.view']);
  });

  it('returns the role labels and kind on /me', async () => {
    const { client } = await signedIn(ctx, 'admin');
    expect((await client.get('/me')).body.role).toEqual({
      name: 'admin',
      labelAr: 'المالك (مدير النظام)',
      labelEn: 'Owner (super admin)',
      kind: 'owner',
    });
    const { client: teacher } = await signedIn(ctx, 'teacher');
    expect((await teacher.get('/auth/me')).body.role).toEqual({
      name: 'teacher',
      labelAr: 'معلم',
      labelEn: 'Teacher',
      kind: 'teacher',
    });
  });
});

describe('owner role and escalation', () => {
  it('keeps the owner role immutable except for its labels, and never deletable', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const admin = await roleId('admin');

    const perms = await client.patch(`/roles/${admin}`, { permissions: ['sessions.view'] });
    expect(perms.status).toBe(409);
    expect(perms.body.code).toBe('owner_role_locked');
    const label = await client.patch(`/roles/${admin}`, { labelAr: 'المالك' });
    expect(label.status).toBe(200);
    expect(label.body.data.labelAr).toBe('المالك');
    const del = await client.delete(`/roles/${admin}`);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('system_role');

    // Portal roles: view-only permissions; system roles cannot be deleted.
    for (const name of ['teacher', 'parent']) {
      const res = await client.patch(`/roles/${await roleId(name)}`, {
        permissions: ['sessions.view'],
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('system_role');
    }
    const billing = await client.delete(`/roles/${await roleId('billing')}`);
    expect(billing.status).toBe(409);
    expect(billing.body.code).toBe('system_role');
    expect(await permissionsOf('admin')).toHaveLength(allPermissions().length);
  });

  it('blocks privilege escalation by a non-owner who manages roles', async () => {
    const managerRole = await makeCustomRole(
      ctx,
      ['roles.view', 'roles.manage', 'sessions.view', 'tests.view', 'users.view', 'users.manage'],
      'مدير الأدوار',
    );
    const { client } = await signedIn(ctx, managerRole.name);
    const other = await makeCustomRole(ctx, ['sessions.view', 'payroll.approve'], 'آخر');

    // Grant beyond own permissions.
    const beyond = await client.post('/roles', {
      labelAr: 'رواتب',
      permissions: ['sessions.view', 'payroll.approve'],
    });
    expect(beyond.status).toBe(409);
    expect(beyond.body).toMatchObject({
      code: 'permission_not_held',
      data: { permissions: ['payroll.approve'] },
    });
    const copyOwner = await client.post('/roles', {
      labelAr: 'نسخة المالك',
      copyFrom: await roleId('admin'),
    });
    expect(copyOwner.status).toBe(409);
    expect(copyOwner.body.code).toBe('permission_not_held');
    expect(
      (await client.post('/roles', { labelAr: 'حصص', permissions: ['sessions.view'] })).status,
    ).toBe(201);

    // Editing a role that already holds a permission the actor lacks: keeping it is fine, adding is not.
    expect(
      (
        await client.patch(`/roles/${other.id}`, {
          permissions: ['sessions.view', 'payroll.approve', 'tests.view'],
        })
      ).status,
    ).toBe(200);
    const add = await client.patch(`/roles/${other.id}`, {
      permissions: ['sessions.view', 'payroll.approve', 'wallet.manage'],
    });
    expect(add.status).toBe(409);
    expect(add.body.code).toBe('permission_not_held');

    // Own role and the owner role are off limits.
    for (const body of [{ permissions: ['roles.view'] }, { labelAr: 'أنا' }]) {
      const own = await client.patch(`/roles/${managerRole.id}`, body);
      expect(own.status).toBe(409);
      expect(own.body.code).toBe('cannot_edit_own_role');
    }
    const delOwn = await client.delete(`/roles/${managerRole.id}`);
    expect(delOwn.body.code).toBe('cannot_edit_own_role');
    const ownerRole = await client.patch(`/roles/${await roleId('admin')}`, {
      labelAr: 'أنا المالك',
    });
    expect(ownerRole.status).toBe(409);
    expect(ownerRole.body.code).toBe('owner_role_locked');

    const list = (await client.get('/roles')).body.data as RoleDto[];
    expect(list.find((r) => r.name === 'admin')!.editable).toBe(false);
    expect(list.find((r) => r.name === managerRole.name)!.editable).toBe(false);
    expect(list.find((r) => r.name === other.name)!.permissionsEditable).toBe(true);

    // Assigning roles: never the owner role, never a role with more than the actor holds.
    const staff = { name: 'N', phone: '+201005550188' };
    const asOwner = await client.post('/staff', {
      ...staff,
      email: 'a@example.com',
      role: 'admin',
    });
    expect(asOwner.status).toBe(403);
    expect(asOwner.body.code).toBe('owner_role_locked');
    const tooMuch = await client.post('/staff', {
      ...staff,
      email: 'b@example.com',
      role: 'senior_manager',
    });
    expect(tooMuch.status).toBe(403);
    expect(tooMuch.body.code).toBe('permission_not_held');
    const target = await createUser(ctx, 'monitor');
    const promote = await client.patch(`/staff/${target.id}`, { role: 'admin' });
    expect(promote.status).toBe(403);
    expect(promote.body.code).toBe('owner_role_locked');
    const narrow = await makeCustomRole(ctx, ['sessions.view'], 'ضيق');
    const ok = await client.patch(`/staff/${target.id}`, { role: narrow.name });
    expect(ok.status).toBe(200);
    expect(ok.body.data.role.name).toBe(narrow.name);

    // No takeover of a login that holds more than the actor: its email stays out of reach.
    const higher = await createUser(ctx, 'monitor');
    const takeover = await client.patch(`/staff/${higher.id}`, { email: 'mine@example.com' });
    expect(takeover.status).toBe(403);
    expect(takeover.body.code).toBe('permission_not_held');
    expect((await client.patch(`/staff/${higher.id}`, { name: 'Renamed' })).status).toBe(200);

    // The owner's own account is out of reach too (role, status, contact details).
    const owner = await createUser(ctx, 'admin');
    for (const res of [
      await client.patch(`/staff/${owner.id}`, { role: narrow.name }),
      await client.patch(`/staff/${owner.id}`, { email: 'takeover@example.com' }),
      await client.post(`/staff/${owner.id}/status`, { status: 'inactive', reason: 'Not allowed' }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('owner_role_locked');
    }
  });

  it('lets only an owner assign the owner role', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const res = await client.post('/staff', {
      name: 'Co-owner',
      email: 'co@example.com',
      phone: '+201005550177',
      role: 'admin',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.role).toMatchObject({ name: 'admin', kind: 'owner' });
  });

  it('refuses a change of one’s own role', async () => {
    const { client, user } = await signedIn(ctx, 'admin');
    const res = await client.patch(`/staff/${user.id}`, { role: 'manager' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('cannot_change_own_role');
  });
});

describe('role in use', () => {
  it('refuses to delete a role in use, archived holders included', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const role = await makeCustomRole(ctx, ['sessions.view']);
    const holder = await createUser(ctx, role.name, { isActive: false });
    await ctx.prisma.user.update({ where: { id: holder.id }, data: { archivedAt: new Date() } });

    expect((await client.get(`/roles/${role.id}`)).body.data.usersCount).toBe(1);
    const res = await client.delete(`/roles/${role.id}`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'role_in_use', data: { usersCount: 1 } });

    await ctx.prisma.user.update({
      where: { id: holder.id },
      data: { roleId: await roleId('monitor') },
    });
    expect((await client.delete(`/roles/${role.id}`)).status).toBe(204);
  });
});

describe('seeder', () => {
  it('re-syncs unedited presets on deploy but never an edited one, and always gives the owner everything', async () => {
    const managerId = await roleId('manager');
    const sessionsView = await ctx.prisma.permission.findUniqueOrThrow({
      where: { name: 'sessions.view' },
    });
    await ctx.prisma.rolePermission.delete({
      where: { roleId_permissionId: { roleId: managerId, permissionId: sessionsView.id } },
    });
    const monitorId = await roleId('monitor');
    await ctx.prisma.rolePermission.deleteMany({
      where: { roleId: monitorId, permissionId: { not: sessionsView.id } },
    });
    await ctx.prisma.role.update({
      where: { id: monitorId },
      data: { customizedAt: new Date(), labelAr: 'مشرف' },
    });
    const adminId = await roleId('admin');
    await ctx.prisma.rolePermission.deleteMany({ where: { roleId: adminId } });
    await ctx.prisma.role.update({
      where: { id: adminId },
      data: { customizedAt: new Date(), labelAr: 'المالك' },
    });

    await syncRolesAndPermissions(ctx.prisma);
    await syncRolesAndPermissions(ctx.prisma);

    expect(await permissionsOf('manager')).toEqual(sorted(permissionsFor('manager')));
    expect(await permissionsOf('monitor')).toEqual(['sessions.view']);
    expect(await permissionsOf('admin')).toHaveLength(allPermissions().length);
    const admin = await ctx.prisma.role.findUniqueOrThrow({ where: { id: adminId } });
    expect(admin).toMatchObject({ labelAr: 'المالك', kind: 'owner', isSystem: true });
    expect((await ctx.prisma.role.findUniqueOrThrow({ where: { id: monitorId } })).labelAr).toBe(
      'مشرف',
    );
  });

  it('re-syncs the teacher role on deploy even when it was stamped as customized (D138)', async () => {
    const teacherId = await roleId('teacher');
    const extra = await ctx.prisma.permission.findMany({
      where: { name: { in: ['staff.view', 'families.view'] } },
    });
    await ctx.prisma.rolePermission.createMany({
      data: extra.map((p) => ({ roleId: teacherId, permissionId: p.id })),
    });
    await ctx.prisma.role.update({ where: { id: teacherId }, data: { customizedAt: new Date() } });

    await syncRolesAndPermissions(ctx.prisma);
    const names = await permissionsOf('teacher');
    expect(names).not.toContain('staff.view');
    expect(names).not.toContain('families.view');
    expect(names).toContain('sessions.conduct');
  });
});

describe('staff with a custom role', () => {
  it('creates staff with a custom role, lists it, and offers it as a family manager when it can manage families', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const role = await makeCustomRole(ctx, ['families.view', 'families.manage'], 'منسق العائلات');

    const res = await client.post('/staff', {
      name: 'Custom Staff',
      email: 'custom@example.com',
      phone: '+201005550166',
      role: role.name,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.role).toMatchObject({ name: role.name, labelAr: 'منسق العائلات' });
    const id = res.body.data.id as number;

    expect((await client.get(`/staff?role=${role.name}`)).body.data[0].id).toBe(id);
    const managers = async () =>
      ((await client.get('/people/lookups')).body.data.managers as Array<{ id: number }>).map(
        (m) => m.id,
      );
    expect(await managers()).toContain(id);

    // A role without families.manage is not a manager; teachers stay out of staff.
    const plain = await createUser(
      ctx,
      (await makeCustomRole(ctx, ['sessions.view'], 'عادي')).name,
    );
    expect(await managers()).not.toContain(plain.id);
    const teacher = await client.post('/staff', {
      name: 'T',
      email: 't@example.com',
      phone: '+201005550155',
      role: 'teacher',
    });
    expect(teacher.status).toBe(422);
    expect(teacher.body.errors).toHaveProperty('role');
  });
});
