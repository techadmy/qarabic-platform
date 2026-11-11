import { GROUPS, type Me, type PermissionCatalog, type RoleDto } from '@qarabic/shared';

/** One group of the matrix (docs/29 §3): modules in sidebar order. */
export type MatrixGroup = {
  group: string;
  labelAr: string;
  labelEn: string;
  modules: PermissionCatalog;
};

/** The catalog grouped like `GROUPS` (modules the catalog lacks are skipped; unknown groups last). */
export function groupCatalog(catalog: PermissionCatalog): MatrixGroup[] {
  const order = Object.keys(GROUPS);
  const groups = new Map<string, MatrixGroup>();
  for (const row of catalog) {
    const g = groups.get(row.group) ?? {
      group: row.group,
      labelAr: row.groupLabelAr,
      labelEn: row.groupLabelEn,
      modules: [],
    };
    g.modules.push(row);
    groups.set(row.group, g);
  }
  for (const g of groups.values()) {
    const moduleOrder = (GROUPS[g.group] ?? []) as string[];
    g.modules.sort((a, b) => moduleOrder.indexOf(a.module) - moduleOrder.indexOf(b.module));
  }
  return [...groups.values()].sort((a, b) => {
    const ia = order.indexOf(a.group);
    const ib = order.indexOf(b.group);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

/** Whether the viewer may tick this permission on this role (docs/29 §1: no escalation). */
export function canGrant(
  me: Pick<Me, 'permissions' | 'role'>,
  role: Pick<RoleDto, 'permissionsEditable'> | null,
  permission: string,
): boolean {
  if (role && !role.permissionsEditable) return false;
  return me.role?.kind === 'owner' || me.permissions.includes(permission);
}

/** Permissions added or removed compared to the saved list. */
export function changedCount(saved: readonly string[], current: readonly string[]): number {
  const a = new Set(saved);
  const b = new Set(current);
  let n = 0;
  for (const p of a) if (!b.has(p)) n++;
  for (const p of b) if (!a.has(p)) n++;
  return n;
}

/** Ticks or clears every grantable action of a module («الكل»). */
export function toggleModule(
  current: readonly string[],
  permissions: readonly string[],
  on: boolean,
  grantable: (p: string) => boolean,
): string[] {
  const set = new Set(current);
  for (const p of permissions) {
    if (!grantable(p)) continue;
    if (on) set.add(p);
    else set.delete(p);
  }
  return [...set].sort();
}

export function togglePermission(current: readonly string[], permission: string, on: boolean) {
  const set = new Set(current);
  if (on) set.add(permission);
  else set.delete(permission);
  return [...set].sort();
}
