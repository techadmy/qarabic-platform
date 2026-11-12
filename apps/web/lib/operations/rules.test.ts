import type { DashboardSummaryDto, NotificationDto } from '@qarabic/shared';
import { describe, expect, it } from 'vitest';
import { boardHref, isEmptyDashboard, isUrgent, visibleQueues } from './dashboard';
import { bellHref, bellText, kindsFor } from './notifications';

const n = (kind: string, event: string, data: Record<string, unknown>) =>
  ({
    id: 1,
    kind,
    event,
    data,
    readAt: null,
    createdAt: '2026-11-12T10:00:00Z',
  }) as NotificationDto;

const summary = (p: Partial<DashboardSummaryDto> = {}): DashboardSummaryDto => ({
  generatedAt: '2026-11-12T10:00:00Z',
  today: '2026-11-12',
  people: null,
  classesToday: null,
  queues: {
    myTasks: null,
    myOverdueTasks: null,
    sessionRequests: null,
    leaveRequests: null,
    proposedFines: null,
    newLeads: null,
    trialsToday: null,
    openTickets: null,
    openComplaints: null,
    unreadAnnouncements: null,
  },
  finance: null,
  ...p,
});

describe('dashboard rules', () => {
  it('shows only the queues the API sent, and flags urgent ones above zero', () => {
    const d = summary({ queues: { ...summary().queues, myTasks: 2, myOverdueTasks: 1 } });
    expect(visibleQueues(d)).toEqual(['myTasks', 'myOverdueTasks']);
    expect(isUrgent('myOverdueTasks', 1)).toBe(true);
    expect(isUrgent('myOverdueTasks', 0)).toBe(false);
    expect(isUrgent('myTasks', 5)).toBe(false);
  });

  it('stage tiles open the board filtered when the board has that tile', () => {
    expect(boardHref('taken')).toBe('/today?tile=taken');
    expect(boardHref('in_progress')).toBe('/today');
  });

  it('a viewer with nothing to see gets the empty state', () => {
    expect(isEmptyDashboard(summary())).toBe(true);
    expect(isEmptyDashboard(summary({ people: { families: 1, students: 1, teachers: 1 } }))).toBe(
      false,
    );
  });
});

describe('bell rows', () => {
  it('a class reminder opens the class sheet on the right page for the role', () => {
    const r = n('class_reminder', 'upcoming', {
      sessionId: 9,
      startsAt: '2026-11-12T15:00:00Z',
      student: 'Ali',
    });
    expect(bellHref(r, 'teacher')).toBe('/my-classes?session=9');
    expect(bellHref(r, 'parent')).toBe('/my-classes?session=9');
    expect(bellHref(r, 'staff')).toBe('/today?session=9');
    expect(bellText(r)).toEqual({
      kind: 'message',
      key: 'classReminder',
      values: { student: 'Ali', startsAt: '2026-11-12T15:00:00Z' },
    });
  });

  it('tasks, announcements and leads open their record', () => {
    expect(bellHref(n('task', 'assigned', { taskId: 7 }), 'staff')).toBe('/tasks/7');
    expect(bellHref(n('announcement', 'published', { announcementId: 3 }), 'teacher')).toBe(
      '/announcements#ann-3',
    );
    expect(bellHref(n('lead', 'assigned', { leadId: 4 }), 'staff')).toBe('/leads/4');
    expect(bellHref(n('something', 'else', {}), 'staff')).toBeNull();
    expect(bellText(n('task', 'unknown_event', {}))).toEqual({ kind: 'other' });
  });

  it('preference kinds follow the permissions', () => {
    expect(kindsFor({ permissions: ['tasks.view', 'announcements.view'] })).toEqual([
      'task',
      'announcement',
      'class_reminder',
    ]);
    expect(kindsFor({ permissions: ['leads.view'] })).toEqual(['class_reminder', 'lead']);
  });
});
