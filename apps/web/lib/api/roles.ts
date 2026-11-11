import { roleSchema, type RoleDto } from '@qarabic/shared';
import { z } from 'zod';
import { apiFetch } from './client';

const rolesResponseSchema = z.object({ data: z.array(roleSchema) });

/** `GET /roles` → `{ data: RoleDto[] }` (needs `roles.view`). */
export async function fetchRoles(signal?: AbortSignal): Promise<RoleDto[]> {
  return (await apiFetch('/roles', { schema: rolesResponseSchema, signal })).data;
}
