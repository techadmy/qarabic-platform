import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type createTaskSchema,
  OPEN_TASK_STATUSES,
  type Paginated,
  type saveTaskTemplateSchema,
  TASK_STATUSES,
  type TaskAssigneeDto,
  type TaskDetailDto,
  type TaskDto,
  type TaskEventKind,
  type TaskListQuery,
  type TaskStatus,
  type TaskSubjectType,
  type TaskTemplateDto,
  type updateTaskSchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { notFound } from '../common/errors.js';
import { pageArgs, pageMeta, statusCounts } from '../common/pagination.js';
import { contains } from '../common/search.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { opsError } from './errors.js';
import { NotificationCentre } from './notification-centre.js';

type Tx = Prisma.TransactionClient;
type CreateInput = z.output<typeof createTaskSchema>;
type UpdateInput = z.output<typeof updateTaskSchema>;
type TemplateInput = z.output<typeof saveTaskTemplateSchema>;

const person = { select: { id: true, name: true } } as const;
const taskInclude = {
  assignee: person,
  createdBy: person,
  _count: { select: { events: { where: { kind: 'comment' } } } },
} satisfies Prisma.TaskInclude;
type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

const DAY = 86_400_000;

type Action = 'edit' | 'reassign' | 'submit' | 'complete' | 'reopen' | 'close';
/** Who may ever do an action, whatever the status. */
const WHO: Record<Action, (s: TasksService, t: TaskRow, v: AuthUser) => boolean> = {
  edit: (s, t, v) => s.isIssuer(t, v),
  reassign: (s, t, v) => s.isIssuer(t, v) || t.assigneeId === v.id,
  submit: (_s, t, v) => t.assigneeId === v.id,
  complete: (s, t, v) => s.isIssuer(t, v),
  reopen: (s, t, v) => s.isIssuer(t, v),
  close: (s, t, v) => s.isIssuer(t, v),
};
const isOpen = (s: TaskStatus) => OPEN_TASK_STATUSES.includes(s);

/**
 * Tasks (M16; old "Given" / "Issued", docs/03 §11). A task is seen by its assignee, its issuer and
 * whoever has `tasks.oversee` (anyone else: 404). Lifecycle: pending → (assignee submits) awaiting →
 * (issuer confirms) completed; the issuer may reopen, or close with a reason. A task issued to
 * oneself completes on submit. Every change is on the append-only timeline; the other party gets a
 * notice (in-app, email by preference).
 */
