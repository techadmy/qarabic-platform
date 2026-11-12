import {
  announcementListResponseSchema,
  announcementSchema,
  dashboardSummarySchema,
  notificationPreferencesResponseSchema,
  taskAssigneeSchema,
  taskDetailSchema,
  taskListResponseSchema,
  taskTemplateSchema,
  type AnnouncementDto,
  type AnnouncementListQuery,
  type CreateTaskInput,
  type DashboardSummaryDto,
  type NotificationPreferenceDto,
  type NotificationPreferencesResponse,
  type Paginated,
  type TaskAssigneeDto,
  type TaskDetailDto,
  type TaskDto,
  type TaskListQuery,
  type TaskTemplateDto,
} from '@qarabic/shared';
import { z } from 'zod';
import { apiFetch } from './client';
import { toSearchParams } from './people';

/**
 * Operations (M8, apps/api `operations/`): tasks and their templates, announcements, the
 * signed-in person's notification preferences and the dashboard numbers. Contract in
 * `@qarabic/shared` (`operations.ts`).
 */
const one = <T extends z.ZodType>(schema: T) => z.object({ data: schema });
const qs = (query: object) => {
  const s = toSearchParams(query as Record<string, string | number | boolean | undefined>);
  return s ? `?${s}` : '';
};
const task = one(taskDetailSchema);

// ------------------------------------------------------------------ tasks

export async function fetchTasks(
  query: Partial<TaskListQuery>,
  signal?: AbortSignal,
): Promise<Paginated<TaskDto>> {
  return apiFetch(`/tasks${qs(query)}`, { schema: taskListResponseSchema, signal });
}

export async function fetchTask(id: number, signal?: AbortSignal): Promise<TaskDetailDto> {
  return (await apiFetch(`/tasks/${id}`, { schema: task, signal })).data;
}

export async function fetchTaskAssignees(
  q: string,
  signal?: AbortSignal,
): Promise<TaskAssigneeDto[]> {
  return (
    await apiFetch(`/tasks/assignees${qs({ q: q || undefined })}`, {
      schema: one(z.array(taskAssigneeSchema)),
      signal,
    })
  ).data;
}

export async function createTask(body: CreateTaskInput): Promise<TaskDetailDto> {
  return (await apiFetch('/tasks', { method: 'POST', body, schema: task })).data;
}

export async function updateTask(
  id: number,
  body: { title?: string; description?: string | null; priority?: string; dueAt?: string | null },
): Promise<TaskDetailDto> {
  return (await apiFetch(`/tasks/${id}`, { method: 'PATCH', body, schema: task })).data;
}

export type TaskAction = 'submit' | 'complete' | 'reopen' | 'close';

/** `submit` / `complete` take an optional note; `reopen` / `close` need a reason. */
export async function taskAction(
  id: number,
  action: TaskAction,
  text: string,
): Promise<TaskDetailDto> {
  const body =
    action === 'reopen' || action === 'close' ? { reason: text } : { note: text || null };
  return (await apiFetch(`/tasks/${id}/${action}`, { method: 'POST', body, schema: task })).data;
}

export async function reassignTask(
  id: number,
  assigneeId: number,
  note: string,
): Promise<TaskDetailDto> {
  return (
    await apiFetch(`/tasks/${id}/reassign`, {
      method: 'POST',
      body: { assigneeId, note: note || null },
      schema: task,
    })
  ).data;
}

export async function commentOnTask(id: number, body: string): Promise<TaskDetailDto> {
  return (await apiFetch(`/tasks/${id}/comments`, { method: 'POST', body: { body }, schema: task }))
    .data;
}

export async function fetchTaskTemplates(signal?: AbortSignal): Promise<TaskTemplateDto[]> {
  return (await apiFetch('/task-templates', { schema: one(z.array(taskTemplateSchema)), signal }))
    .data;
}

// ------------------------------------------------------------------ announcements

export async function fetchAnnouncements(
  query: Partial<AnnouncementListQuery>,
  signal?: AbortSignal,
): Promise<Paginated<AnnouncementDto>> {
  return apiFetch(`/announcements${qs(query)}`, {
    schema: announcementListResponseSchema,
    signal,
  });
}

export async function markAnnouncementRead(id: number): Promise<AnnouncementDto> {
  return (
    await apiFetch(`/announcements/${id}/read`, {
      method: 'POST',
      body: {},
      schema: one(announcementSchema),
    })
  ).data;
}

export type AnnouncementInput = {
  title: string;
  body: string;
  audience: string[];
  pinned: boolean;
  expiresAt: string | null;
};

export async function saveAnnouncement(
  id: number | null,
  body: AnnouncementInput,
): Promise<AnnouncementDto> {
  return (
    await apiFetch(id ? `/announcements/${id}` : '/announcements', {
      method: id ? 'PATCH' : 'POST',
      body,
      schema: one(announcementSchema),
    })
  ).data;
}

/** Announcement transitions; `unarchive` is the undo of `archive` (D31). */
export type AnnouncementAction = 'publish' | 'archive' | 'unarchive';

export async function announcementAction(
  id: number,
  action: AnnouncementAction,
): Promise<AnnouncementDto> {
  return (
    await apiFetch(`/announcements/${id}/${action}`, {
      method: 'POST',
      body: {},
      schema: one(announcementSchema),
    })
  ).data;
}

// ------------------------------------------------------------------ preferences and dashboard

export async function fetchNotificationPreferences(
  signal?: AbortSignal,
): Promise<NotificationPreferencesResponse> {
  return apiFetch('/me/notification-preferences', {
    schema: notificationPreferencesResponseSchema,
    signal,
  });
}

export async function saveNotificationPreferences(
  preferences: NotificationPreferenceDto[],
): Promise<NotificationPreferencesResponse> {
  return apiFetch('/me/notification-preferences', {
    method: 'PUT',
    body: { preferences },
    schema: notificationPreferencesResponseSchema,
  });
}

export async function fetchDashboardSummary(signal?: AbortSignal): Promise<DashboardSummaryDto> {
  return (await apiFetch('/dashboard/summary', { schema: one(dashboardSummarySchema), signal }))
    .data;
}

export const operationsKeys = {
  all: ['operations'] as const,
  tasks: (query: object) => ['operations', 'tasks', query] as const,
  task: (id: number) => ['operations', 'task', id] as const,
  assignees: (q: string) => ['operations', 'assignees', q] as const,
  templates: ['operations', 'templates'] as const,
  announcements: (query: object) => ['operations', 'announcements', query] as const,
  preferences: ['operations', 'preferences'] as const,
  dashboard: ['operations', 'dashboard'] as const,
};
