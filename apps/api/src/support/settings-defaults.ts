/**
 * Support centre settings (docs/32 §5, D135), Laravel `Settings::DEFAULTS['support.*']`.
 * `GET/PUT /settings/support`; spread into `SETTING_DEFAULTS`.
 */
export const SUPPORT_SETTING_DEFAULTS = {
  /** Category (or "category.subcategory") → queue. */
  'support.queue_by_category': {
    classes: 'scheduling',
    teacher: 'scheduling',
    'teacher.teacher_feedback': 'complaints',
    billing: 'billing',
    technical: 'tech',
    suggestion: 'product',
    other: 'general',
  } as Record<string, string>,
  /** Queue → member roles. Holders of support.manage see and handle every queue. */
  'support.queue_members': {
    scheduling: ['monitor', 'csr', 'manager'],
    billing: ['billing', 'accounts'],
    complaints: ['admin', 'senior_manager'],
    tech: ['admin'],
    product: ['admin'],
    general: ['csr'],
  } as Record<string, string[]>,
  /** Tickets routed here are restricted (support.view_restricted + the reporter only). */
  'support.restricted_queues': ['complaints'] as string[],
  /** First-response target per queue, in working hours (12 = one working day). */
  'support.sla_hours': {
    scheduling: 4,
    billing: 12,
    complaints: 12,
    tech: 12,
    product: 60,
    general: 12,
  } as Record<string, number>,
  /** B76/D135: Saturday–Thursday 10:00–22:00 Cairo. ISO weekdays (1 = Monday … 7 = Sunday). */
  'support.working_hours': {
    timezone: 'Africa/Cairo',
    days: [6, 7, 1, 2, 3, 4],
    start: '10:00',
    end: '22:00',
  },
};
