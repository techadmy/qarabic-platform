import { Injectable } from '@nestjs/common';
import {
  allPermissions,
  type createRoleSchema,
  GROUPS,
  MODULES,
  type Module as PermissionModule,
  PERMISSION_ACTION_LABELS,
  PERMISSION_GROUP_LABELS,
  PERMISSION_HINTS,
  PERMISSION_MODULE_LABELS,
  type Permission,
  type PermissionCatalog,
  type RoleDto,
  ROLES,
  type updateRoleSchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { conflict, notFound, validationError } from '../common/errors.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isEditableKind, setRolePermissions } from '../rbac/sync-roles.js';

const include = {
  permissions: { include: { permission: { select: { name: true } } } },
  _count: { select: { users: true } },
} satisfies Prisma.RoleInclude;

type RoleRow = Prisma.RoleGetPayload<{ include: typeof include }>;
type Tx = Prisma.TransactionClient;

const isOwnerActor = (actor: AuthUser) => actor.role?.kind === 'owner';

/** The role's permission names (the owner role always has every one, docs/29 §1). */
function permissionsOf(role: Pick<RoleRow, 'kind' | 'permissions'>): string[] {
  if (role.kind === 'owner') return [...allPermissions()].sort();
  return role.permissions.map((p) => p.permission.name).sort();
}

function snapshot(role: RoleRow): Record<string, unknown> {
  return {
    name: role.name,
    labelAr: role.labelAr,
    labelEn: role.labelEn,
    description: role.description,
    permissions: permissionsOf(role),
  };
}

/**
 * Editable roles (docs/29 §1–§2, D132), port of Laravel `RoleService`. Every write is one
 * transaction and is audited. No privilege escalation: a non-owner can only grant what they hold,
 * never touches their own role, and never touches the owner role.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Owner first, then the system presets in matrix order, then custom roles by label. */
  async list(viewer: AuthUser): Promise<RoleDto[]> {
    const rows = await this.prisma.role.findMany({ include });
    const rank = (r: RoleRow) => (r.isSystem ? ROLES.indexOf(r.name as never) : 1_000);
    rows.sort(
      (a, b) =>
        Number(!a.isSystem) - Number(!b.isSystem) ||
        rank(a) - rank(b) ||
        a.labelAr.localeCompare(b.labelAr, 'ar'),
    );
    return rows.map((r) => toDto(r, viewer));
  }

  async find(id: number, viewer: AuthUser): Promise<RoleDto> {
    return toDto(await this.load(this.prisma, id), viewer);
  }

  /** The permission catalog for the matrix, grouped like the sidebar, labelled in both languages. */
  catalog(): PermissionCatalog {
    return Object.entries(GROUPS).flatMap(([group, modules]) =>
      modules.map((module: PermissionModule) => ({
        module,
        labelAr: PERMISSION_MODULE_LABELS[module].ar,
        labelEn: PERMISSION_MODULE_LABELS[module].en,
        group,
        groupLabelAr: PERMISSION_GROUP_LABELS[group]!.ar,
        groupLabelEn: PERMISSION_GROUP_LABELS[group]!.en,
        actions: MODULES[module].map((action: string) => {
          const permission = `${module}.${action}` as Permission;
          return {
            key: action,
            permission,
            labelAr: PERMISSION_ACTION_LABELS[action]!.ar,
            labelEn: PERMISSION_ACTION_LABELS[action]!.en,
            hintAr: PERMISSION_HINTS[permission].ar,
            hintEn: PERMISSION_HINTS[permission].en,
          };
        }),
      })),
    );
  }

  /** A custom staff role named `custom_<id>`; `copyFrom` duplicates another role's permissions. */
  async create(input: z.output<typeof createRoleSchema>, actor: AuthUser): Promise<number> {
    return this.unique(() =>
      this.prisma.$transaction(async (tx) => {
        let permissions = input.permissions;
        if (permissions === undefined && input.copyFrom) {
          const source = await tx.role.findUnique({ where: { id: input.copyFrom }, include });
          if (!source) {
            throw validationError({ copyFrom: ['The selected role to copy is invalid.'] });
          }
          permissions = permissionsOf(source);
        }
        permissions ??= [];
        this.assertCanGrant(actor, permissions, []);
        await this.assertLabelsFree(tx, input.labelAr, input.labelEn ?? null);

        const created = await tx.role.create({
          data: {
            name: `custom_tmp_${crypto.randomUUID()}`,
            labelAr: input.labelAr,
            labelEn: input.labelEn ?? null,
            description: input.description ?? null,
            kind: 'staff',
            isSystem: false,
            customizedAt: new Date(),
          },
        });
        await tx.role.update({ where: { id: created.id }, data: { name: `custom_${created.id}` } });
        await setRolePermissions(tx, created.id, permissions);
        const row = await this.load(tx, created.id);
        await this.audit.record(
          {
            actorId: actor.id,
            action: 'role_created',
            subjectType: 'role',
            subjectId: created.id,
            after: snapshot(row),
          },
          tx,
        );
        return created.id;
      }),
    );
  }

  /**
   * Labels and description of any role the actor may touch; permissions of staff roles only.
   * `customized_at` is stamped only when the permissions really change, so a reseed keeps them.
   */
  async update(
    id: number,
    input: z.output<typeof updateRoleSchema>,
    actor: AuthUser,
  ): Promise<void> {
    await this.unique(() =>
      this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "roles" WHERE id = ${id} FOR UPDATE`;
        const role = await this.load(tx, id);
        this.assertCanTouch(role, actor);
        const before = snapshot(role);

        let customizedAt: Date | undefined;
        if (input.permissions !== undefined) {
          const current = permissionsOf(role);
          const next = input.permissions;
          if (JSON.stringify(next) !== JSON.stringify(current)) {
            if (role.kind === 'owner') throw conflict('owner_role_locked');
            if (!isEditableKind(role.kind)) throw conflict('system_role');
            this.assertCanGrant(actor, next, current);
            await setRolePermissions(tx, id, next);
            customizedAt = new Date();
          }
        }
        if (input.labelAr !== undefined || input.labelEn !== undefined) {
          await this.assertLabelsFree(tx, input.labelAr, input.labelEn, id);
        }
        await tx.role.update({
          where: { id },
          data: {
            ...(input.labelAr !== undefined ? { labelAr: input.labelAr } : {}),
            ...(input.labelEn !== undefined ? { labelEn: input.labelEn } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(customizedAt ? { customizedAt } : {}),
          },
        });
        const after = snapshot(await this.load(tx, id));
        if (JSON.stringify(after) !== JSON.stringify(before)) {
          await this.audit.record(
            {
              actorId: actor.id,
              action: 'role_updated',
              subjectType: 'role',
              subjectId: id,
              before,
              after,
            },
            tx,
          );
        }
      }),
    );
  }

  /** Only custom roles nobody holds (archived users included) can be deleted. */
  async delete(id: number, actor: AuthUser): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "roles" WHERE id = ${id} FOR UPDATE`;
      const role = await this.load(tx, id);
      this.assertCanTouch(role, actor);
      if (role.isSystem) throw conflict('system_role');
      const users = await tx.user.count({ where: { roleId: id } });
      if (users > 0) throw conflict('role_in_use', { usersCount: users });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'role_deleted',
          subjectType: 'role',
          subjectId: id,
          before: snapshot(role),
        },
        tx,
      );
      await tx.role.delete({ where: { id } });
    });
  }

  private async load(db: Tx | PrismaService, id: number): Promise<RoleRow> {
    const role = await db.role.findUnique({ where: { id }, include });
    if (!role) throw notFound('Role not found.');
    return role;
  }

  /** Owner role: owners only. Own role: owners only (an owner may relabel the owner role). */
  private assertCanTouch(role: RoleRow, actor: AuthUser): void {
    if (isOwnerActor(actor)) return;
    if (role.kind === 'owner') throw conflict('owner_role_locked');
    if (actor.role?.id === role.id) throw conflict('cannot_edit_own_role');
  }

  /**
   * A non-owner may only add permissions they hold themself; permissions the role already has
   * may stay (or be removed) even if the actor lacks them.
   */
  private assertCanGrant(actor: AuthUser, next: string[], current: string[]): void {
    if (isOwnerActor(actor)) return;
    const had = new Set(current);
    const missing = next.filter((p) => !had.has(p) && !actor.permissions.has(p));
    if (missing.length) throw conflict('permission_not_held', { permissions: missing });
  }

  /** Arabic and English names are unique, case-insensitively. */
  private async assertLabelsFree(
    tx: Tx,
    labelAr: string | undefined,
    labelEn: string | null | undefined,
    ignoreId?: number,
  ): Promise<void> {
    const not = ignoreId ? { id: { not: ignoreId } } : {};
    const errors: Record<string, string[]> = {};
    if (labelAr) {
      const taken = await tx.role.findFirst({
        where: { labelAr: { equals: labelAr, mode: 'insensitive' }, ...not },
      });
      if (taken) errors.labelAr = ['This name is already used by another role.'];
    }
    if (labelEn) {
      const taken = await tx.role.findFirst({
        where: { labelEn: { equals: labelEn, mode: 'insensitive' }, ...not },
      });
      if (taken) errors.labelEn = ['This name is already used by another role.'];
    }
    if (Object.keys(errors).length) throw validationError(errors);
  }

  /** A unique-label race lost at write time reads like the validation error. */
  private async unique<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw validationError({ labelAr: ['This name is already used by another role.'] });
      }
      throw error;
    }
  }
}

/** `editable` and `permissionsEditable` are relative to the viewer (Laravel `RoleResource`). */
function toDto(role: RoleRow, viewer: AuthUser): RoleDto {
  const editable =
    viewer.permissions.has('roles.manage') &&
    (isOwnerActor(viewer) || (role.kind !== 'owner' && viewer.role?.id !== role.id));
  return {
    id: role.id,
    name: role.name,
    labelAr: role.labelAr,
    labelEn: role.labelEn,
    description: role.description,
    kind: role.kind,
    isSystem: role.isSystem,
    editable,
    permissionsEditable: editable && isEditableKind(role.kind),
    usersCount: role._count.users,
    customizedAt: role.customizedAt?.toISOString() ?? null,
    permissions: permissionsOf(role),
  };
}
