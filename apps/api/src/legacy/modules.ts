import { billingMapper } from './mappers/billing.js';
import { crmMapper } from './mappers/crm.js';
import { payrollMapper } from './mappers/payroll.js';
import { peopleMapper } from './mappers/people.js';
import { scheduleMapper } from './mappers/schedule.js';
import { sessionsMapper } from './mappers/sessions.js';
import { supportMapper } from './mappers/support.js';
import { teachingMapper } from './mappers/teaching.js';
import type { ModuleMapper } from './plan.js';

/** Load order (a module only references modules before it). */
export const MODULES: readonly ModuleMapper[] = [
  peopleMapper,
  scheduleMapper,
  sessionsMapper,
  teachingMapper,
  supportMapper,
  crmMapper,
  billingMapper,
  payrollMapper,
];

export const MODULE_NAMES = MODULES.map((m) => m.name);

/**
 * Laravel tables with no counterpart in the N1–N7 schema, and why (listed in every report with
 * their row counts). Framework/ephemeral tables are listed too so the count table is complete.
 */
export const NO_COUNTERPART: Record<string, string> = {
  announcements: 'staff announcements: no N1–N7 screen (roadmap item)',
  cities: 'reference list, not used by the new forms (country + IANA zone only)',
  states: 'reference list, not used by the new forms',
  country: 'reference list: read to turn country_id into an ISO code',
  time_zones: 'reference list: read to turn time_zone_id into an IANA zone',
  lessons: 'course syllabus (lessons/materials) is not part of N1–N7',
  materials: 'course files are not part of N1–N7',
  complains: 'pre-M4 complaints; support tickets replace them',
  tasks: 'old staff to-do per family: no N1–N7 counterpart',
  task_comments: 'old staff to-do comments',
  legacy_links: 'bookkeeping of the old PHP → Laravel import',
  zoom_webhook_events: 'Zoom webhook log (the new app has no Zoom driver yet, B7)',
  personal_access_tokens: 'Laravel API tokens: everyone signs in again',
  sessions: 'Laravel web sessions: everyone signs in again',
  password_reset_tokens: 'open reset links expire at cut-over',
  cache: 'framework cache',
  cache_locks: 'framework cache',
  jobs: 'queue (drained before cut-over)',
  job_batches: 'queue',
  failed_jobs: 'queue failures',
  migrations: 'Laravel migration log',
  quran_surahs: 'reference data the Postgres migration seeds (compared, not copied)',
  model_has_roles: 'Spatie role links (users.role_id is used)',
};

/** The modules to (re)load: the requested ones plus every module that depends on them. */
export function selectModules(only: string[] | null): ModuleMapper[] {
  if (!only || only.length === 0) return [...MODULES];
  const unknown = only.filter((o) => !MODULE_NAMES.includes(o));
  if (unknown.length)
    throw new Error(`Unknown module(s): ${unknown.join(', ')}. Known: ${MODULE_NAMES.join(', ')}`);
  const picked = new Set(only);
  let grew = true;
  while (grew) {
    grew = false;
    for (const m of MODULES) {
      if (!picked.has(m.name) && m.dependsOn.some((d) => picked.has(d))) {
        picked.add(m.name);
        grew = true;
      }
    }
  }
  return MODULES.filter((m) => picked.has(m.name));
}

/** Every Laravel table the importer reads. */
export function sourceTables(): string[] {
  return [...new Set([...MODULES.flatMap((m) => m.sources), ...Object.keys(NO_COUNTERPART)])];
}
