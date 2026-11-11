import {
  TICKET_CATEGORY_LABELS,
  TICKET_SUBCATEGORY_LABELS,
  type Me,
  type TicketCategory,
  type TicketDto,
  type TicketSubcategory,
} from '@qarabic/shared';
import type { UiLocale } from '@/lib/time';

/** Who the «تواصل معنا» hub is for: the parent's and the teacher's cards, or staff's three. */
export type Audience = 'parent' | 'teacher' | 'staff';

export const audienceOf = (me: Pick<Me, 'role'>): Audience =>
  me.role?.kind === 'parent' ? 'parent' : me.role?.kind === 'teacher' ? 'teacher' : 'staff';

/** May file «تواصل معنا» tickets. */
export const canReport = (me: Pick<Me, 'permissions'>) =>
  me.permissions.includes('feedback.request');

/** Has «طلباتي» (tickets or class requests). */
export const hasMyRequests = (me: Pick<Me, 'permissions'>) =>
  me.permissions.includes('feedback.request') ||
  me.permissions.includes('session_requests.request');

export function subcategoryLabel(sub: string | null, locale: UiLocale): string | null {
  if (!sub || !(sub in TICKET_SUBCATEGORY_LABELS)) return null;
  return TICKET_SUBCATEGORY_LABELS[sub as TicketSubcategory][locale];
}

/** «الحصص والمواعيد · مشكلة في حصة». */
export function topicLabel(
  t: Pick<TicketDto, 'category' | 'subcategory'>,
  locale: UiLocale,
): string {
  const category = TICKET_CATEGORY_LABELS[t.category as TicketCategory][locale];
  const sub = subcategoryLabel(t.subcategory, locale);
  return sub ? `${category} · ${sub}` : category;
}

/** «3 س 20 د» style duration for the SLA timer. */
export function durationParts(minutes: number): { d: number; h: number; m: number } {
  const total = Math.max(0, Math.round(minutes));
  return { d: Math.floor(total / 1440), h: Math.floor((total % 1440) / 60), m: total % 60 };
}
