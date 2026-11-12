import { Controller, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import {
  type AnnouncementDto,
  announcementListQuerySchema,
  createTaskSchema,
  type DashboardSummaryDto,
  type NotificationPreferencesResponse,
  type Paginated,
  reassignTaskSchema,
  saveAnnouncementSchema,
  saveNotificationPreferencesSchema,
  saveTaskTemplateSchema,
  type TaskAssigneeDto,
  taskCommentSchema,
  type TaskDetailDto,
  type TaskDto,
  taskListQuerySchema,
  taskNoteSchema,
  taskReasonSchema,
  type TaskTemplateDto,
  updateAnnouncementSchema,
  updateTaskSchema,
} from '@qarabic/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { Authenticated, Can, CurrentUser } from '../auth/decorators.js';
import { IdPipe } from '../common/id.pipe.js';
import { jsonSchema } from '../common/openapi.js';
import { ZodBody } from '../common/zod.pipe.js';
import { ZodQuery } from '../common/zod-query.pipe.js';
import { AnnouncementsService } from './announcements.service.js';
import { DashboardService } from './dashboard.service.js';
import { NotificationCentre } from './notification-centre.js';
import { TasksService } from './tasks.service.js';

type Out<S extends z.ZodType> = z.output<S>;

const searchQuery = z.object({ q: z.string().trim().max(100).optional() });
const templateQuery = z.object({
  all: z
    .union([z.boolean(), z.enum(['1', '0', 'true', 'false'])])
    .transform((v) => v === true || v === '1' || v === 'true')
    .default(false),
});

/** `/tasks` (M16): given to me, issued by me, all (`tasks.oversee`). Out of scope = 404. */
@ApiTags('operations')
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Can('tasks.view')
  @Get()
  list(
    @ZodQuery(taskListQuerySchema) q: Out<typeof taskListQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<Paginated<TaskDto>> {
    return this.tasks.list(q, viewer);
  }

  /** People a task can be given to (active staff). */
  @Can('tasks.manage')
  @Get('assignees')
  async assignees(
    @ZodQuery(searchQuery) q: Out<typeof searchQuery>,
  ): Promise<{ data: TaskAssigneeDto[] }> {
    return { data: await this.tasks.assignees(q.q) };
  }

  @Can('tasks.view')
  @Get(':id')
  async show(
    @Param('id', IdPipe) id: number,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: TaskDetailDto }> {
    return { data: await this.tasks.show(id, viewer) };
  }

  @Can('tasks.manage')
  @Post()
  @ApiBody({ schema: jsonSchema(createTaskSchema) })
  async create(
    @ZodBody(createTaskSchema) body: Out<typeof createTaskSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: TaskDetailDto }> {
    const id = await this.tasks.create(body, by);
    return { data: await this.tasks.show(id, by) };
  }

  @Can('tasks.manage')
  @Patch(':id')
  @ApiBody({ schema: jsonSchema(updateTaskSchema) })
  async update(
    @Param('id', IdPipe) id: number,
    @ZodBody(updateTaskSchema) body: Out<typeof updateTaskSchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: TaskDetailDto }> {
    await this.tasks.update(id, body, viewer);
    return { data: await this.tasks.show(id, viewer) };
  }

  @Can('tasks.view')
  @Post(':id/reassign')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(reassignTaskSchema) })
  async reassign(
    @Param('id', IdPipe) id: number,
    @ZodBody(reassignTaskSchema) body: Out<typeof reassignTaskSchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: TaskDetailDto }> {
    await this.tasks.reassign(id, body.assigneeId, body.note, viewer);
    return { data: await this.tasks.show(id, viewer, true) };
  }

  @Can('tasks.view')
  @Post(':id/submit')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(taskNoteSchema) })
  async submit(
    @Param('id', IdPipe) id: number,
    @ZodBody(taskNoteSchema) body: Out<typeof taskNoteSchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: TaskDetailDto }> {
    await this.tasks.submit(id, body.note, viewer);
    return { data: await this.tasks.show(id, viewer) };
  }

  @Can('tasks.view')
  @Post(':id/complete')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(taskNoteSchema) })
  async complete(
    @Param('id', IdPipe) id: number,
    @ZodBody(taskNoteSchema) body: Out<typeof taskNoteSchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: TaskDetailDto }> {
    await this.tasks.complete(id, body.note, viewer);
    return { data: await this.tasks.show(id, viewer) };
  }

  @Can('tasks.view')
  @Post(':id/reopen')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(taskReasonSchema) })
  async reopen(
    @Param('id', IdPipe) id: number,
    @ZodBody(taskReasonSchema) body: Out<typeof taskReasonSchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: TaskDetailDto }> {
    await this.tasks.reopen(id, body.reason, viewer);
    return { data: await this.tasks.show(id, viewer) };
  }

  @Can('tasks.view')
  @Post(':id/close')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(taskReasonSchema) })
  async close(
    @Param('id', IdPipe) id: number,
    @ZodBody(taskReasonSchema) body: Out<typeof taskReasonSchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: TaskDetailDto }> {
    await this.tasks.close(id, body.reason, viewer);
    return { data: await this.tasks.show(id, viewer) };
  }

  @Can('tasks.view')
  @Post(':id/comments')
  @ApiBody({ schema: jsonSchema(taskCommentSchema) })
  async comment(
    @Param('id', IdPipe) id: number,
    @ZodBody(taskCommentSchema) body: Out<typeof taskCommentSchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: TaskDetailDto }> {
    await this.tasks.comment(id, body.body, viewer);
    return { data: await this.tasks.show(id, viewer) };
  }
}

