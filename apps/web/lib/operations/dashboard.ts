import { BOARD_COUNTERS, type DashboardSummaryDto } from '@qarabic/shared';

/** Rules of the staff dashboard (M8 `GET /dashboard/summary`), kept out of the component. */
export type Queue = keyof DashboardSummaryDto['queues'];

/** Where each queue number leads (the list it counts). */
export const QUEUE_LINKS: Record<Queue, string> = {
  myTasks: '/tasks',
  myOverdueTasks: '/tasks?overdue=1',
  sessionRequests: '/requests',
  leaveRequests: '/attendance?tab=leave',
  proposedFines: '/fines',
  newLeads: '/leads',
  trialsToday: '/leads',
  openTickets: '/support',
  openComplaints: '/support',
  unreadAnnouncements: '/announcements?unread=1',
};

/** Queues that are a problem when not zero (flagged with an icon and words, not colour only). */
export const URGENT_QUEUES: ReadonlySet<Queue> = new Set(['myOverdueTasks', 'openComplaints']);

/** The queues this viewer may see (the API sends null for the others), in a fixed order. */
export const visibleQueues = (d: DashboardSummaryDto): Queue[] =>
  (Object.keys(QUEUE_LINKS) as Queue[]).filter((q) => d.queues[q] !== null);

export const isUrgent = (q: Queue, value: number | null) =>
  URGENT_QUEUES.has(q) && (value ?? 0) > 0;

/** Today board link for a stage: its tile when the board has one (`?tile=`), else the board. */
export const boardHref = (stage: string) =>
  (BOARD_COUNTERS as readonly string[]).includes(stage) ? `/today?tile=${stage}` : '/today';

/** Nothing to show at all (no queue, no classes, no people, no money): the empty state. */
export const isEmptyDashboard = (d: DashboardSummaryDto) =>
  visibleQueues(d).length === 0 && !d.classesToday && !d.people && !d.finance;
