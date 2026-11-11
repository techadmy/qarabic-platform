import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ACTIVE_STATUSES,
  type activeStatusChangeSchema,
  type createStaffSchema,
  type Paginated,
  type StaffDto,
  type staffListQuerySchema,
  type updateStaffSchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import { AuditService, diff } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { conflict, notFound, rule } from '../common/errors.js';
import { pageArgs, pageMeta, statusCounts } from '../common/pagination.js';
import { contains, phoneDigits, searchId } from '../common/search.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccountsService } from './accounts.service.js';
import {
  archiveInfo,
  assertChanged,
  assertEmailFree,
  assertNotArchived,
  byUser,
  invalid,
  isOwner,
  iso,
  lockRow,
  recordStatusChange,
  rethrowEmailTaken,
  statusStamp,
  type Tx,
} from './people.common.js';

/** Staff = users whose role is of kind owner or staff, custom roles included (docs/29). */
const STAFF_KINDS = { kind: { in: ['owner', 'staff'] } } satisfies Prisma.RoleWhereInput;

const include = {
  role: { select: { id: true, name: true, labelAr: true, labelEn: true, kind: true } },
  statusChangedBy: byUser,
  archivedBy: byUser,
} satisfies Prisma.UserInclude;

type Row = Prisma.UserGetPayload<{ include: typeof include }>;

function snapshot(row: Row): Record<string, unknown> {
  return {
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role?.name ?? null,
    timezone: row.timezone,
  };
}

/**
 * Staff (الموظفون, docs/28 §10, D130): list, add (random password), edit (role included), status
 * with a reason, archive / restore. `users.view` reads, `users.manage` writes. Nobody deactivates or
 * archives themself, removes the last active owner, or gives a role with more than they hold.
 */