/** `/task-templates` (old `task_string`): pick with `tasks.manage`, edit with `tasks.oversee`. */
@ApiTags('operations')
@Controller('task-templates')
export class TaskTemplatesController {
  constructor(private readonly tasks: TasksService) {}

  @Can('tasks.manage')
  @Get()
  async list(
    @ZodQuery(templateQuery) q: Out<typeof templateQuery>,
  ): Promise<{ data: TaskTemplateDto[] }> {
    return { data: await this.tasks.templates(q.all) };
  }

  @Can('tasks.oversee')
  @Post()
  @ApiBody({ schema: jsonSchema(saveTaskTemplateSchema) })
  async create(
    @ZodBody(saveTaskTemplateSchema) body: Out<typeof saveTaskTemplateSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: TaskTemplateDto }> {
    return { data: await this.tasks.createTemplate(body, by) };
  }

  @Can('tasks.oversee')
  @Put(':id')
  @ApiBody({ schema: jsonSchema(saveTaskTemplateSchema) })
  async update(
    @Param('id', IdPipe) id: number,
    @ZodBody(saveTaskTemplateSchema) body: Out<typeof saveTaskTemplateSchema>,
  ): Promise<{ data: TaskTemplateDto }> {
    return { data: await this.tasks.updateTemplate(id, body) };
  }
}

/** `/announcements` (M16): current ones for the viewer's role; drafts and all with `manage`. */
@ApiTags('operations')
@Controller('announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Can('announcements.view')
  @Get()
  list(
    @ZodQuery(announcementListQuerySchema) q: Out<typeof announcementListQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<Paginated<AnnouncementDto>> {
    return this.announcements.list(q, viewer);
  }

  @Can('announcements.view')
  @Get(':id')
  async show(
    @Param('id', IdPipe) id: number,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: AnnouncementDto }> {
    return { data: await this.announcements.show(id, viewer) };
  }

  @Can('announcements.view')
  @Post(':id/read')
  @HttpCode(200)
  async read(
    @Param('id', IdPipe) id: number,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: AnnouncementDto }> {
    await this.announcements.markRead(id, viewer);
    return { data: await this.announcements.show(id, viewer) };
  }

  @Can('announcements.manage')
  @Post()
  @ApiBody({ schema: jsonSchema(saveAnnouncementSchema) })
  async create(
    @ZodBody(saveAnnouncementSchema) body: Out<typeof saveAnnouncementSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: AnnouncementDto }> {
    const id = await this.announcements.create(body, by);
    return { data: await this.announcements.show(id, by) };
  }

  @Can('announcements.manage')
  @Patch(':id')
  @ApiBody({ schema: jsonSchema(updateAnnouncementSchema) })
  async update(
    @Param('id', IdPipe) id: number,
    @ZodBody(updateAnnouncementSchema) body: Out<typeof updateAnnouncementSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: AnnouncementDto }> {
    await this.announcements.update(id, body, by);
    return { data: await this.announcements.show(id, by) };
  }

  @Can('announcements.manage')
  @Post(':id/publish')
  @HttpCode(200)
  async publish(
    @Param('id', IdPipe) id: number,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: AnnouncementDto }> {
    await this.announcements.publish(id, by);
    return { data: await this.announcements.show(id, by) };
  }

  @Can('announcements.manage')
  @Post(':id/archive')
  @HttpCode(200)
  async archive(
    @Param('id', IdPipe) id: number,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: AnnouncementDto }> {
    await this.announcements.archive(id, by);
    return { data: await this.announcements.show(id, by) };
  }
}

/** `/me/notification-preferences`: the signed-in person's own channels per kind. */
@ApiTags('account')
@Controller('me/notification-preferences')
export class NotificationPreferencesController {
  constructor(private readonly centre: NotificationCentre) {}

  @Authenticated()
  @Get()
  async show(@CurrentUser() user: AuthUser): Promise<NotificationPreferencesResponse> {
    return { data: await this.centre.preferences(user.id), channels: await this.centre.channels() };
  }

  @Authenticated()
  @Put()
  @ApiBody({ schema: jsonSchema(saveNotificationPreferencesSchema) })
  async save(
    @ZodBody(saveNotificationPreferencesSchema) body: Out<typeof saveNotificationPreferencesSchema>,
    @CurrentUser() user: AuthUser,
  ): Promise<NotificationPreferencesResponse> {
    await this.centre.savePreferences(user.id, body.preferences);
    return this.show(user);
  }
}

/** `/dashboard/summary` (M18): numbers for the staff home, by the viewer's permissions. */
@ApiTags('operations')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Can('reports.view')
  @Get('summary')
  async summary(@CurrentUser() viewer: AuthUser): Promise<{ data: DashboardSummaryDto }> {
    return { data: await this.dashboard.summary(viewer) };
  }
}
