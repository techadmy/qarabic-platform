import { z } from 'zod';

/**
 * In-app notifications (the top-bar bell): one `notifications` table for every module. N5 writes
 * the lead alerts (`kind=lead`, `LEAD_NOTIFICATION_EVENTS`); later modules add their own kinds.
 * Only the signed-in user's own rows are ever read or marked (`/me/notifications`).
 */

export const notificationListQuerySchema = z.object({
  /** Only the unread ones. */
  unread: z
    .union([z.boolean(), z.enum(['1', '0', 'true', 'false'])])
    .transform((v) => v === true || v === '1' || v === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type NotificationListQuery = z.input<typeof notificationListQuerySchema>;

export interface NotificationDto {
  id: number;
  /** `lead` (N5). */
  kind: string;
  /** For `lead`: a `LeadNotificationEvent`. */
  event: string;
  /** What the alert is about, e.g. `{ leadId, parentName, dueAt? }` for a lead. */
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationListResponse {
  data: NotificationDto[];
  meta: { unread: number };
}
