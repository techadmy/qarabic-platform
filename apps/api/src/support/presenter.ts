import {
  isClosedStatus,
  TICKET_TRANSITIONS,
  type TicketAttachmentDto,
  type TicketCommentDto,
  type TicketDetailDto,
  type TicketDto,
} from '@qarabic/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { isoZ } from '../schedule/time.js';
import { SupportPolicy, type SupportViewer } from './policy.js';
import { SlaClock } from './sla.js';

export const ticketInclude = {
  reporter: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true } },
  family: { select: { id: true, user: { select: { name: true } } } },
  teacher: { select: { id: true, firstName: true, lastName: true } },
  _count: { select: { attachments: true } },
} satisfies Prisma.TicketInclude;

export const ticketDetailInclude = {
  ...ticketInclude,
  comments: {
    orderBy: { id: 'asc' },
    include: {
      author: { select: { id: true, name: true } },
      attachments: { orderBy: { id: 'asc' } },
    },
  },
  attachments: { orderBy: { id: 'asc' } },
} satisfies Prisma.TicketInclude;

export type TicketRow = Prisma.TicketGetPayload<{ include: typeof ticketInclude }>;
export type TicketDetailRow = Prisma.TicketGetPayload<{ include: typeof ticketDetailInclude }>;
type AttachmentRow = TicketDetailRow['attachments'][number];
type CommentRow = TicketDetailRow['comments'][number];

const teacherName = (t: { firstName: string; lastName: string | null } | null) =>
  t ? [t.firstName, t.lastName].filter(Boolean).join(' ') : null;

/** Meta keys a reporter may see on a timeline row (the status move, not names or ids). */
const PUBLIC_META = ['from', 'to', 'byReporter'];

export function attachmentDto(a: AttachmentRow): TicketAttachmentDto {
  return {
    id: a.id,
    source: a.source,
    mime: a.mime,
    size: a.size,
    name: a.originalName,
    commentId: a.commentId,
    available: a.prunedAt === null,
    url: a.prunedAt === null ? `/api/v1/feedback/attachments/${a.id}` : null,
    createdAt: isoZ(a.createdAt)!,
  };
}

function commentDto(c: CommentRow, reporterId: number | null, staff: boolean): TicketCommentDto {
  const meta = (c.meta && typeof c.meta === 'object' && !Array.isArray(c.meta) ? c.meta : {}) as
    Record<string, unknown> | Record<string, never>;
  return {
    id: c.id,
    kind: c.kind,
    body: c.body,
    internal: c.internal,
    meta: staff
      ? meta
      : Object.fromEntries(Object.entries(meta).filter(([k]) => PUBLIC_META.includes(k))),
    author: c.author ? { id: c.author.id, name: c.author.name } : null,
    authorLabel: c.authorLabel,
    byReporter: c.authorId !== null && c.authorId === reporterId,
    attachments: c.attachments.map(attachmentDto),
    createdAt: isoZ(c.createdAt)!,
  };
}

/**
 * One shape for lists and detail (Laravel `TicketResource`). Staff fields only for
 * `feedback.review` or members of the ticket's queue; the reporter sees who handles it by first
 * name only; nobody gets the WhatsApp contact phone.
 */
export const TicketPresenter = {
  dto(t: TicketRow, v: SupportViewer, nowMs: number): TicketDto {
    const staff = SupportPolicy.isStaffView(v, t);
    const mine = t.reporterId !== null && t.reporterId === v.user.id;
    const open = !isClosedStatus(t.status);
    const data: TicketDto = {
      id: t.id,
      number: `#${t.id}`,
      channel: t.channel,
      type: t.type,
      category: t.category,
      subcategory: t.subcategory,
      subject:
        t.subjectType && t.subjectId !== null ? { type: t.subjectType, id: t.subjectId } : null,
      status: t.status,
      priority: t.priority,
      title: t.title,
      area: t.area,
      resolution: t.resolution,
      reporter: t.reporter
        ? { id: t.reporter.id, name: t.reporter.name, role: t.reporterRole }
        : null,
      isMine: mine,
      hasUpdate:
        mine &&
        t.lastPublicAt !== null &&
        (t.reporterSeenAt === null || t.lastPublicAt > t.reporterSeenAt),
      createdAt: isoZ(t.createdAt)!,
      updatedAt: isoZ(t.updatedAt)!,
      lastPublicAt: isoZ(t.lastPublicAt),
      closedAt: isoZ(t.closedAt),
      attachmentsCount: t._count.attachments,
      queue: t.queue,
      visibility: t.visibility,
      slaDueAt: isoZ(t.slaDueAt),
      slaState: SlaClock.state(t.slaDueAt, t.firstResponseAt, open, nowMs),
      firstResponseAt: isoZ(t.firstResponseAt),
      handledBy: t.assignee ? (t.assignee.name.trim().split(/\s+/)[0] ?? null) : null,
    };
    if (staff) {
      Object.assign(data, {
        assignee: t.assignee ? { id: t.assignee.id, name: t.assignee.name } : null,
        prUrl: t.prUrl,
        duplicateOfId: t.duplicateOfId,
        triagedAt: isoZ(t.triagedAt),
        fixedAt: isoZ(t.fixedAt),
        verifiedAt: isoZ(t.verifiedAt),
        hasContactPhone: t.contactPhone !== null,
        family: t.familyId ? { id: t.familyId, name: t.family?.user.name ?? null } : null,
        teacher: t.teacherId ? { id: t.teacherId, name: teacherName(t.teacher) } : null,
      });
    }
    return data;
  },

  detail(t: TicketDetailRow, v: SupportViewer, nowMs: number): TicketDetailDto {
    const staff = SupportPolicy.isStaffView(v, t);
    const manage = SupportPolicy.canManage(v, t);
    const mine = SupportPolicy.owns(v.user, t);
    const comments = t.comments.filter((c) => staff || !c.internal);
    const visibleIds = new Set(comments.map((c) => c.id));
    const context = (
      t.context && typeof t.context === 'object' && !Array.isArray(t.context) ? t.context : {}
    ) as Record<string, unknown>;
    const publicContext = Object.fromEntries(
      Object.entries(context).filter(([k]) => k !== 'recentErrors' && k !== 'userAgent'),
    );
    return {
      ...TicketPresenter.dto(t, v, nowMs),
      description: t.description,
      context: staff ? context : publicContext,
      timeline: comments.map((c) => commentDto(c, t.reporterId, staff)),
      attachments: t.attachments
        .filter((a) => a.commentId === null || visibleIds.has(a.commentId))
        .map(attachmentDto),
      can: {
        manage,
        comment: manage || (mine && !isClosedStatus(t.status)),
        commentInternal: manage,
        confirm: mine && t.status === 'fixed',
        nextStatuses: manage ? [...TICKET_TRANSITIONS[t.status]] : [],
      },
    };
  },
};
