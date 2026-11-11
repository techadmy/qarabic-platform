import { allPermissions, permissionsFor, type RoleDto } from '@qarabic/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { syncRolesAndPermissions } from '../src/rbac/sync-roles.js';
import { createTestApp, resetState, signedIn, type TestContext } from './helpers.js';

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

const roleId = async (name: string) =>
  (await ctx.prisma.role.findUniqueOrThrow({ where: { name } })).id;

const permissionsOf = async (name: string) =>
  (
    await ctx.prisma.rolePermission.findMany({
      where: { role: { name } },
      include: { permission: true },
    })
  )
    .map((rp) => rp.permission.name)
    .sort();

describe('GET /roles', () => {
  it('lists the 9 system roles with their permissions', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const res = await client.get('/roles');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(9);
    const data = res.body.data as RoleDto[];
    const monitor = data.find((r) => r.name === 'monitor')!;
    expect(monitor).toMatchObject({
      kind: 'staff',
      isSystem: true,
      editable: true,
      customizedAt: null,
    });
    expect(monitor.permissions).toEqual([...permissionsFor('monitor')].sort());
    const admin = data.find((r) => r.name === 'admin')!;
    expect(admin).toMatchObject({ kind: 'owner', editable: false });
    expect(admin.permissions).toHaveLength(allPermissions().length);
  });

  it('shows one role; 404 for an unknown or malformed id', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const id = await roleId('teacher');
    const res = await client.get(`/roles/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id, name: 'teacher', kind: 'teacher', editable: false });

    for (const bad of ['999999', 'abc', '0', '99999999999']) {
      const r = await client.get(`/roles/${bad}`);
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('not_found');
    }
  });
});

describe('PUT /roles/:id/permissions', () => {
  it('replaces a staff role permissions and sets customized_at; reseeding keeps them', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const id = await roleId('monitor');
    const res = await client.put(`/roles/${id}/permissions`, {
      permissions: ['schedule.view', 'sessions.view', 'schedule.view'],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.permissions).toEqual(['schedule.view', 'sessions.view']);
    expect(res.body.data.customizedAt).not.toBeNull();

    await syncRolesAndPermissions(ctx.prisma);
    expect(await permissionsOf('monitor')).toEqual(['schedule.view', 'sessions.view']);
  });

  it('reseeding restores an unedited preset to the matrix', async () => {
    await ctx.prisma.rolePermission.deleteMany({ where: { role: { name: 'csr' } } });
    await syncRolesAndPermissions(ctx.prisma);
    expect(await permissionsOf('csr')).toEqual([...permissionsFor('csr')].sort());
  });

  it('the owner role is not editable (422)', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const res = await client.put(`/roles/${await roleId('admin')}/permissions`, {
      permissions: [],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('owner_role_locked');
    expect(await permissionsOf('admin')).toHaveLength(allPermissions().length);
  });

  it('portal roles (teacher, parent) are not editable (422)', async () => {
    const { client } = await signedIn(ctx, 'admin');
    for (const name of ['teacher', 'parent']) {
      const res = await client.put(`/roles/${await roleId(name)}/permissions`, { permissions: [] });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('system_role');
    }
  });

  it('rejects unknown permission names (422) and unknown roles (404)', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const bad = await client.put(`/roles/${await roleId('monitor')}/permissions`, {
      permissions: ['roles.view', 'roles.fly'],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('validation_failed');
    expect(bad.body.errors).toHaveProperty(['permissions.1']);

    const missing = await client.put('/roles/999999/permissions', { permissions: [] });
    expect(missing.status).toBe(404);
  });

  it('needs roles.manage (403), and roles.view is not enough', async () => {
    const id = await roleId('monitor');
    // Give billing roles.view only (as the owner would), then try to edit.
    const { client: owner } = await signedIn(ctx, 'admin');
    await owner.put(`/roles/${await roleId('billing')}/permissions`, {
      permissions: ['roles.view'],
    });

    const { client } = await signedIn(ctx, 'billing');
    expect((await client.get('/roles')).status).toBe(200);
    expect((await client.put(`/roles/${id}/permissions`, { permissions: [] })).status).toBe(403);
  });

  it('no privilege escalation: a non-owner cannot edit their own role or grant what they lack', async () => {
    const { client: owner } = await signedIn(ctx, 'admin');
    await owner.put(`/roles/${await roleId('senior_manager')}/permissions`, {
      permissions: ['roles.view', 'roles.manage', 'schedule.view'],
    });
    const { client } = await signedIn(ctx, 'senior_manager');

    const own = await client.put(`/roles/${await roleId('senior_manager')}/permissions`, {
      permissions: ['roles.view', 'roles.manage', 'schedule.view', 'payroll.approve'],
    });
    expect(own.status).toBe(422);
    expect(own.body.code).toBe('cannot_edit_own_role');

    const escalate = await client.put(`/roles/${await roleId('monitor')}/permissions`, {
      permissions: ['schedule.view', 'payroll.approve'],
    });
    expect(escalate.status).toBe(422);
    expect(escalate.body).toMatchObject({
      code: 'permission_not_held',
      errors: { permissions: ['payroll.approve'] },
    });

    // Keeping permissions the role already had is fine, even ones the actor lacks.
    const ok = await client.put(`/roles/${await roleId('monitor')}/permissions`, {
      permissions: ['schedule.view', 'sessions.view'],
    });
    expect(ok.status).toBe(200);
  });
});
