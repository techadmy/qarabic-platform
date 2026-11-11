import { createHash, randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import {
  categoryOfType,
  categoryType,
  CLOSED_TICKET_STATUSES,
  type createTicketSchema,
  isClosedStatus,
  isSubcategoryOf,
  NOTE_REQUIRED_STATUSES,
  OPEN_TICKET_STATUSES,
  PRIORITY_REQUIRED_STATUSES,
  TICKET_STATUSES,
  TICKET_TRANSITIONS,
  type FeedbackSummaryDto,
  type PersonRef,
  type TicketAttachmentSource,
  type TicketCategory,
  type TicketChannel,
  type TicketDetailDto,
  type TicketDto,
  type ticketListQuerySchema,
  type TicketListResponse,
  type TicketPriority,
  type TicketQueue,
  type TicketStatus,
  type TicketSubjectType,
  type TicketType,
  type updateTicketSchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import { AuditService, diff } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { Crypto } from '../common/crypto.js';
import { ApiException, notFound, validationError } from '../common/errors.js';
import { pageMeta, statusCounts } from '../common/pagination.js';
import { contains, searchId } from '../common/search.js';
import { Prisma } from '../generated/prisma/client.js';
import { isParentViewer, isTeacherViewer } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { sessionScopeWhere, viewerScope } from '../schedule/scope.js';
import { DAY } from '../schedule/time.js';
import { cleanContext } from './context.js';
import {
  has,
  SupportContext,
  SupportPolicy,
  type SupportConfig,
  type SupportViewer,
} from './policy.js';
import {
  ticketDetailInclude,
  ticketInclude,
  TicketPresenter,
  type TicketRow,
} from './presenter.js';
import { SlaClock } from './sla.js';
import { extensionFor, FileStorage } from './storage.js';

type Tx = Prisma.TransactionClient;

/** A validated image (bytes sniffed by the controller) or WhatsApp media. */
export interface UploadedFile {
  bytes: Buffer;
  mime: string;
  originalName: string | null;
  source: TicketAttachmentSource;
}

/** Who writes: a user (API) or a label with no user (CLI "Claude", a WhatsApp sender). */
export interface Actor {
  user: AuthUser | null;
  label: string | null;
}
export const userActor = (user: AuthUser): Actor => ({ user, label: null });

export type CreateInput = z.output<typeof createTicketSchema> & {
  contactPhone?: string | null;
  contactHash?: string | null;
};
type UpdateInput = z.output<typeof updateTicketSchema>;
type ListQuery = z.output<typeof ticketListQuerySchema>;

const STAFF_KINDS = new Set(['owner', 'staff']);

/** The first line of the description, Laravel `Str::limit(…, 120)`. */
export function titleFrom(description: string): string {
  const text = description.trim();
  const line = text.split('\n')[0]!.trim() || text;
  const chars = [...line];
  return chars.length > 120 ? `${chars.slice(0, 120).join('').trimEnd()}...` : line;
}

/**
 * All ticket writes go through here (API, CLI, WhatsApp) so the lifecycle rules (D97) are the same
 * everywhere — port of Laravel `TicketService` + the triage parts of the controllers. Reporter
 * notifications (D101: mail / WhatsApp) wait for the notification centre; the in-app «طلباتي» dot
 * (`lastPublicAt` vs `reporterSeenAt`) works now.
 */
@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly storage: FileStorage,
    private readonly crypto: Crypto,
    readonly context: SupportContext,
  ) {}

  // ------------------------------------------------------------------ create

  /**
   * Request-level checks of `POST /feedback/tickets` (Laravel `StoreTicketRequest::after`):
   * subcategory in its category, staff-only `channel` / `familyId`, and a subject in the
   * reporter's own scope. 422 on the field otherwise (ids of other families never leak).
   */
  async validateCreate(user: AuthUser, input: CreateInput): Promise<void> {
    const category = input.category ?? categoryOfType(input.type ?? 'bug');
    const errors: Record<string, string[]> = {};
    if (input.subcategory && !isSubcategoryOf(category, input.subcategory)) {
      errors.subcategory = ['The subcategory does not belong to the category.'];
    }
    if ((input.subjectType === undefined) !== (input.subjectId === undefined)) {
      errors[input.subjectType ? 'subjectId' : 'subjectType'] = ['Send the subject type and id.'];
    }
    const staff = STAFF_KINDS.has(user.role?.kind ?? '');
    for (const field of ['channel', 'familyId'] as const) {
      if (input[field] !== undefined && !staff)
        errors[field] = [`The ${field} field is prohibited.`];
    }
    if (Object.keys(errors).length) throw validationError(errors);
    if (input.familyId !== undefined) {
      const family = await this.prisma.family.findUnique({ where: { id: input.familyId } });
      if (!family) throw validationError({ familyId: ['The selected family is invalid.'] });
    }
    if (input.subjectType && input.subjectId !== undefined) {
      if (!(await this.canReference(user, input.subjectType, input.subjectId))) {
        throw validationError({ subjectId: ['You cannot link this item to a request.'] });
      }
    }
  }

  /** Whether `user` may attach this subject (same row scope as the rest of the API, D138). */
  async canReference(user: AuthUser, type: TicketSubjectType, id: number): Promise<boolean> {
    if (type === 'invoice') {
      // TODO(billing milestone): invoices do not exist in the new system yet; a family may link
      // only its own issued invoices, a teacher never (Laravel `canReference`).
      return false;
    }
    const scope = await viewerScope(this.prisma, user);
    if (type === 'session') {
      const row = await this.prisma.classSession.findFirst({
        where: { AND: [{ id, deletedAt: null }, sessionScopeWhere(scope)] },
        select: { id: true },
      });
      return row !== null;
    }
    const student = await this.prisma.student.findUnique({
      where: { id },
      select: { id: true, teacherId: true, enrollments: { select: { teacherId: true } } },
    });
    if (!student) return false;
    if (scope.kind === 'family') return scope.studentIds.includes(id);
    if (scope.kind === 'teacher') {
      return (
        student.teacherId === scope.teacherId ||
        student.enrollments.some((e) => e.teacherId === scope.teacherId)
      );
    }
    return true;
  }

  /** Who a ticket concerns (Laravel `TicketPeople`): from the subject first, then the reporter. */
  private async people(
    db: Tx | PrismaService,
    reporter: AuthUser | null,
    subjectType: TicketSubjectType | null,
    subjectId: number | null,
    familyId: number | null,
  ): Promise<{ familyId: number | null; teacherId: number | null; classStartsAt: number | null }> {
    let teacherId: number | null = null;
    let classStartsAt: number | null = null;
    if (subjectType === 'session' && subjectId !== null) {
      const s = await db.classSession.findUnique({
        where: { id: subjectId },
        select: { teacherId: true, startsAt: true, student: { select: { familyId: true } } },
      });
      teacherId = s?.teacherId ?? null;
      familyId ??= s?.student.familyId ?? null;
      classStartsAt = s?.startsAt.getTime() ?? null;
    } else if (subjectType === 'student' && subjectId !== null) {
      const st = await db.student.findUnique({
        where: { id: subjectId },
        select: {
          familyId: true,
          teacherId: true,
          enrollments: { where: { status: 'active' }, select: { teacherId: true }, take: 1 },
        },
      });
      familyId ??= st?.familyId ?? null;
      teacherId = st?.teacherId ?? st?.enrollments[0]?.teacherId ?? null;
    }
    if (reporter && isParentViewer(reporter)) {
      familyId ??=
        (await db.family.findUnique({ where: { userId: reporter.id }, select: { id: true } }))
          ?.id ?? null;
    }
    if (reporter && isTeacherViewer(reporter)) {
      teacherId ??=
        (await db.teacher.findUnique({ where: { userId: reporter.id }, select: { id: true } }))
          ?.id ?? null;
    }
    return { familyId, teacherId, classStartsAt };
  }

  /**
   * Technical tickets keep the triage flow (the triager sets the priority, D98). Other categories
   * start at P2; a complaint or a class within 24 hours starts at P1 (docs/32 §5).
   */
  static defaultPriority(
    category: TicketCategory,
    queue: TicketQueue,
    classStartsAt: number | null,
    nowMs: number,
  ): TicketPriority | null {
    if (category === 'technical') return null;
    if (
      queue === 'complaints' ||
      (classStartsAt !== null && classStartsAt > nowMs && classStartsAt <= nowMs + DAY)
    ) {
      return 'p1';
    }
    return 'p2';
  }

  async create(
    reporter: AuthUser | null,
    input: CreateInput,
    channel: TicketChannel,
    files: UploadedFile[] = [],
    config?: SupportConfig,
  ): Promise<number> {
    const cfg = config ?? (await this.context.config());
    const now = this.clock.now();
    const nowMs = now.getTime();
    const context = cleanContext(input.context);
    const area =
      typeof context.area === 'string' && /^[a-z0-9_-]{1,40}$/.test(context.area)
        ? context.area
        : null;
    // docs/32 S1: the category wins; the legacy type follows it (or, for old clients, the reverse).
    const category = input.category ?? categoryOfType(input.type ?? 'bug');
    const type: TicketType = input.category ? categoryType(category) : (input.type ?? 'bug');
    const sub =
      input.subcategory && isSubcategoryOf(category, input.subcategory) ? input.subcategory : null;
    const subjectType = input.subjectType ?? null;
    const subjectId = subjectType ? (input.subjectId ?? null) : null;
    const queue = SupportPolicy.forCategory(cfg, category, sub);
    const people = await this.people(
      this.prisma,
      reporter,
      subjectType,
      subjectId,
      input.familyId ?? null,
    );
    const written: string[] = [];
    try {
      return await this.prisma.$transaction(async (tx) => {
        const ticket = await tx.ticket.create({
          data: {
            channel,
            type,
            category,
            subcategory: sub,
            subjectType,
            subjectId,
            queue,
            visibility: SupportPolicy.isRestricted(cfg, queue) ? 'restricted' : 'normal',
            familyId: people.familyId,
            teacherId: people.teacherId,
            slaDueAt: new Date(SlaClock.dueFor(queue, nowMs, cfg, people.classStartsAt)),
            priority: TicketsService.defaultPriority(category, queue, people.classStartsAt, nowMs),
            status: 'new',
            title: titleFrom(input.description),
            description: input.description.trim(),
            reporterId: reporter?.id ?? null,
            reporterRole: reporter?.role?.name ?? null,
            contactPhone: input.contactPhone ? this.crypto.encrypt(input.contactPhone) : null,
            contactHash: input.contactHash ?? null,
            area,
            context: context as Prisma.InputJsonValue,
            lastPublicAt: now,
            reporterSeenAt: now,
            whatsappWindowUntil: channel === 'whatsapp' ? new Date(nowMs + DAY) : null,
            createdAt: now,
            updatedAt: now,
          },
        });
        for (const file of files) written.push(await this.storeFile(tx, ticket.id, file, null));
        // Personal / bulky fields (description, phone, context) stay out of the audit log.
        await this.audit.record(
          {
            actorId: reporter?.id ?? null,
            action: 'created',
            subjectType: 'ticket',
            subjectId: ticket.id,
            after: {
              category,
              subcategory: sub,
              queue,
              channel,
              priority: ticket.priority,
              subjectType,
              subjectId,
            },
          },
          tx,
        );
        return ticket.id;
      });
    } catch (error) {
      await Promise.all(written.map((key) => this.storage.delete(key)));
      throw error;
    }
  }

  /** Saves the bytes under a random key and records the attachment row. */
  async storeFile(
    tx: Tx,
    ticketId: number,
    file: UploadedFile,
    commentId: number | null,
  ): Promise<string> {
    const mime = file.mime.split(';')[0]!.trim().toLowerCase();
    const key = `tickets/${ticketId}/${randomUUID()}.${extensionFor(mime)}`;
    await this.storage.put(key, file.bytes);
    await tx.ticketAttachment.create({
      data: {
        ticketId,
        commentId,
        source: file.source,
        storageKey: key,
        mime,
        size: file.bytes.length,
        sha256: createHash('sha256').update(file.bytes).digest('hex'),
        originalName: file.originalName,
        createdAt: this.clock.now(),
      },
    });
    return key;
  }

  // ------------------------------------------------------------------ triage

  /**
   * Triage changes (`PATCH /feedback/tickets/:id`, the CLI). Lifecycle (D97): only the allowed
   * transitions; needs_info / wont_fix need a note; triaged / in_progress / fixed need a priority;
   * a technical fix needs its PR. Category, queue and assignee rules from docs/32 S2.
   */
  async update(id: number, changes: UpdateInput, actor: Actor): Promise<void> {
    const cfg = await this.context.config();
    await this.prisma.$transaction(async (tx) => {
      const t = await this.lock(tx, id);
      const now = this.clock.now();
      const note = changes.note?.trim() ?? '';
      const data: Prisma.TicketUncheckedUpdateInput = {};
      const timeline: Array<{
        kind: 'system' | 'priority' | 'assignment' | 'status';
        meta: Record<string, unknown>;
      }> = [];
      let category = t.category;
      let subcategory = t.subcategory;
      let queue = t.queue;
      let queueChange = changes.queue;

      // docs/32 S1: a new category brings its type; a type change from an old client its category.
      if (changes.category) {
        if (changes.category !== t.category) {
          timeline.push({
            kind: 'system',
            meta: { field: 'category', from: t.category, to: changes.category },
          });
          category = changes.category;
          if (subcategory && !isSubcategoryOf(category, subcategory)) subcategory = null;
          // A new category brings its queue unless one is given (S2).
          queueChange ??= SupportPolicy.forCategory(cfg, category, subcategory);
        }
        if (changes.type === undefined) data.type = categoryType(category);
      } else if (changes.type && categoryType(t.category) !== changes.type) {
        category = categoryOfType(changes.type);
        subcategory = null;
      }
      data.category = category;
      data.subcategory = subcategory;

      // S2: a new queue re-targets the SLA (until answered); a restricted ticket never goes back.
      if (queueChange && queueChange !== t.queue) {
        timeline.push({ kind: 'system', meta: { field: 'queue', from: t.queue, to: queueChange } });
        queue = queueChange;
        data.queue = queue;
        if (SupportPolicy.isRestricted(cfg, queue)) data.visibility = 'restricted';
        if (t.firstResponseAt === null) {
          const start =
            t.subjectType === 'session' && t.subjectId !== null
              ? ((
                  await tx.classSession.findUnique({ where: { id: t.subjectId } })
                )?.startsAt.getTime() ?? null)
              : null;
          data.slaDueAt = new Date(SlaClock.dueFor(queue, t.createdAt.getTime(), cfg, start));
          data.slaBreachNotifiedAt = null;
        }
      }

      if (changes.type !== undefined && changes.type !== t.type) {
        timeline.push({ kind: 'system', meta: { field: 'type', from: t.type, to: changes.type } });
        data.type = changes.type;
      }
      let priority = t.priority;
      if (changes.priority !== undefined && changes.priority !== t.priority) {
        timeline.push({ kind: 'priority', meta: { from: t.priority, to: changes.priority } });
        priority = changes.priority;
        data.priority = priority;
      }
      if (changes.title) data.title = changes.title.trim();
      for (const field of ['area', 'prUrl', 'resolution'] as const) {
        if (changes[field] !== undefined) {
          const value = changes[field] === null ? null : String(changes[field]).trim();
          data[field] = value === '' ? null : value;
        }
      }
      const prUrl = data.prUrl !== undefined ? (data.prUrl as string | null) : t.prUrl;

      if (changes.duplicateOfId !== undefined) {
        if (changes.duplicateOfId === t.id) {
          throw validationError({ duplicateOfId: ['A ticket cannot duplicate itself.'] });
        }
        if (
          changes.duplicateOfId !== null &&
          !(await tx.ticket.findUnique({ where: { id: changes.duplicateOfId } }))
        ) {
          throw validationError({ duplicateOfId: ['The selected ticket is invalid.'] });
        }
        data.duplicateOfId = changes.duplicateOfId;
      }

      if (changes.assigneeId !== undefined) {
        const assignee =
          changes.assigneeId === null ? null : await this.context.loadUser(changes.assigneeId);
        if (changes.assigneeId !== null && !assignee) {
          throw validationError({ assigneeId: ['The selected user is invalid.'] });
        }
        if (
          assignee &&
          !(await this.canBeAssigned(
            assignee,
            {
              ...t,
              queue,
              visibility: (data.visibility as 'restricted' | undefined) ?? t.visibility,
            },
            cfg,
          ))
        ) {
          throw validationError({ assigneeId: ['This person cannot handle this request.'] });
        }
        if ((assignee?.id ?? null) !== t.assigneeId) {
          timeline.push({
            kind: 'assignment',
            meta: { from: t.assigneeId, to: assignee?.id ?? null, toName: assignee?.name ?? null },
          });
          data.assigneeId = assignee?.id ?? null;
        }
      }

      let statusChanged = false;
      if (changes.status && changes.status !== t.status) {
        const to = changes.status;
        if (!TICKET_TRANSITIONS[t.status].includes(to)) {
          throw validationError({ status: [`A ticket cannot move from ${t.status} to ${to}.`] });
        }
        if ((NOTE_REQUIRED_STATUSES as readonly string[]).includes(to) && note === '') {
          throw validationError({ note: ['Add a note for the requester.'] });
        }
        if ((PRIORITY_REQUIRED_STATUSES as readonly string[]).includes(to) && priority === null) {
          throw validationError({ priority: ['Set a priority first.'] });
        }
        // A code fix needs its PR; a support case (classes, billing …) is resolved without one.
        if (to === 'fixed' && !prUrl && category === 'technical') {
          throw validationError({ prUrl: ['Add the pull request of the fix.'] });
        }
        timeline.push({ kind: 'status', meta: { from: t.status, to } });
        Object.assign(data, this.statusData(t, to, now));
        statusChanged = true;
      }

      if (statusChanged) {
        data.lastPublicAt = now;
        if (this.answersFirst(t, actor)) data.firstResponseAt = now;
      }
      data.updatedAt = now;
      await tx.ticket.update({ where: { id }, data });

      for (const row of timeline) {
        const isStatus = row.kind === 'status';
        // Status changes are visible to the reporter; priority, type and assignment are internal.
        await this.addRow(
          tx,
          id,
          actor,
          row.kind,
          isStatus && note ? note : null,
          !isStatus,
          row.meta,
        );
      }
      // A note without a status change is an internal remark.
      if (note && !statusChanged) await this.addRow(tx, id, actor, 'comment', note, true);

      const tracked = Object.fromEntries(
        Object.entries(data).filter(
          ([k]) =>
            !['updatedAt', 'lastPublicAt', 'slaBreachNotifiedAt', 'firstResponseAt'].includes(k),
        ),
      );
      const changed = diff(
        Object.fromEntries(
          Object.keys(tracked).map((k) => [k, (t as Record<string, unknown>)[k] ?? null]),
        ),
        tracked,
      );
      if (changed || note) {
        await this.audit.record(
          {
            actorId: actor.user?.id ?? null,
            action: statusChanged ? 'status_changed' : 'updated',
            subjectType: 'ticket',
            subjectId: id,
            before: changed?.[0] ?? {},
            after: { ...(changed?.[1] ?? {}), ...(actor.user ? {} : { by: actor.label }) },
            reason: note || null,
          },
          tx,
        );
      }
    });
  }

  private statusData(
    t: { triagedAt: Date | null },
    to: TicketStatus,
    now: Date,
  ): Prisma.TicketUncheckedUpdateInput {
    return {
      status: to,
      ...(to !== 'new' && t.triagedAt === null ? { triagedAt: now } : {}),
      ...(to === 'fixed' ? { fixedAt: now } : {}),
      ...(to === 'verified' ? { verifiedAt: now } : {}),
      closedAt: isClosedStatus(to) ? now : null,
    };
  }

  /** The first public answer from someone other than the reporter stops the SLA clock. */
  private answersFirst(
    t: { firstResponseAt: Date | null; reporterId: number | null },
    actor: Actor,
  ): boolean {
    const fromReporter =
      actor.user !== null && t.reporterId !== null && t.reporterId === actor.user.id;
    return (
      t.firstResponseAt === null && !fromReporter && (actor.user !== null || actor.label !== null)
    );
  }

  /** May `user` be the assignee: active, handles the queue and may see the ticket (restricted). */
  async canBeAssigned(
    user: AuthUser & { isActive: boolean },
    t: {
      reporterId: number | null;
      visibility: 'normal' | 'restricted';
      teacherId: number | null;
      queue: TicketQueue;
    },
    cfg: SupportConfig,
  ): Promise<boolean> {
    if (!user.isActive) return false;
    const v = await this.context.viewer(user, cfg);
    if (SupportPolicy.hiddenFrom(v, t)) return false;
    return SupportPolicy.canHandle(v, t.queue);
  }

  // ------------------------------------------------------------------ comments / reporter actions

  /**
   * Reporter replies, staff replies and internal notes. A reporter's reply on `needs_info` moves
   * the ticket back to `triaged`; a staff public reply is the first response (SLA) and an update
   * for the reporter.
   */
  async comment(
    id: number,
    actor: Actor,
    body: string,
    internal: boolean,
    files: UploadedFile[] = [],
  ): Promise<number> {
    const written: string[] = [];
    try {
      return await this.prisma.$transaction(async (tx) => {
        const t = await this.lock(tx, id);
        const now = this.clock.now();
        const fromReporter = actor.user !== null && t.reporterId === actor.user.id && !internal;
        const commentId = await this.addRow(tx, id, actor, 'comment', body.trim(), internal);
        for (const file of files) written.push(await this.storeFile(tx, id, file, commentId));
        if (fromReporter) {
          await this.reporterReplied(tx, t, actor);
        } else if (!internal) {
          await tx.ticket.update({
            where: { id },
            data: {
              lastPublicAt: now,
              updatedAt: now,
              ...(this.answersFirst(t, actor) ? { firstResponseAt: now } : {}),
            },
          });
        } else {
          await tx.ticket.update({ where: { id }, data: { updatedAt: now } });
        }
        return commentId;
      });
    } catch (error) {
      await Promise.all(written.map((key) => this.storage.delete(key)));
      throw error;
    }
  }

  /** The reporter's answer: seen now, and `needs_info` back to `triaged` (docs/22 §3). */
  async reporterReplied(
    tx: Tx,
    t: { id: number; status: TicketStatus },
    actor: Actor,
  ): Promise<void> {
    const now = this.clock.now();
    if (t.status === 'needs_info') {
      await this.addRow(tx, t.id, actor, 'status', null, false, {
        from: 'needs_info',
        to: 'triaged',
        byReporter: true,
      });
    }
    await tx.ticket.update({
      where: { id: t.id },
      data: {
        reporterSeenAt: now,
        updatedAt: now,
        ...(t.status === 'needs_info' ? { status: 'triaged' } : {}),
      },
    });
  }

  /** Reporter on a fixed ticket: resolved → verified; otherwise back to triaged with their words. */
  async confirm(id: number, reporter: AuthUser, resolved: boolean, body?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.lock(tx, id);
      if (t.status !== 'fixed') {
        throw validationError({ status: ['Only a resolved request can be confirmed.'] });
      }
      const now = this.clock.now();
      const to: TicketStatus = resolved ? 'verified' : 'triaged';
      await this.addRow(tx, id, userActor(reporter), 'status', body?.trim() || null, false, {
        from: 'fixed',
        to,
        byReporter: true,
      });
      await tx.ticket.update({
        where: { id },
        data: { ...this.statusData(t, to, now), reporterSeenAt: now, updatedAt: now },
      });
      await this.audit.record(
        {
          actorId: reporter.id,
          action: 'status_changed',
          subjectType: 'ticket',
          subjectId: id,
          before: { status: 'fixed' },
          after: { status: to, byReporter: true },
        },
        tx,
      );
    });
  }

  async markSeen(id: number): Promise<void> {
    await this.prisma.ticket.update({ where: { id }, data: { reporterSeenAt: this.clock.now() } });
  }

  async addRow(
    tx: Tx,
    ticketId: number,
    actor: Actor,
    kind: 'comment' | 'status' | 'priority' | 'assignment' | 'system',
    body: string | null,
    internal: boolean,
    meta: Record<string, unknown> | null = null,
  ): Promise<number> {
    const row = await tx.ticketComment.create({
      data: {
        ticketId,
        authorId: actor.user?.id ?? null,
        authorLabel: actor.user ? null : actor.label,
        kind,
        body,
        internal,
        meta: (meta ?? undefined) as Prisma.InputJsonValue | undefined,
        createdAt: this.clock.now(),
      },
    });
    return row.id;
  }

  /** The ticket row under a write lock (Laravel `lockForUpdate`); 404 when it does not exist. */
  private async lock(tx: Tx, id: number) {
    await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${id} FOR UPDATE`;
    const t = await tx.ticket.findUnique({ where: { id } });
    if (!t) throw notFound();
    return t;
  }

  // ------------------------------------------------------------------ reads

  /** The ticket if the viewer may see it, else 404 (`ability` = view | manage | confirm | comment). */
  async find(
    id: number,
    v: SupportViewer,
    ability: 'view' | 'manage' | 'confirm' | 'comment' = 'view',
  ): Promise<TicketRow> {
    const t = await this.prisma.ticket.findUnique({ where: { id }, include: ticketInclude });
    if (!t || !SupportPolicy.canView(v, t)) throw notFound();
    const allowed =
      ability === 'view'
        ? true
        : ability === 'manage'
          ? SupportPolicy.canManage(v, t)
          : ability === 'confirm'
            ? SupportPolicy.owns(v.user, t)
            : SupportPolicy.canComment(v, t);
    if (!allowed) throw forbidden();
    return t;
  }

  async detail(id: number, v: SupportViewer): Promise<TicketDetailDto> {
    const t = await this.prisma.ticket.findUnique({ where: { id }, include: ticketDetailInclude });
    if (!t || !SupportPolicy.canView(v, t)) throw notFound();
    return TicketPresenter.detail(t, v, this.clock.nowMs());
  }

  async dtos(ids: number[], v: SupportViewer): Promise<Map<number, TicketDto>> {
    const rows = await this.prisma.ticket.findMany({
      where: { id: { in: ids } },
      include: ticketInclude,
    });
    const now = this.clock.nowMs();
    return new Map(rows.map((r) => [r.id, TicketPresenter.dto(r, v, now)]));
  }

  /**
   * `GET /feedback/tickets`: own tickets («طلباتي») or, for `feedback.review`, the triage board
   * (restricted tickets only with `support.view_restricted`). Priority order: open first,
   * untriaged first, then P0 → P3, newest first.
   */
  async list(q: ListQuery, v: SupportViewer): Promise<TicketListResponse> {
    const review = has(v.user, 'feedback.review');
    const all = (q.scope ?? (review ? 'all' : 'mine')) === 'all';
    if (all && !review) throw forbidden();

    const and: Prisma.TicketWhereInput[] = [
      all ? SupportPolicy.staffWhere(v) : { reporterId: v.user.id },
    ];
    if (q.priority?.length) {
      const named = q.priority.filter((p): p is TicketPriority => p !== 'none');
      and.push({
        OR: [
          ...(named.length ? [{ priority: { in: named } }] : []),
          ...(q.priority.includes('none') ? [{ priority: null }] : []),
        ],
      });
    }
    if (q.type?.length) and.push({ type: { in: q.type } });
    if (q.category?.length) and.push({ category: { in: q.category } });
    if (q.channel) and.push({ channel: q.channel });
    if (q.queue) and.push({ queue: q.queue });
    if (q.area) and.push({ area: q.area });
    if (q.assigneeId !== undefined) {
      and.push({ assigneeId: q.assigneeId === 'none' ? null : q.assigneeId });
    }
    if (q.q) and.push(textSearch(q.q));
    const filtered: Prisma.TicketWhereInput = { AND: and };

    const statuses = new Set<TicketStatus>();
    for (const s of q.status ?? []) {
      if (s === 'open') OPEN_TICKET_STATUSES.forEach((x) => statuses.add(x));
      else if (s === 'closed') CLOSED_TICKET_STATUSES.forEach((x) => statuses.add(x));
      else statuses.add(s);
    }
    const where: Prisma.TicketWhereInput = statuses.size
      ? { AND: [filtered, { status: { in: [...statuses] } }] }
      : filtered;

    const [groups, total] = await Promise.all([
      this.prisma.ticket.groupBy({ by: ['status'], where: filtered, _count: { _all: true } }),
      this.prisma.ticket.count({ where }),
    ]);
    const sort = q.sort ?? (all ? 'priority' : 'updated');
    const skip = (q.page - 1) * q.perPage;
    let rows: TicketRow[];
    if (sort === 'priority') {
      // Open before closed (a CASE in SQL): two ordered parts concatenated, then the page.
      const openWhere = { AND: [where, { status: { notIn: [...CLOSED_TICKET_STATUSES] } }] };
      const closedWhere = { AND: [where, { status: { in: [...CLOSED_TICKET_STATUSES] } }] };
      const order: Prisma.TicketOrderByWithRelationInput[] = [
        { priority: { sort: 'asc', nulls: 'first' } },
        { id: 'desc' },
      ];
      const openCount = await this.prisma.ticket.count({ where: openWhere });
      const fromOpen =
        skip < openCount
          ? await this.prisma.ticket.findMany({
              where: openWhere,
              include: ticketInclude,
              orderBy: order,
              skip,
              take: q.perPage,
            })
          : [];
      const rest = q.perPage - fromOpen.length;
      const fromClosed =
        rest > 0
          ? await this.prisma.ticket.findMany({
              where: closedWhere,
              include: ticketInclude,
              orderBy: order,
              skip: Math.max(0, skip - openCount),
              take: rest,
            })
          : [];
      rows = [...fromOpen, ...fromClosed];
    } else {
      rows = await this.prisma.ticket.findMany({
        where,
        include: ticketInclude,
        orderBy:
          sort === 'updated'
            ? [{ lastPublicAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }]
            : [{ id: 'desc' }],
        skip,
        take: q.perPage,
      });
    }
    const now = this.clock.nowMs();
    return {
      data: rows.map((r) => TicketPresenter.dto(r, v, now)),
      meta: {
        ...pageMeta(q, total, statusCounts(TICKET_STATUSES, groups)),
        scope: all ? 'all' : 'mine',
      },
    };
  }

  /** Badge counts for the menu (docs/22 §6). */
  async summary(v: SupportViewer): Promise<FeedbackSummaryDto> {
    const mine = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM tickets
      WHERE reporter_id = ${v.user.id} AND last_public_at IS NOT NULL
        AND (reporter_seen_at IS NULL OR last_public_at > reporter_seen_at)`;
    return {
      mineUpdates: Number(mine[0]?.n ?? 0),
      triageNew: has(v.user, 'feedback.review')
        ? await this.prisma.ticket.count({
            where: { AND: [{ status: 'new' }, SupportPolicy.staffWhere(v)] },
          })
        : null,
    };
  }

  /** People a ticket can be assigned to on the triage board (holders of `feedback.manage`). */
  async triagers(): Promise<PersonRef[]> {
    return this.prisma.user.findMany({
      where: {
        isActive: true,
        archivedAt: null,
        role: { permissions: { some: { permission: { name: 'feedback.manage' } } } },
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 100,
    });
  }

  /** Active users who may handle `queue` (and see it, when restricted). */
  async handlers(queue: TicketQueue, cfg: SupportConfig): Promise<PersonRef[]> {
    const users = await this.prisma.user.findMany({
      where: {
        isActive: true,
        archivedAt: null,
        role: {
          permissions: {
            some: {
              permission: { name: { in: ['support.handle', 'support.manage', 'feedback.manage'] } },
            },
          },
        },
      },
      select: { id: true },
      orderBy: { name: 'asc' },
      take: 200,
    });
    const out: PersonRef[] = [];
    for (const { id } of users) {
      const u = await this.context.loadUser(id);
      if (!u) continue;
      const v = { user: u, config: cfg };
      if (
        SupportPolicy.canHandle(v, queue) &&
        (!SupportPolicy.isRestricted(cfg, queue) || SupportPolicy.canSeeRestricted(u))
      ) {
        out.push({ id: u.id, name: u.name });
      }
    }
    return out;
  }

  /** Counts the attachments a ticket already has (max 10 per ticket). */
  attachmentCount(ticketId: number): Promise<number> {
    return this.prisma.ticketAttachment.count({ where: { ticketId } });
  }
}

/** Title / description text, or `#12` / `12` for a ticket number. */
export function textSearch(term: string): Prisma.TicketWhereInput {
  const id = searchId(term.replace(/^#/, ''));
  return {
    OR: [...(id ? [{ id }] : []), { title: contains(term) }, { description: contains(term) }],
  };
}

export const forbidden = () =>
  new ApiException(HttpStatus.FORBIDDEN, {
    message: 'You do not have permission to do this.',
    code: 'forbidden',
  });
