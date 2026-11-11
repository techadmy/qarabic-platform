import { z } from 'zod';
import { apiFetch } from './client';

/**
 * `GET /roles` row. TODO(N1): move this schema to `@qarabic/shared` once the API publishes it, so
 * the API and the web app share one definition.
 */
export const roleSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  label_ar: z.string(),
  label_en: z.string(),
  kind: z.string(),
  customized_at: z.string().nullable(),
  permissions: z.array(z.string()),
});
export type RoleRow = z.infer<typeof roleSchema>;

export function fetchRoles(signal?: AbortSignal): Promise<RoleRow[]> {
  return apiFetch('/roles', { schema: z.array(roleSchema), signal });
}
