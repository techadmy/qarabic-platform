import {
  ACTIVE_STATUSES,
  ACTIVE_STATUSES_NEEDING_REASON,
  ACTIVE_STATUS_LABELS,
  FAMILY_STATUSES,
  FAMILY_STATUSES_NEEDING_REASON,
  FAMILY_STATUS_LABELS,
} from '@qarabic/shared';
import type { PeopleKind } from '@/lib/api/people';

/** What differs between the four People record types (statuses, permissions, routes). */
export interface KindConfig {
  kind: PeopleKind;
  /** Message namespace under `people.kinds`. */
  statuses: readonly string[];
  needsReason: readonly string[];
  /** Going back to these is low-risk: the change gets an 8 s Undo toast (docs/28 §2). */
  reversible: readonly string[];
  /** The status a record must have before it can be archived (D128). */
  outOfService: string;
  view: string;
  manage: string;
  href: string;
  labels: Record<string, { ar: string; en: string }>;
}

const active = {
  statuses: ACTIVE_STATUSES,
  needsReason: ACTIVE_STATUSES_NEEDING_REASON,
  reversible: ['active'],
  outOfService: 'inactive',
  labels: ACTIVE_STATUS_LABELS,
};

export const KINDS: Record<PeopleKind, KindConfig> = {
  families: {
    kind: 'families',
    statuses: FAMILY_STATUSES,
    needsReason: FAMILY_STATUSES_NEEDING_REASON,
    reversible: ['regular'],
    outOfService: 'deactivated',
    view: 'families.view',
    manage: 'families.manage',
    href: '/families',
    labels: FAMILY_STATUS_LABELS,
  },
  students: {
    kind: 'students',
    ...active,
    view: 'families.view',
    manage: 'families.manage',
    href: '/students',
  },
  teachers: {
    kind: 'teachers',
    ...active,
    view: 'staff.view',
    manage: 'staff.manage',
    href: '/teachers',
  },
  staff: { kind: 'staff', ...active, view: 'users.view', manage: 'users.manage', href: '/staff' },
};

export function statusLabel(kind: PeopleKind, status: string, locale: 'ar' | 'en'): string {
  return KINDS[kind].labels[status]?.[locale] ?? status;
}
