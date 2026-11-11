import { z } from 'zod';
import { allPermissions } from './permissions.js';

export const roleKindSchema = z.enum(['owner', 'staff', 'teacher', 'parent']);

/** A role for the Roles screen (docs/29 §2, Laravel `RoleResource`). */
export const roleSchema = z.object({
  id: z.number().int(),
  /** Stable slug: system names (`monitor`) or `custom_<id>`. */
  name: z.string(),
  labelAr: z.string(),
  labelEn: z.string().nullable(),
  description: z.string().nullable(),
  kind: roleKindSchema,
  isSystem: z.boolean(),
  /** The viewer may change this role at all (labels): `roles.manage`, and an owner, or neither the owner role nor their own role. */
  editable: z.boolean(),
  /** …and its permission matrix too: staff roles only (owner always has everything, portal roles follow the matrix). */
  permissionsEditable: z.boolean(),
  /** Users holding the role, archived ones included (a role in use cannot be deleted). */
  usersCount: z.number().int(),
  customizedAt: z.string().nullable(),
  permissions: z.array(z.string()),
});
export type RoleDto = z.infer<typeof roleSchema>;

const known = new Set<string>(allPermissions());

/** Known `module.action` names, de-duplicated and sorted. Unknown ones fail at `permissions.<index>`. */
export const permissionListSchema = z
  .array(z.string().refine((p) => known.has(p), { message: 'Unknown permission.' }))
  .max(known.size * 2)
  .transform((list) => [...new Set(list)].sort());

/** @deprecated N0 shape; use `updateRoleSchema` (`PATCH /roles/:id`). */
export const updateRolePermissionsSchema = z.object({ permissions: permissionListSchema });
export type UpdateRolePermissionsInput = z.input<typeof updateRolePermissionsSchema>;

const label = z.string().trim().min(1).max(60);
const optionalLabel = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.string().trim().max(60).nullable(),
);
const description = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.string().trim().max(500).nullable(),
);

/**
 * `POST /roles`: a custom staff role. `permissions` (an empty list is valid) or `copyFrom`
 * (duplicate an existing role's permissions) is required.
 */
export const createRoleSchema = z
  .object({
    labelAr: label,
    labelEn: optionalLabel.optional(),
    description: description.optional(),
    permissions: permissionListSchema.optional(),
    copyFrom: z.number().int().positive().nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.permissions === undefined && !v.copyFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['permissions'],
        message: 'Choose the permissions or a role to copy.',
      });
    }
  });
export type CreateRoleInput = z.input<typeof createRoleSchema>;

/** `PATCH /roles/:id`: labels and description; permissions for staff roles only. */
export const updateRoleSchema = z.object({
  labelAr: label.optional(),
  labelEn: optionalLabel.optional(),
  description: description.optional(),
  permissions: permissionListSchema.optional(),
});
export type UpdateRoleInput = z.input<typeof updateRoleSchema>;

/** `GET /roles/catalog`: one row per module, grouped like the sidebar, labels in both languages. */
export const permissionCatalogSchema = z.array(
  z.object({
    module: z.string(),
    labelAr: z.string(),
    labelEn: z.string(),
    group: z.string(),
    groupLabelAr: z.string(),
    groupLabelEn: z.string(),
    actions: z.array(
      z.object({
        key: z.string(),
        permission: z.string(),
        labelAr: z.string(),
        labelEn: z.string(),
        hintAr: z.string(),
        hintEn: z.string(),
      }),
    ),
  }),
);
export type PermissionCatalog = z.infer<typeof permissionCatalogSchema>;
