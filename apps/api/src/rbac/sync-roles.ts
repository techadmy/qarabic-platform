import { allPermissions, permissionsFor, ROLES, SYSTEM_ROLES } from '@qarabic/shared';
import type { PrismaClient } from '../generated/prisma/client.js';

/** Only staff presets are editable (docs/29 §1); owner = everything, portal roles follow the matrix. */
export function isEditableKind(kind: string): boolean {
  return kind === 'staff';
}

/**
 * Idempotent; safe on every deploy (port of `RolesAndPermissionsSeeder`).
 * - Creates every `module.action` permission.
 * - Creates the 9 system roles; labels are set once and never overwritten.
 * - `admin` always gets every permission. teacher/parent always follow the matrix.
 * - A staff preset is synced only while `customized_at` is null: once someone edits it, a reseed
 *   never overwrites it. Roles outside the matrix (custom roles) are left untouched.
 */
export async function syncRolesAndPermissions(prisma: PrismaClient): Promise<void> {
  await prisma.permission.createMany({
    data: allPermissions().map((name) => ({ name })),
    skipDuplicates: true,
  });
  const ids = new Map(
    (await prisma.permission.findMany({ select: { id: true, name: true } })).map((p) => [
      p.name,
      p.id,
    ]),
  );

  for (const name of ROLES) {
    const meta = SYSTEM_ROLES[name];
    const role = await prisma.role.upsert({
      where: { name },
      create: { name, labelAr: meta.ar, labelEn: meta.en, kind: meta.kind, isSystem: true },
      update: { kind: meta.kind, isSystem: true },
    });
    if (isEditableKind(role.kind) && role.customizedAt !== null) continue;
    await setRolePermissions(prisma, role.id, permissionsFor(name), ids);
  }
}

export async function setRolePermissions(
  prisma: PrismaClient,
  roleId: number,
  names: readonly string[],
  ids?: Map<string, number>,
): Promise<void> {
  const map =
    ids ??
    new Map(
      (await prisma.permission.findMany({ where: { name: { in: [...names] } } })).map((p) => [
        p.name,
        p.id,
      ]),
    );
  const wanted = names.map((n) => {
    const id = map.get(n);
    if (id === undefined) throw new Error(`Unknown permission ${n}`);
    return id;
  });
  await prisma.$transaction([
    prisma.rolePermission.deleteMany({ where: { roleId, permissionId: { notIn: wanted } } }),
    prisma.rolePermission.createMany({
      data: wanted.map((permissionId) => ({ roleId, permissionId })),
      skipDuplicates: true,
    }),
  ]);
}
