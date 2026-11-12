import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  AnnouncementDto,
  AnnouncementListQuery,
  Paginated,
  saveAnnouncementSchema,
  updateAnnouncementSchema,
} from '@qarabic/shared';
import { ANNOUNCEMENT_STATUSES } from '@qarabic/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { notFound } from '../common/errors.js';
import { pageArgs, pageMeta, statusCounts } from '../common/pagination.js';
import { contains } from '../common/search.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { opsError } from './errors.js';
import { NotificationCentre } from './notification-centre.js';

type SaveInput = z.output<typeof saveAnnouncementSchema>;
type UpdateInput = z.output<typeof updateAnnouncementSchema>;

const include = { createdBy: { select: { id: true, name: true } } } as const;
type Row = Prisma.AnnouncementGetPayload<{ include: typeof include }>;

/**
 * Announcements (M16; old "current / all announcements"): written as drafts by
 * `announcements.manage`, published to roles (empty audience = every role that may see
 * announcements), pinned or not, with an optional end date. Readers mark them read; publishing
 * puts a notice in the audience's bell.
 */
@Injectable()
export class AnnouncementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly notices: NotificationCentre,
  ) {}

  private current(viewer: AuthUser): Prisma.AnnouncementWhereInput {
    const now = this.clock.now();
    const role = viewer.role?.name ?? '';
    return {
      status: 'published',
      publishedAt: { lte: now },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      AND: [{ OR: [{ audience: { isEmpty: true } }, { audience: { has: role } }] }],
    };
  }

  private manages(viewer: AuthUser) {
    return viewer.permissions.has('announcements.manage');
  }

  async list(q: AnnouncementListQuery, viewer: AuthUser): Promise<Paginated<AnnouncementDto>> {
    const manage = q.scope === 'manage';
    if (manage && !this.manages(viewer)) throw opsError('not_allowed', HttpStatus.FORBIDDEN);
    const base: Prisma.AnnouncementWhereInput = {
      AND: [
        manage ? {} : this.current(viewer),
        q.q ? { OR: [{ title: contains(q.q) }, { body: contains(q.q) }] } : {},
        q.unread ? { reads: { none: { userId: viewer.id } } } : {},
      ],
    };
    const where = { AND: [base, manage && q.status ? { status: q.status } : {}] };
    const [rows, total, groups] = await Promise.all([
      this.prisma.announcement.findMany({
        where,
        include,
        orderBy: [
          { pinned: 'desc' },
          { publishedAt: { sort: 'desc', nulls: 'first' } },
          { id: 'desc' },
        ],
        ...pageArgs(q),
      }),
      this.prisma.announcement.count({ where }),
      manage
        ? this.prisma.announcement.groupBy({ by: ['status'], where: base, _count: { _all: true } })
        : Promise.resolve([]),
    ]);
    return {
      data: await this.present(rows, viewer, manage),
      meta: pageMeta(q, total, manage ? statusCounts(ANNOUNCEMENT_STATUSES, groups) : {}),
    };
  }

  private async find(id: number, viewer: AuthUser): Promise<Row> {
    const where = this.manages(viewer) ? { id } : { AND: [{ id }, this.current(viewer)] };
    const row = await this.prisma.announcement.findFirst({ where, include });
    if (!row) throw notFound();
    return row;
  }

  async show(id: number, viewer: AuthUser): Promise<AnnouncementDto> {
    const [dto] = await this.present([await this.find(id, viewer)], viewer, this.manages(viewer));
    return dto!;
  }

  private async assertAudience(audience: readonly string[]): Promise<void> {
    if (audience.length === 0) return;
    const roles = await this.prisma.role.count({ where: { name: { in: [...audience] } } });
    if (roles !== new Set(audience).size) {
      throw opsError('audience_invalid', HttpStatus.UNPROCESSABLE_ENTITY, 'audience');
    }
  }

  async create(input: SaveInput, by: AuthUser): Promise<number> {
    await this.assertAudience(input.audience);
    const now = this.clock.now();
    const row = await this.prisma.announcement.create({
      data: {
        title: input.title,
        body: input.body,
        audience: [...new Set(input.audience)],
        pinned: input.pinned,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdById: by.id,
        createdAt: now,
        updatedAt: now,
      },
    });
    return row.id;
  }

  async update(id: number, input: UpdateInput, by: AuthUser): Promise<void> {
    const row = await this.find(id, by);
    if (row.status === 'archived') throw opsError('invalid_announcement_status');
    if (input.audience) await this.assertAudience(input.audience);
    await this.prisma.announcement.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.audience !== undefined ? { audience: [...new Set(input.audience)] } : {}),
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
        ...(input.expiresAt !== undefined
          ? { expiresAt: input.expiresAt ? new Date(input.expiresAt) : null }
          : {}),
        updatedAt: this.clock.now(),
      },
    });
  }

  async publish(id: number, by: AuthUser): Promise<void> {
    const now = this.clock.now();
    const done = await this.prisma.announcement.updateMany({
      where: { id, status: 'draft' },
      data: { status: 'published', publishedAt: now, updatedAt: now },
    });
    if (done.count === 0) {
      await this.find(id, by);
      throw opsError('invalid_announcement_status');
    }
    const row = await this.prisma.announcement.findUniqueOrThrow({ where: { id } });
    await this.audit.record({
      actorId: by.id,
      action: 'announcement_published',
      subjectType: 'announcement',
      subjectId: id,
      after: { title: row.title, audience: row.audience },
    });
    const users = await this.prisma.user.findMany({
      where: {
        isActive: true,
        archivedAt: null,
        id: { not: by.id },
        role:
          row.audience.length > 0
            ? { name: { in: row.audience } }
            : { permissions: { some: { permission: { name: 'announcements.view' } } } },
      },
      select: { id: true },
    });
    await this.notices.send({
      userIds: users.map((u) => u.id),
      kind: 'announcement',
      event: 'published',
      data: { announcementId: id, title: row.title },
      email: { subject: row.title, text: row.body },
    });
  }

  async archive(id: number, by: AuthUser): Promise<void> {
    const row = await this.find(id, by);
    if (row.status === 'archived') throw opsError('invalid_announcement_status');
    await this.prisma.announcement.update({
      where: { id },
      data: { status: 'archived', updatedAt: this.clock.now() },
    });
    await this.audit.record({
      actorId: by.id,
      action: 'announcement_archived',
      subjectType: 'announcement',
      subjectId: id,
    });
  }

  /** Undo of archive (D31): back to published if it had been published, else to draft. */
  async unarchive(id: number, by: AuthUser): Promise<void> {
    const row = await this.find(id, by);
    if (row.status !== 'archived') throw opsError('invalid_announcement_status');
    const status = row.publishedAt ? 'published' : 'draft';
    await this.prisma.announcement.update({
      where: { id },
      data: { status, updatedAt: this.clock.now() },
    });
    await this.audit.record({
      actorId: by.id,
      action: 'announcement_unarchived',
      subjectType: 'announcement',
      subjectId: id,
      after: { status },
    });
  }

  async markRead(id: number, viewer: AuthUser): Promise<void> {
    const row = await this.prisma.announcement.findFirst({
      where: { AND: [{ id }, this.current(viewer)] },
      select: { id: true },
    });
    if (!row) throw notFound();
    await this.prisma.announcementRead.upsert({
      where: { announcementId_userId: { announcementId: id, userId: viewer.id } },
      create: { announcementId: id, userId: viewer.id, readAt: this.clock.now() },
      update: {},
    });
  }

  async unreadCount(viewer: AuthUser): Promise<number> {
    return this.prisma.announcement.count({
      where: { AND: [this.current(viewer), { reads: { none: { userId: viewer.id } } }] },
    });
  }

  private async present(
    rows: Row[],
    viewer: AuthUser,
    manage: boolean,
  ): Promise<AnnouncementDto[]> {
    const ids = rows.map((r) => r.id);
    const [mine, counts] = await Promise.all([
      this.prisma.announcementRead.findMany({
        where: { userId: viewer.id, announcementId: { in: ids } },
        select: { announcementId: true },
      }),
      manage
        ? this.prisma.announcementRead.groupBy({
            by: ['announcementId'],
            where: { announcementId: { in: ids } },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);
    const read = new Set(mine.map((m) => m.announcementId));
    const count = new Map(counts.map((c) => [c.announcementId, c._count._all]));
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      audience: r.audience,
      pinned: r.pinned,
      status: r.status,
      publishedAt: r.publishedAt?.toISOString() ?? null,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      createdBy: r.createdBy,
      read: read.has(r.id),
      readCount: manage ? (count.get(r.id) ?? 0) : null,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
