import { SYSTEM_ROLES, type Role } from '@qarabic/shared';

/** Who did something on a class, as the viewer may see it. */
export interface ActorRef {
  id: number | null;
  name: string | null;
  role: string | null;
}

/**
 * The label for an event's or request's actor (P0-4, B118): the person's name when the viewer may
 * see it; for a parent or teacher the API sends staff by role only, so the role's name («مشرف
 * متابعة»), or «إدارة الأكاديمية» for a custom role; null actor = the system.
 */
export function actorLabel(
  actor: ActorRef | null,
  locale: 'ar' | 'en',
  words: { system: string; staff: string },
): string {
  if (!actor) return words.system;
  if (actor.name) return actor.name;
  const role = actor.role && actor.role in SYSTEM_ROLES ? SYSTEM_ROLES[actor.role as Role] : null;
  return role ? role[locale] : words.staff;
}
