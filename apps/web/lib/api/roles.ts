import {
  permissionCatalogSchema,
  roleSchema,
  type CreateRoleInput,
  type PermissionCatalog,
  type RoleDto,
  type UpdateRoleInput,
} from '@qarabic/shared';
import { z } from 'zod';
import { apiFetch } from './client';

const rolesResponseSchema = z.object({ data: z.array(roleSchema) });
const roleResponseSchema = z.object({ data: roleSchema });
const catalogResponseSchema = z.object({ data: permissionCatalogSchema });

/** `GET /roles` → `{ data: RoleDto[] }` (needs `roles.view`). */
export async function fetchRoles(signal?: AbortSignal): Promise<RoleDto[]> {
  return (await apiFetch('/roles', { schema: rolesResponseSchema, signal })).data;
}

export async function fetchRole(id: number, signal?: AbortSignal): Promise<RoleDto> {
  return (await apiFetch(`/roles/${id}`, { schema: roleResponseSchema, signal })).data;
}

export async function fetchCatalog(signal?: AbortSignal): Promise<PermissionCatalog> {
  return (await apiFetch('/roles/catalog', { schema: catalogResponseSchema, signal })).data;
}

export async function createRole(body: CreateRoleInput): Promise<RoleDto> {
  return (await apiFetch('/roles', { method: 'POST', body, schema: roleResponseSchema })).data;
}

export async function updateRole(id: number, body: UpdateRoleInput): Promise<RoleDto> {
  return (await apiFetch(`/roles/${id}`, { method: 'PATCH', body, schema: roleResponseSchema }))
    .data;
}

export async function deleteRole(id: number): Promise<void> {
  await apiFetch(`/roles/${id}`, { method: 'DELETE' });
}
