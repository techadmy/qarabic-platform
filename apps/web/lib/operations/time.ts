import type { TaskSubjectType } from '@qarabic/shared';
import { dateKeyIn, zonedInstant } from '@/lib/schedule-time';

/**
 * Pure rules of the operations screens (M8), kept out of the components so they are unit tested:
 * a task's due time is typed in the viewer's zone (D30) and stored as an instant.
 */

/** The time a due date gets when no time is chosen (end of the working day). */
export const DEFAULT_DUE_TIME = '17:00';

/** Date + optional `HH:MM` in `tz` → ISO instant; no date → null. */
export function dueInstant(date: string, time: string, tz: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return zonedInstant(date, /^\d{2}:\d{2}$/.test(time) ? time : DEFAULT_DUE_TIME, tz);
}

/** ISO instant → its date and wall time in `tz` (for editing). */
export function splitInstant(iso: string | null, tz: string): { date: string; time: string } {
  if (!iso) return { date: '', time: '' };
  const at = new Date(iso);
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: tz,
  }).format(at);
  return { date: dateKeyIn(tz, at), time };
}

/** The last minute of a date in `tz` (an announcement shown "until" that day). */
export function endOfDayInstant(date: string, tz: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? zonedInstant(date, '23:59', tz) : null;
}

/** Where a task's subject lives in the app. */
export function subjectHref(type: TaskSubjectType, id: number): string {
  switch (type) {
    case 'family':
      return `/families/${id}`;
    case 'student':
      return `/students/${id}`;
    case 'teacher':
      return `/teachers/${id}`;
    case 'lead':
      return `/leads/${id}`;
    case 'invoice':
      return `/invoices/${id}`;
    case 'session':
      return `/today?session=${id}`;
  }
}

/** «المعلمون، والمشرفون» / "Teachers and monitors": a list in the UI language. */
export function listText(items: string[], locale: 'ar' | 'en'): string {
  return new Intl.ListFormat(locale === 'ar' ? 'ar' : 'en', {
    style: 'long',
    type: 'conjunction',
  }).format(items);
}

/** A route id that is a positive integer, else null (`/tasks/abc` is not found). */
export function routeId(raw: string): number | null {
  return /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : null;
}
