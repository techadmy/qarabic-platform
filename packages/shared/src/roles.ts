import { z } from 'zod';
import { allPermissions } from './permissions.js';

export const roleKindSchema = z.enum(['owner', 'staff', 'teacher', 'parent']);

export const roleSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  labelAr: z.string(),
  labelEn: z.string(),
  kind: roleKindSchema,
  isSystem: z.boolean(),
  /** Only staff roles are editable (docs/29 §1): owner always has everything, portal roles follow the matrix. */
  editable: z.boolean(),
  customizedAt: z.string().nullable(),
  permissions: z.array(z.string()),
});
export type RoleDto = z.infer<typeof roleSchema>;

const known = new Set<string>(allPermissions());

export const updateRolePermissionsSchema = z.object({
  permissions: z
    .array(z.string().refine((p) => known.has(p), { message: 'Unknown permission.' }))
    .max(known.size)
    .transform((list) => [...new Set(list)].sort()),
});
export type UpdateRolePermissionsInput = z.input<typeof updateRolePermissionsSchema>;
