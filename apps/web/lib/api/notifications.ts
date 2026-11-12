import type { NotificationListResponse } from '@qarabic/shared';
import { z } from 'zod';
import { apiFetch } from './client';

/** The top-bar bell (`/me/notifications`): the signed-in user's own alerts. */
const listSchema = z.object({
  data: z.array(
    z.object({
      id: z.number().int(),
      kind: z.string(),
      event: z.string(),
      data: z.record(z.string(), z.unknown()),
      readAt: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  meta: z.object({ unread: z.number().int() }),
});

export async function fetchNotifications(signal?: AbortSignal): Promise<NotificationListResponse> {
  return apiFetch('/me/notifications?limit=20', { schema: listSchema, signal });
}

export async function markNotificationRead(id: number): Promise<void> {
  await apiFetch(`/me/notifications/${id}/read`, { method: 'POST' });
}

export async function markAllNotificationsRead(): Promise<void> {
  await apiFetch('/me/notifications/read-all', { method: 'POST' });
}

export const notificationKeys = { list: ['me', 'notifications'] as const };