@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly audit: AuditService,
  ) {}

  async list(q: z.output<typeof staffListQuerySchema>): Promise<Paginated<StaffDto>> {
    const and: Prisma.UserWhereInput[] = [
      { role: STAFF_KINDS },
      { archivedAt: q.archived ? { not: null } : null },
    ];
    if (q.role) {
      const role = await this.prisma.role.findFirst({ where: { name: q.role, ...STAFF_KINDS } });
      if (!role) throw invalid('role');
      and.push({ roleId: role.id });
    }
    if (q.q) {
      const id = searchId(q.q);
      const digits = phoneDigits(q.q);
      and.push({
        OR: [
          { name: contains(q.q) },
          { email: contains(q.q) },
          ...(digits ? [{ phone: { contains: digits } }] : []),
          ...(id ? [{ id }] : []),
        ],
      });
    }
    const where: Prisma.UserWhereInput = { AND: and };
    const listWhere = q.status ? { AND: [...and, { isActive: q.status === 'active' }] } : where;
    const order = q.order ?? (q.sort === 'name' ? 'asc' : 'desc');
    const [rows, total, groups] = await Promise.all([
      this.prisma.user.findMany({
        where: listWhere,
        include,
        orderBy: [{ [q.sort]: order }, { id: order }],
        ...pageArgs(q),
      }),
      this.prisma.user.count({ where: listWhere }),
      this.prisma.user.groupBy({ by: ['isActive'], where, _count: { _all: true } }),
    ]);
    const counts = statusCounts(
      ACTIVE_STATUSES,
      groups.map((g) => ({ status: g.isActive ? 'active' : 'inactive', _count: g._count })),
    );
    return { data: rows.map(toDto), meta: pageMeta(q, total, counts) };
  }

  async show(id: number): Promise<StaffDto> {
    return toDto(await this.find(this.prisma, id));
  }

  async create(input: z.output<typeof createStaffSchema>, actor: AuthUser): Promise<number> {
    return this.prisma
      .$transaction(async (tx) => {
        const role = await this.staffRole(tx, input.role);
        this.assertCanAssign(role, actor);
        await assertEmailFree(tx, input.email);
        const user = await this.accounts.create(tx, {
          roleName: role.name,
          name: input.name,
          email: input.email,
          phone: input.phone,
          timezone: input.timezone,
        });
        const row = await this.find(tx, user.id);
        await this.audit.record(
          {
            actorId: actor.id,
            action: 'created',
            subjectType: 'user',
            subjectId: user.id,
            after: snapshot(row),
          },
          tx,
        );
        return user.id;
      })
      .catch(rethrowEmailTaken);
  }

  async update(
    id: number,
    input: z.output<typeof updateStaffSchema>,
    actor: AuthUser,
  ): Promise<void> {
    await this.prisma
      .$transaction(async (tx) => {
        await lockRow(tx, 'users', id);
        const before = await this.find(tx, id);
        assertNotArchived(before);
        // Only an owner may edit an owner (an email change would hand over the account).
        this.assertNotOwnerTarget(before, actor);
        let roleId: number | undefined;
        if (input.role !== undefined && input.role !== before.role?.name) {
          if (before.id === actor.id) {
            throw rule(HttpStatus.UNPROCESSABLE_ENTITY, 'cannot_change_own_role', {
              errors: { role: ['You cannot change your own role.'] },
            });
          }
          const role = await this.staffRole(tx, input.role);
          this.assertCanAssign(role, actor);
          if (role.kind !== 'owner') await this.assertNotLastOwner(tx, before);
          roleId = role.id;
        }
        if (input.email !== undefined && input.email !== before.email) {
          // A new email lets whoever owns it reset the password: never for a login that holds
          // permissions the actor lacks (no escalation through account takeover).
          if (!isOwner(actor) && before.role) {
            const held = await tx.rolePermission.findMany({
              where: { roleId: before.role.id },
              select: { permission: { select: { name: true } } },
            });
            const missing = held
              .map((p) => p.permission.name)
              .filter((p) => !actor.permissions.has(p))
              .sort();
            if (missing.length) {
              throw rule(HttpStatus.FORBIDDEN, 'permission_not_held', {
                data: { permissions: missing },
              });
            }
          }
          await assertEmailFree(tx, input.email, id);
        }
        await tx.user.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.email !== undefined ? { email: input.email } : {}),
            ...(input.phone !== undefined ? { phone: input.phone } : {}),
            ...(input.timezone ? { timezone: input.timezone } : {}),
            ...(roleId !== undefined ? { roleId } : {}),
          },
        });
        const after = await this.find(tx, id);
        const changes = diff(snapshot(before), snapshot(after));
        if (changes) {
          await this.audit.record(
            {
              actorId: actor.id,
              action: roleId !== undefined ? 'role_assigned' : 'updated',
              subjectType: 'user',
              subjectId: id,
              before: changes[0],
              after: changes[1],
            },
            tx,
          );
        }
      })
      .catch(rethrowEmailTaken);
  }

  async changeStatus(
    id: number,
    input: z.output<typeof activeStatusChangeSchema>,
    actor: AuthUser,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'users', id);
      const user = await this.find(tx, id);
      assertNotArchived(user);
      const current = user.isActive ? 'active' : 'inactive';
      assertChanged(current, input.status);
      if (input.status === 'inactive') {
        if (user.id === actor.id) throw conflict('cannot_archive_self');
        this.assertNotOwnerTarget(user, actor);
        await this.assertNotLastOwner(tx, user);
      }
      await tx.user.update({
        where: { id },
        data: { isActive: input.status === 'active', ...statusStamp(input.reason, actor.id) },
      });
      // Deactivated: signed out everywhere at once (D130).
      if (input.status === 'inactive') await tx.session.deleteMany({ where: { userId: id } });
      await recordStatusChange(tx, 'staff', id, current, input.status, input.reason, actor.id);
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'status_changed',
          subjectType: 'user',
          subjectId: id,
          before: { status: current },
          after: { status: input.status, reason: input.reason },
          reason: input.reason,
        },
        tx,
      );
    });
  }

  async archive(id: number, reason: string, actor: AuthUser): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'users', id);
      const user = await this.find(tx, id);
      if (user.archivedAt) throw conflict('archived');
      if (user.id === actor.id) throw conflict('cannot_archive_self');
      if (user.isActive) throw conflict('must_deactivate_first');
      this.assertNotOwnerTarget(user, actor);
      await tx.user.update({
        where: { id },
        data: { archivedAt: new Date(), archivedById: actor.id, archiveReason: reason },
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'archived',
          subjectType: 'user',
          subjectId: id,
          after: { reason },
          reason,
        },
        tx,
      );
    });
  }

  /** Restore leaves the login inactive: reactivating is a separate, deliberate step. */
  async restore(id: number, actor: AuthUser): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'users', id);
      const user = await this.find(tx, id);
      if (!user.archivedAt) throw rule(HttpStatus.UNPROCESSABLE_ENTITY, 'not_archived');
      await tx.user.update({
        where: { id },
        data: { archivedAt: null, archivedById: null, archiveReason: null },
      });
      await this.audit.record(
        { actorId: actor.id, action: 'unarchived', subjectType: 'user', subjectId: id },
        tx,
      );
    });
  }

  private async find(db: Tx | PrismaService, id: number): Promise<Row> {
    const row = await db.user.findFirst({ where: { id, role: STAFF_KINDS }, include });
    if (!row) throw notFound();
    return row;
  }

  private async staffRole(tx: Tx, name: string) {
    const role = await tx.role.findFirst({
      where: { name, ...STAFF_KINDS },
      include: { permissions: { include: { permission: { select: { name: true } } } } },
    });
    if (!role) throw invalid('role');
    return role;
  }

  /**
   * No escalation through assignment (docs/29 §1): only an owner may give the owner role, and a
   * non-owner may only give a role whose permissions they all hold themself.
   */
  private assertCanAssign(
    role: { kind: string; permissions: Array<{ permission: { name: string } }> },
    actor: AuthUser,
  ): void {
    if (isOwner(actor)) return;
    if (role.kind === 'owner') throw rule(HttpStatus.FORBIDDEN, 'owner_role_locked');
    const missing = role.permissions
      .map((p) => p.permission.name)
      .filter((p) => !actor.permissions.has(p))
      .sort();
    if (missing.length) {
      throw rule(HttpStatus.FORBIDDEN, 'permission_not_held', { data: { permissions: missing } });
    }
  }

  /** Only an owner may change, deactivate or archive an owner. */
  private assertNotOwnerTarget(user: Row, actor: AuthUser): void {
    if (user.role?.kind === 'owner' && !isOwner(actor)) {
      throw rule(HttpStatus.FORBIDDEN, 'owner_role_locked');
    }
  }

  /** Inside the transaction: the other active owners are locked until it commits. */
  private async assertNotLastOwner(tx: Tx, user: Row): Promise<void> {
    if (user.role?.kind !== 'owner') return;
    const others = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT u.id FROM "users" u JOIN "roles" r ON r.id = u.role_id
      WHERE r.kind = 'owner' AND u.is_active AND u.archived_at IS NULL AND u.id <> ${user.id}
      FOR UPDATE OF u`;
    if (others.length === 0) throw conflict('last_admin');
  }
}

function toDto(row: Row): StaffDto {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: {
      id: row.role!.id,
      name: row.role!.name,
      labelAr: row.role!.labelAr,
      labelEn: row.role!.labelEn,
      kind: row.role!.kind as 'owner' | 'staff',
    },
    timezone: row.timezone,
    locale: row.locale,
    status: {
      value: row.isActive ? 'active' : 'inactive',
      reason: row.statusReason,
      changedAt: iso(row.statusChangedAt),
      changedBy: row.statusChangedBy,
    },
    archive: archiveInfo(row),
    createdAt: row.createdAt.toISOString(),
  };
}
