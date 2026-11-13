import {
  LEAD_NOTIFICATION_LABELS,
  NOTIFICATION_KINDS,
  TASK_NOTIFICATION_EVENTS,
  TRIAL_NOTIFICATION_EVENTS,
  type LeadNotificationEvent,
  type NotificationDto,
  type NotificationKind,
} from '@qarabic/shared';

/** Rules of the bell rows and the notification preferences (M8), kept out of the components. */

const TASK_EVENTS = new Set<string>(TASK_NOTIFICATION_EVENTS);
const TRIAL_EVENTS = new Set<string>(TRIAL_NOTIFICATION_EVENTS);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' ? v : null);

/** What a bell row says, as a message key under `bell` and its values (or a ready lead text). */
export type BellText =
  | { kind: 'lead'; label: { ar: string; en: string }; name: string }
  | { kind: 'message'; key: string; values: Record<string, string> }
  | { kind: 'other' };

export function bellText(n: NotificationDto): BellText {
  if (n.kind === 'lead' && n.event in LEAD_NOTIFICATION_LABELS) {
    return {
      kind: 'lead',
      label: LEAD_NOTIFICATION_LABELS[n.event as LeadNotificationEvent],
      name: str(n.data.parentName),
    };
  }
  if (n.kind === 'task' && TASK_EVENTS.has(n.event)) {
    return {
      kind: 'message',
      key: `task.${n.event}`,
      values: { title: str(n.data.title), by: str(n.data.by) },
    };
  }
  if (n.kind === 'announcement') {
    return { kind: 'message', key: 'announcement', values: { title: str(n.data.title) } };
  }
  // T2: a trial booked for the teacher, or moved away from them (course and time, no family data).
  if (n.kind === 'trial' && TRIAL_EVENTS.has(n.event)) {
    return {
      kind: 'message',
      key: `trial.${n.event}`,
      values: { course: str(n.data.course), startsAt: str(n.data.startsAt) },
    };
  }
  if (n.kind === 'class_reminder') {
    return {
      kind: 'message',
      key: 'classReminder',
      values: { student: str(n.data.student), startsAt: str(n.data.startsAt) },
    };
  }
  return { kind: 'other' };
}

/**
 * Where a bell row leads: the record itself. A class opens in the class sheet (`?session=`) on the
 * viewer's own classes page (teachers, parents) or the Today board (staff); an announcement scrolls
 * to its card in the feed.
 */
export function bellHref(n: NotificationDto, roleKind: string | null | undefined): string | null {
  const portal = roleKind === 'teacher' || roleKind === 'parent';
  if (n.kind === 'lead' && num(n.data.leadId)) return `/leads/${num(n.data.leadId)}`;
  if (n.kind === 'task' && num(n.data.taskId)) return `/tasks/${num(n.data.taskId)}`;
  if (n.kind === 'announcement') {
    const id = num(n.data.announcementId);
    return id ? `/announcements#ann-${id}` : '/announcements';
  }
  if ((n.kind === 'class_reminder' || n.kind === 'trial') && num(n.data.sessionId)) {
    return `${portal ? '/my-classes' : '/today'}?session=${num(n.data.sessionId)}`;
  }
  return null;
}

/** The notification kinds a person can receive at all (no lead alerts without the CRM, …). */
export function kindsFor(me: { permissions: readonly string[] }): NotificationKind[] {
  const has = (p: string) => me.permissions.includes(p);
  return NOTIFICATION_KINDS.filter((k) =>
    k === 'task'
      ? has('tasks.view')
      : k === 'announcement'
        ? has('announcements.view')
        : k === 'lead'
          ? has('leads.view')
          : k === 'trial'
            ? has('sessions.conduct')
            : true,
  );
}
