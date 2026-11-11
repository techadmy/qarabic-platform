import { Injectable } from '@nestjs/common';
import {
  type createFamilySchema,
  FAMILY_STATUSES,
  type FamilyDetailDto,
  type FamilyDto,
  type familyListQuerySchema,
  type familyStatusChangeSchema,
  type Paginated,
  type updateFamilySchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import { AuditService, diff } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { conflict, notFound, rule } from '../common/errors.js';
import { pageArgs, pageMeta, statusCounts } from '../common/pagination.js';
import { contains, dateOnly, phoneDigits, searchId, toDate } from '../common/search.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EnrollmentsService } from '../schedule/enrollments.service.js';
import { AccountsService } from './accounts.service.js';
import {
  archiveInfo,
  assertChanged,
  assertEmailFree,
  assertNotArchived,
  byUser,
  invalid,
  isParentViewer,
  iso,
  lockRow,
  personRef,
  recordStatusChange,
  rethrowEmailTaken,
  statusHistory,
  statusInfo,
  statusStamp,
  type Tx,
} from './people.common.js';

const include = {
  user: { select: { id: true, name: true, email: true, phone: true } },
  manager: byUser,
  statusChangedBy: byUser,
  archivedBy: byUser,
  students: {
    select: { id: true, name: true, status: true, archivedAt: true },
    orderBy: { id: 'asc' },
  },
} satisfies Prisma.FamilyInclude;

type Row = Prisma.FamilyGetPayload<{ include: typeof include }>;

/** What the audit log keeps of a family (contact fields included: they live on the parent login). */
function snapshot(row: Row): Record<string, unknown> {
  return {
    parentName: row.user.name,
    email: row.user.email,
    phone: row.user.phone,
    countryCode: row.countryCode,
    timezone: row.timezone,
    managerId: row.managerId,
    startDate: dateOnly(row.startDate),
    trialDate: dateOnly(row.trialDate),
    zoomId: row.zoomId,
    whatsappGroupId: row.whatsappGroupId,
    comment: row.comment,
  };
}

/**
 * Families (docs/28 §2–§4, §10): list, profile, add (parent login + family), edit, status with
 * reason, archive / restore. Port of Laravel `PeopleService` + `UserController::families`.
 */
@Injectable()
export class FamiliesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly audit: AuditService,
    private readonly enrollments: EnrollmentsService,
  ) {}

  async list(
    q: z.output<typeof familyListQuerySchema>,
    viewer: AuthUser,
  ): Promise<Paginated<FamilyDto>> {
    const and: Prisma.FamilyWhereInput[] = [{ archivedAt: q.archived ? { not: null } : null }];
    // A parent (families.view for their portal) only ever sees their own family.
    if (isParentViewer(viewer)) and.push({ userId: viewer.id });
    if (q.managerId) and.push({ managerId: q.managerId });
    if (q.countryCode) and.push({ countryCode: q.countryCode });
    if (q.q) {
      const digits = phoneDigits(q.q);
      const id = searchId(q.q);
      // Parent name / email / phone, family ID, children's names (docs/28 §10).
      and.push({
        OR: [
          { user: { name: contains(q.q) } },
          { user: { email: contains(q.q) } },
          ...(digits ? [{ user: { phone: { contains: digits } } }] : []),
          ...(id ? [{ id }] : []),
          { students: { some: { name: contains(q.q) } } },
        ],
      });
    }
    const where: Prisma.FamilyWhereInput = { AND: and };
    const listWhere: Prisma.FamilyWhereInput = q.status
      ? { AND: [...and, { status: q.status }] }
      : where;

    const order = q.order ?? (q.sort === 'parentName' ? 'asc' : 'desc');
    const orderBy: Prisma.FamilyOrderByWithRelationInput[] = [
      q.sort === 'parentName'
        ? { user: { name: order } }
        : q.sort === 'startDate'
          ? { startDate: { sort: order, nulls: 'last' } }
          : { [q.sort]: order },
      { id: order },
    ];
    const [rows, total, groups] = await Promise.all([
      this.prisma.family.findMany({ where: listWhere, include, orderBy, ...pageArgs(q) }),
      this.prisma.family.count({ where: listWhere }),
      this.prisma.family.groupBy({ by: ['status'], where, _count: { _all: true } }),
    ]);
    return {
      data: rows.map((r) => this.toDto(r, viewer)),
      meta: pageMeta(q, total, statusCounts(FAMILY_STATUSES, groups)),
    };
  }

  async show(id: number, viewer: AuthUser): Promise<FamilyDetailDto> {
    const row = await this.prisma.family.findUnique({ where: { id }, include });
    // 404, not 403: never confirm that another family exists (Laravel FamilyPolicy).
    if (!row || (isParentViewer(viewer) && row.userId !== viewer.id)) throw notFound();
    const portal = isParentViewer(viewer);
    return {
      ...this.toDto(row, viewer),
      statusHistory: portal ? [] : await statusHistory(this.prisma, 'family', id),
    };
  }

  async create(input: z.output<typeof createFamilySchema>, actor: AuthUser): Promise<number> {
    const id = await this.prisma
      .$transaction(async (tx) => {
        await assertEmailFree(tx, input.email);
        await this.assertManager(tx, input.managerId);
        const user = await this.accounts.create(tx, {
          roleName: 'parent',
          name: input.parentName,
          email: input.email,
          phone: input.phone,
          timezone: input.timezone,
        });
        const family = await tx.family.create({
          data: {
            userId: user.id,
            timezone: input.timezone,
            status: input.status,
            ...this.fields(input),
          },
          include,
        });
        await this.audit.record(
          {
            actorId: actor.id,
            action: 'created',
            subjectType: 'family',
            subjectId: family.id,
            after: { ...snapshot(family), status: family.status },
          },
          tx,
        );
        return family.id;
      })
      .catch(rethrowEmailTaken);
    return id;
  }

  async update(
    id: number,
    input: z.output<typeof updateFamilySchema>,
    actor: AuthUser,
  ): Promise<void> {
    await this.prisma
      .$transaction(async (tx) => {
        await lockRow(tx, 'families', id);
        const before = await tx.family.findUniqueOrThrow({ where: { id }, include });
        assertNotArchived(before);
        if (input.email !== undefined) await assertEmailFree(tx, input.email, before.userId);
        if (input.managerId !== undefined) await this.assertManager(tx, input.managerId);

        await tx.user.update({
          where: { id: before.userId },
          data: {
            ...(input.parentName !== undefined ? { name: input.parentName } : {}),
            ...(input.email !== undefined ? { email: input.email } : {}),
            ...(input.phone !== undefined ? { phone: input.phone } : {}),
          },
        });
        const after = await tx.family.update({
          where: { id },
          data: {
            ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
            ...this.fields(input),
          },
          include,
        });
        const changes = diff(snapshot(before), snapshot(after));
        if (changes) {
          await this.audit.record(
            {
              actorId: actor.id,
              action: 'updated',
              subjectType: 'family',
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

  /**
   * Status with a reason (D123). Enrollments follow the family status in N2 (pause on leave /
   * suspended, resume on regular, end on deactivated: D124); N1 has no enrollments yet.
   */
  async changeStatus(
    id: number,
    input: z.output<typeof familyStatusChangeSchema>,
    actor: AuthUser,
  ): Promise<void> {
    const resyncs = await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'families', id);
      const family = await tx.family.findUniqueOrThrow({ where: { id } });
      assertNotArchived(family);
      assertChanged(family.status, input.status);
      await tx.family.update({
        where: { id },
        data: { status: input.status, ...statusStamp(input.reason, actor.id) },
      });
      await recordStatusChange(
        tx,
        'family',
        id,
        family.status,
        input.status,
        input.reason,
        actor.id,
      );
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'status_changed',
          subjectType: 'family',
          subjectId: id,
          before: { status: family.status },
          after: { status: input.status, reason: input.reason },
          reason: input.reason,
        },
        tx,
      );
      // docs/14 §4.2: suspended / on leave pause the live enrollments, deactivated ends them,
      // back to regular / trial resumes the ones paused for a family reason.
      return this.enrollments.syncWithFamilyStatus(tx, id, input.status, actor.id);
    });
    // Future generated classes follow (cancelled / restored) once the change is saved.
    await this.enrollments.resyncAll(resyncs);
  }

  /**
   * Archive ("delete", D128): only a deactivated family. Its children go with it (same stamp, so a
   * restore brings back exactly these) and the parent login closes. Open invoices will also block
   * this once billing exists (N6).
   */
  async archive(id: number, reason: string, actor: AuthUser): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'families', id);
      const family = await tx.family.findUniqueOrThrow({ where: { id } });
      if (family.archivedAt) throw conflict('archived');
      if (family.status !== 'deactivated') throw conflict('must_deactivate_first');
      const stamp = { archivedAt: new Date(), archivedById: actor.id, archiveReason: reason };
      await tx.family.update({ where: { id }, data: stamp });
      await tx.student.updateMany({ where: { familyId: id, archivedAt: null }, data: stamp });
      await this.accounts.closeLogin(tx, family.userId);
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'archived',
          subjectType: 'family',
          subjectId: id,
          after: { reason },
          reason,
        },
        tx,
      );
    });
  }

  async restore(id: number, actor: AuthUser): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'families', id);
      const family = await tx.family.findUniqueOrThrow({ where: { id } });
      if (!family.archivedAt) throw rule(422, 'not_archived');
      const clear = { archivedAt: null, archivedById: null, archiveReason: null };
      await tx.student.updateMany({
        where: { familyId: id, archivedAt: family.archivedAt },
        data: clear,
      });
      await tx.family.update({ where: { id }, data: clear });
      await tx.user.update({ where: { id: family.userId }, data: { isActive: true } });
      await this.audit.record(
        { actorId: actor.id, action: 'unarchived', subjectType: 'family', subjectId: id },
        tx,
      );
    });
  }

  private fields(input: Omit<z.output<typeof updateFamilySchema>, 'status'>) {
    return {
      ...(input.countryCode !== undefined ? { countryCode: input.countryCode } : {}),
      ...(input.managerId !== undefined ? { managerId: input.managerId } : {}),
      ...(input.startDate !== undefined ? { startDate: toDate(input.startDate) } : {}),
      ...(input.trialDate !== undefined ? { trialDate: toDate(input.trialDate) } : {}),
      ...(input.zoomId !== undefined ? { zoomId: input.zoomId } : {}),
      ...(input.whatsappGroupId !== undefined ? { whatsappGroupId: input.whatsappGroupId } : {}),
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
    };
  }

  /** A family manager is an active staff (or owner) login. */
  private async assertManager(tx: Tx, managerId: number | null | undefined): Promise<void> {
    if (!managerId) return;
    const ok = await tx.user.findFirst({
      where: {
        id: managerId,
        isActive: true,
        archivedAt: null,
        role: { kind: { in: ['owner', 'staff'] } },
      },
      select: { id: true },
    });
    if (!ok) throw invalid('managerId', 'The selected manager is invalid.');
  }

  private toDto(row: Row, viewer: AuthUser): FamilyDto {
    const portal = isParentViewer(viewer);
    return {
      id: row.id,
      parentUserId: row.userId,
      parentName: row.user.name,
      email: row.user.email,
      phone: row.user.phone,
      countryCode: row.countryCode,
      timezone: row.timezone,
      manager: personRef(row.manager),
      startDate: dateOnly(row.startDate),
      trialDate: dateOnly(row.trialDate),
      zoomId: row.zoomId,
      whatsappGroupId: row.whatsappGroupId,
      comment: portal ? null : row.comment,
      // Staff notes stay with staff: a parent sees the status, not the reason or who set it.
      status: portal ? { ...statusInfo(row), reason: null, changedBy: null } : statusInfo(row),
      archive: archiveInfo(row),
      students: row.students
        .filter((s) => (row.archivedAt ? true : s.archivedAt === null))
        .map((s) => ({ id: s.id, name: s.name, status: s.status })),
      createdAt: iso(row.createdAt)!,
    };
  }
}
