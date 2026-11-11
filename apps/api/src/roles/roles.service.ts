import { HttpStatus, Injectable } from '@nestjs/common';
import type { RoleDto } from '@qarabic/shared';
import { ApiException, notFound } from '../common/errors.js';
import type { AuthUser } from '../auth/auth.types.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isEditableKind, setRolePermissions } from '../rbac/sync-roles.js';

const withPermissions = {
  permissions: { include: { permission: { select: { name: true } } } },
} as const;

type RoleRow = Awaited<ReturnType<RolesService['load']>>;

const rule = (code: string, message: string) =>
  new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, { message, code });

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<RoleDto[]> {
    const rows = await this.prisma.role.findMany({
      include: withPermissions,
      orderBy: { id: 'asc' },
    });
    return rows.map(toDto);
  }

  async find(id: number): Promise<RoleDto> {
    return toDto(await this.load(id));
  }

  /**
   * Replaces a staff role's permissions and marks it customised, so reseeding keeps it (docs/29).
   * No privilege escalation: a non-owner cannot edit their own role or grant what they lack.
   */
  async updatePermissions(id: number, permissions: string[], actor: AuthUser): Promise<RoleDto> {
    const role = await this.load(id);
    if (role.kind === 'owner') {
      throw rule(
        'owner_role_locked',
        'The owner role always has every permission and cannot be edited.',
      );
    }
    if (!isEditableKind(role.kind)) {
      throw rule(
        'system_role',
        'The permissions of portal roles (teacher, parent) cannot be edited.',
      );
    }
    if (actor.role?.kind !== 'owner') {
      if (actor.role?.id === role.id) {
        throw rule('cannot_edit_own_role', 'You cannot edit the permissions of your own role.');
      }
      const current = new Set(role.permissions.map((p) => p.permission.name));
      const missing = permissions.filter((p) => !current.has(p) && !actor.permissions.has(p));
      if (missing.length) {
        throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
          message: 'You cannot grant permissions you do not have.',
          code: 'permission_not_held',
          errors: { permissions: missing },
        });
      }
    }
    await setRolePermissions(this.prisma, role.id, permissions);
    await this.prisma.role.update({ where: { id: role.id }, data: { customizedAt: new Date() } });
    return this.find(role.id);
  }

  private async load(id: number) {
    const role = await this.prisma.role.findUnique({ where: { id }, include: withPermissions });
    if (!role) throw notFound('Role not found.');
    return role;
  }
}

function toDto(role: RoleRow): RoleDto {
  return {
    id: role.id,
    name: role.name,
    labelAr: role.labelAr,
    labelEn: role.labelEn,
    kind: role.kind,
    isSystem: role.isSystem,
    editable: isEditableKind(role.kind),
    customizedAt: role.customizedAt?.toISOString() ?? null,
    permissions: role.permissions.map((p) => p.permission.name).sort(),
  };
}