@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly notices: NotificationCentre,
  ) {}

  private oversees(viewer: AuthUser): boolean {
    return viewer.permissions.has('tasks.oversee');
  }

  private visible(viewer: AuthUser): Prisma.TaskWhereInput {
    return this.oversees(viewer)
      ? {}
      : { OR: [{ assigneeId: viewer.id }, { createdById: viewer.id }] };
  }

  async list(q: TaskListQuery, viewer: AuthUser): Promise<Paginated<TaskDto>> {
    if (q.box === 'all' && !this.oversees(viewer))
      throw opsError('not_allowed', HttpStatus.FORBIDDEN);
    const now = this.clock.now();
    const box: Prisma.TaskWhereInput =
      q.box === 'given'
        ? { assigneeId: viewer.id }
        : q.box === 'issued'
          ? { createdById: viewer.id }
          : {};
    const base: Prisma.TaskWhereInput = {
      AND: [
        box,
        q.priority ? { priority: q.priority } : {},
        q.assigneeId ? { assigneeId: q.assigneeId } : {},
        q.subjectType ? { subjectType: q.subjectType } : {},
        q.subjectId ? { subjectId: q.subjectId } : {},
        q.overdue ? { status: { in: [...OPEN_TASK_STATUSES] }, dueAt: { lt: now } } : {},
        q.q ? { OR: [{ title: contains(q.q) }, { description: contains(q.q) }] } : {},
      ],
    };
    const status: Prisma.TaskWhereInput =
      q.status === 'open'
        ? { status: { in: [...OPEN_TASK_STATUSES] } }
        : q.status
          ? { status: q.status }
          : {};
    const where = { AND: [base, status] };
    const [rows, total, groups] = await Promise.all([
      this.prisma.task.findMany({
        where,
        include: taskInclude,
        orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { id: 'desc' }],
        ...pageArgs(q),
      }),
      this.prisma.task.count({ where }),
      this.prisma.task.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    return {
      data: rows.map((r) => this.present(r, viewer)),
      meta: pageMeta(q, total, statusCounts(TASK_STATUSES, groups)),
    };
  }

  private async find(id: number, viewer: AuthUser, db: Tx | PrismaService = this.prisma) {
    const row = await db.task.findFirst({
      where: { AND: [{ id }, this.visible(viewer)] },
      include: taskInclude,
    });
    if (!row) throw notFound();
    return row;
  }

  /** `unscoped`: the answer to a reassign by the former assignee (who no longer sees the task). */
  async show(id: number, viewer: AuthUser, unscoped = false): Promise<TaskDetailDto> {
    const row = unscoped
      ? await this.prisma.task.findUniqueOrThrow({ where: { id }, include: taskInclude })
      : await this.find(id, viewer);
    const events = await this.prisma.taskEvent.findMany({
      where: { taskId: id },
      include: { author: person },
      orderBy: { id: 'asc' },
    });
    return {
      ...this.present(row, viewer),
      events: events.map((e) => ({
        id: e.id,
        kind: e.kind as TaskEventKind,
        body: e.body,
        data: (e.data ?? {}) as Record<string, unknown>,
        author: e.author,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  private async assertAssignee(db: Tx, userId: number): Promise<void> {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { isActive: true, archivedAt: true, role: { select: { kind: true } } },
    });
    const staff = user?.role && (user.role.kind === 'staff' || user.role.kind === 'owner');
    if (!user?.isActive || user.archivedAt || !staff) {
      throw opsError('assignee_invalid', HttpStatus.UNPROCESSABLE_ENTITY, 'assigneeId');
    }
  }

  private event(
    tx: Tx,
    taskId: number,
    kind: TaskEventKind,
    authorId: number,
    body: string | null = null,
    data: Record<string, unknown> = {},
  ) {
    return tx.taskEvent.create({
      data: {
        taskId,
        kind,
        body,
        data: data as Prisma.InputJsonValue,
        authorId,
        createdAt: this.clock.now(),
      },
    });
  }

  async create(input: CreateInput, by: AuthUser): Promise<number> {
    const id = await this.prisma.$transaction(async (tx) => {
      await this.assertAssignee(tx, input.assigneeId);
      let dueAt = input.dueAt ? new Date(input.dueAt) : null;
      if (input.templateId) {
        const template = await tx.taskTemplate.findUnique({ where: { id: input.templateId } });
        if (!template?.isActive) throw notFound();
        if (input.dueAt === undefined && template.dueInDays !== null) {
          dueAt = new Date(this.clock.nowMs() + template.dueInDays * DAY);
        }
      }
      const now = this.clock.now();
      const task = await tx.task.create({
        data: {
          title: input.title,
          description: input.description,
          priority: input.priority,
          dueAt,
          assigneeId: input.assigneeId,
          createdById: by.id,
          subjectType: input.subjectType ?? null,
          subjectId: input.subjectId ?? null,
          templateId: input.templateId ?? null,
          createdAt: now,
          updatedAt: now,
        },
      });
      await this.event(tx, task.id, 'created', by.id, null, { assigneeId: input.assigneeId });
      return task.id;
    });
    if (input.assigneeId !== by.id) {
      await this.notify([input.assigneeId], 'assigned', id, input.title, by);
    }
    return id;
  }

  async update(id: number, input: UpdateInput, viewer: AuthUser): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const task = await this.find(id, viewer, tx);
      this.require(this.canEdit(task, viewer), task, viewer, 'edit');
      await tx.task.update({
        where: { id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.dueAt !== undefined
            ? { dueAt: input.dueAt ? new Date(input.dueAt) : null, dueNotifiedAt: null }
            : {}),
          updatedAt: this.clock.now(),
        },
      });
      await this.event(tx, id, 'updated', viewer.id, null, { fields: Object.keys(input) });
    });
  }

  async reassign(
    id: number,
    assigneeId: number,
    note: string | null,
    viewer: AuthUser,
  ): Promise<void> {
    const title = await this.prisma.$transaction(async (tx) => {
      const task = await this.find(id, viewer, tx);
      this.require(this.canReassign(task, viewer), task, viewer, 'reassign');
      if (task.assigneeId === assigneeId) {
        throw opsError('same_assignee', HttpStatus.UNPROCESSABLE_ENTITY, 'assigneeId');
      }
      await this.assertAssignee(tx, assigneeId);
      await tx.task.update({
        where: { id },
        data: { assigneeId, status: 'pending', submittedAt: null, updatedAt: this.clock.now() },
      });
      await this.event(tx, id, 'reassigned', viewer.id, note, {
        from: task.assigneeId,
        to: assigneeId,
      });
      return task.title;
    });
    if (assigneeId !== viewer.id) await this.notify([assigneeId], 'assigned', id, title, viewer);
  }

  /** Assignee: done. Waits for the issuer, unless the task is one's own. */
  async submit(id: number, note: string | null, viewer: AuthUser): Promise<void> {
    const task = await this.transition(
      id,
      viewer,
      'submit',
      (t) => this.canSubmit(t, viewer),
      (t) => (t.createdById === t.assigneeId ? 'completed' : 'awaiting'),
      note,
    );
    if (task.createdById !== viewer.id) {
      await this.notify([task.createdById], 'submitted', id, task.title, viewer);
    }
  }

  async complete(id: number, note: string | null, viewer: AuthUser): Promise<void> {
    const task = await this.transition(
      id,
      viewer,
      'complete',
      (t) => this.canComplete(t, viewer),
      () => 'completed',
      note,
    );
    if (task.assigneeId !== viewer.id) {
      await this.notify([task.assigneeId], 'completed', id, task.title, viewer);
    }
  }

  async reopen(id: number, reason: string, viewer: AuthUser): Promise<void> {
    const task = await this.transition(
      id,
      viewer,
      'reopen',
      (t) => this.canReopen(t, viewer),
      () => 'pending',
      reason,
    );
    if (task.assigneeId !== viewer.id) {
      await this.notify([task.assigneeId], 'reopened', id, task.title, viewer);
    }
  }

  async close(id: number, reason: string, viewer: AuthUser): Promise<void> {
    const task = await this.transition(
      id,
      viewer,
      'close',
      (t) => this.canClose(t, viewer),
      () => 'closed',
      reason,
    );
    if (task.assigneeId !== viewer.id) {
      await this.notify([task.assigneeId], 'closed', id, task.title, viewer);
    }
  }

  async comment(id: number, body: string, viewer: AuthUser): Promise<void> {
    const task = await this.find(id, viewer);
    await this.prisma.$transaction(async (tx) => {
      await this.event(tx, id, 'comment', viewer.id, body);
      await tx.task.update({ where: { id }, data: { updatedAt: this.clock.now() } });
    });
    const others = [task.assigneeId, task.createdById].filter((u) => u !== viewer.id);
    await this.notify(others, 'commented', id, task.title, viewer);
  }

  private async transition(
    id: number,
    viewer: AuthUser,
    action: Action,
    allowed: (t: TaskRow) => boolean,
    next: (t: TaskRow) => TaskStatus,
    note: string | null,
  ): Promise<TaskRow> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${id} FOR UPDATE`;
      const task = await this.find(id, viewer, tx);
      this.require(allowed(task), task, viewer, action);
      const status = next(task);
      const now = this.clock.now();
      await tx.task.update({
        where: { id },
        data: {
          status,
          updatedAt: now,
          ...(status === 'awaiting' ? { submittedAt: now } : {}),
          ...(status === 'completed'
            ? { completedAt: now, submittedAt: task.submittedAt ?? now }
            : {}),
          ...(status === 'closed' ? { closedAt: now, closeReason: note } : {}),
          ...(status === 'pending' ? { submittedAt: null, completedAt: null } : {}),
        },
      });
      await this.event(tx, id, 'status', viewer.id, note, { from: task.status, to: status });
      return task;
    });
  }

  /** Refuses: 403 when the person may never do it, 409 when the task's status is wrong. */
  private require(ok: boolean, task: TaskRow, viewer: AuthUser, action: Action): void {
    if (ok) return;
    if (!WHO[action](this, task, viewer)) throw opsError('not_allowed', HttpStatus.FORBIDDEN);
    throw opsError('invalid_task_status');
  }

  isIssuer(t: TaskRow, v: AuthUser) {
    return t.createdById === v.id || this.oversees(v);
  }
  private canEdit(t: TaskRow, v: AuthUser) {
    return isOpen(t.status) && this.isIssuer(t, v);
  }
  private canReassign(t: TaskRow, v: AuthUser) {
    return isOpen(t.status) && (this.isIssuer(t, v) || t.assigneeId === v.id);
  }
  private canSubmit(t: TaskRow, v: AuthUser) {
    return t.status === 'pending' && t.assigneeId === v.id;
  }
  private canComplete(t: TaskRow, v: AuthUser) {
    return isOpen(t.status) && this.isIssuer(t, v);
  }
  private canReopen(t: TaskRow, v: AuthUser) {
    return (t.status === 'awaiting' || t.status === 'completed') && this.isIssuer(t, v);
  }
  private canClose(t: TaskRow, v: AuthUser) {
    return isOpen(t.status) && this.isIssuer(t, v);
  }

  private present(r: TaskRow, viewer: AuthUser): TaskDto {
    const now = this.clock.nowMs();
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      status: r.status,
      priority: r.priority,
      dueAt: r.dueAt?.toISOString() ?? null,
      overdue: Boolean(r.dueAt && isOpen(r.status) && r.dueAt.getTime() < now),
      assignee: r.assignee,
      createdBy: r.createdBy,
      subjectType: (r.subjectType as TaskSubjectType | null) ?? null,
      subjectId: r.subjectId,
      submittedAt: r.submittedAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      closedAt: r.closedAt?.toISOString() ?? null,
      closeReason: r.closeReason,
      comments: r._count.events,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      can: {
        edit: this.canEdit(r, viewer),
        reassign: this.canReassign(r, viewer),
        submit: this.canSubmit(r, viewer),
        complete: this.canComplete(r, viewer),
        reopen: this.canReopen(r, viewer),
        close: this.canClose(r, viewer),
      },
    };
  }

  private async notify(
    userIds: number[],
    event: string,
    taskId: number,
    title: string,
    by: AuthUser,
  ): Promise<void> {
    await this.notices.send({
      userIds,
      kind: 'task',
      event,
      data: { taskId, title, by: by.name },
      email: { subject: `${title}`, text: `${title}\n\n${by.name}: ${event}` },
    });
  }

  /** Open tasks due within the hour: one notice to the assignee (job). */
  async notifyDueSoon(): Promise<number> {
    const now = this.clock.nowMs();
    const due = await this.prisma.task.findMany({
      where: {
        status: { in: [...OPEN_TASK_STATUSES] },
        dueAt: { lte: new Date(now + 3_600_000) },
        dueNotifiedAt: null,
      },
      select: { id: true, title: true, assigneeId: true, dueAt: true },
      take: 500,
    });
    for (const t of due) {
      const claimed = await this.prisma.task.updateMany({
        where: { id: t.id, dueNotifiedAt: null },
        data: { dueNotifiedAt: new Date(now) },
      });
      if (claimed.count === 0) continue;
      await this.notices.send({
        userIds: [t.assigneeId],
        kind: 'task',
        event: 'due_soon',
        data: { taskId: t.id, title: t.title, dueAt: t.dueAt?.toISOString() ?? null },
        email: { subject: t.title, text: `${t.title}\n\nDue: ${t.dueAt?.toISOString() ?? ''}` },
      });
    }
    return due.length;
  }

  async assignees(q: string | undefined): Promise<TaskAssigneeDto[]> {
    const rows = await this.prisma.user.findMany({
      where: {
        isActive: true,
        archivedAt: null,
        role: { kind: { in: ['staff', 'owner'] } },
        ...(q ? { name: contains(q) } : {}),
      },
      select: { id: true, name: true, role: { select: { name: true } } },
      orderBy: { name: 'asc' },
      take: 50,
    });
    return rows.map((r) => ({ id: r.id, name: r.name, role: r.role?.name ?? null }));
  }

  // ---------------------------------------------------------------- templates

  async templates(all: boolean): Promise<TaskTemplateDto[]> {
    const rows = await this.prisma.taskTemplate.findMany({
      where: all ? {} : { isActive: true },
      orderBy: { title: 'asc' },
    });
    return rows.map(presentTemplate);
  }

  async createTemplate(input: TemplateInput, by: AuthUser): Promise<TaskTemplateDto> {
    const row = await this.prisma.taskTemplate.create({
      data: {
        title: input.title,
        description: input.description,
        priority: input.priority,
        dueInDays: input.dueInDays ?? null,
        isActive: input.isActive,
        createdById: by.id,
      },
    });
    return presentTemplate(row);
  }

  async updateTemplate(id: number, input: TemplateInput): Promise<TaskTemplateDto> {
    if (!(await this.prisma.taskTemplate.findUnique({ where: { id } }))) throw notFound();
    const row = await this.prisma.taskTemplate.update({
      where: { id },
      data: {
        title: input.title,
        description: input.description,
        priority: input.priority,
        dueInDays: input.dueInDays ?? null,
        isActive: input.isActive,
        updatedAt: this.clock.now(),
      },
    });
    return presentTemplate(row);
  }
}

function presentTemplate(r: {
  id: number;
  title: string;
  description: string | null;
  priority: TaskTemplateDto['priority'];
  dueInDays: number | null;
  isActive: boolean;
}): TaskTemplateDto {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    priority: r.priority,
    dueInDays: r.dueInDays,
    isActive: r.isActive,
  };
}
