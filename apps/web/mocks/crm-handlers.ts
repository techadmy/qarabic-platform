import {
  assignLeadSchema,
  bookTrialSchema,
  bulkAssignLeadsSchema,
  bulkLeadStatusSchema,
  convertLeadSchema,
  createLeadAccountSchema,
  createLeadSchema,
  isOpenLeadStatus,
  isParkedLeadStatus,
  LEAD_STATUSES,
  leadActivityInputSchema,
  leadStatusChangeSchema,
  OPEN_LEAD_STATUSES,
  publicTrialRequestSchema,
  referralSchema,
  trialOutcomeSchema,
  updateCrmSettingsSchema,
  updateLeadSchema,
  type LeadAllowedAction,
  type LeadDetailDto,
  type LeadDto,
  type LeadStatus,
  trialTeachersQuerySchema,
} from '@qarabic/shared';
import { http, HttpResponse, type HttpHandler } from 'msw';
import type { MockUser } from './data';
import { crmdb, CRM_STAFF, iso, staffRef, trialOf, type LeadRow } from './crm-db';
import { COURSES, db as people } from './people-db';
import { checkSlot, paginate, queryOf } from './schedule-handlers';
import { trialTeachers } from './trial-teachers';
import {
  apiError,
  currentUser,
  guard,
  notFound,
  unauthenticated,
  validationFailed,
} from './session';

/**
 * MSW handlers for N5 (apps/api README «Endpoints (N5)»): leads, the workbench actions, trial and
 * conversion, referrals, the CRM settings, the public trial form and the bell
 * (`/me/notifications`). Same permissions and refusal codes as the API. Fake data only.
 */
const API = '*/api/v1';
const has = (me: MockUser, p: string) => me.permissions.includes(p);

async function body(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

const digits = (v: string | null) => (v ?? '').replace(/\D/g, '');

function allowedActions(l: LeadRow, me: MockUser): LeadAllowedAction[] {
  if (!has(me, 'leads.manage')) return [];
  const open = isOpenLeadStatus(l.status);
  const scheduling = has(me, 'families.manage') && has(me, 'schedule.manage');
  const out: LeadAllowedAction[] = ['add_activity', 'edit'];
  if (l.assignedToId === null) out.push('assign_self');
  else if (l.assignedToId === me.id) out.push('release');
  if (has(me, 'leads.assign')) out.push('assign');
  if (l.status === 'new') out.push('mark_contacted');
  if (open) {
    out.push('lose', 'spam', 'job_applicant');
    if (!l.familyId && has(me, 'families.manage')) out.push('create_account');
    if (l.familyId && scheduling) out.push('book_trial', 'convert');
  }
  if (l.status === 'trial_scheduled' || l.status === 'trial_done') out.push('record_outcome');
  if (isParkedLeadStatus(l.status)) out.push('reopen');
  return out;
}

function firstResponseDue(l: LeadRow): string | null {
  if (l.firstResponseAt || l.status !== 'new') return null;
  return iso(Date.parse(l.createdAt) + crmdb.settings['crm.first_response_minutes'] * 60_000);
}

export function presentLead(l: LeadRow): LeadDto {
  const due = firstResponseDue(l);
  const trial = l.trials.find((t) => t.stage !== 'cancelled') ?? null;
  return {
    id: l.id,
    status: l.status,
    source: l.source,
    site: l.site,
    parentName: l.parentName,
    email: l.email,
    phone: l.phone,
    countryCode: l.countryCode,
    timezone: l.timezone,
    childrenCount: l.children.length,
    assignedTo: staffRef(l.assignedToId),
    nextFollowUpAt: l.nextFollowUpAt,
    lastContactedAt: l.lastContactedAt,
    createdAt: l.createdAt,
    familyId: l.familyId,
    trial: trial
      ? { sessionId: trial.sessionId, startsAt: trial.startsAt, stage: trial.stage }
      : null,
    spamScore: l.spamScore,
    submissions: l.submissions,
    firstResponseAt: l.firstResponseAt,
    contactAttempts: l.contactAttempts,
    firstResponseDueAt: due,
    firstResponseOverdue: !!due && Date.parse(due) < Date.now(),
  };
}

export function presentDetail(l: LeadRow, me: MockUser): LeadDetailDto {
  const others = crmdb.leads.filter((x) => x.id !== l.id);
  const dupLeads = others.filter(
    (x) =>
      (l.email && x.email === l.email) ||
      (digits(l.phone).length >= 6 && digits(x.phone) === digits(l.phone)),
  );
  return {
    ...presentLead(l),
    children: l.children,
    city: l.city,
    preferredLanguage: l.preferredLanguage,
    courseInterest: l.courseInterest,
    preferredTimes: l.preferredTimes,
    preferredSchedule: l.preferredSchedule,
    teacherGenderPref: l.teacherGenderPref,
    heardFrom: l.heardFrom,
    unansweredAttempts: l.unansweredAttempts,
    suggestLostNoResponse:
      isOpenLeadStatus(l.status) &&
      l.unansweredAttempts >= crmdb.settings['crm.unanswered_attempts_suggest_lost'],
    message: l.message,
    family: l.familyId
      ? {
          id: l.familyId,
          status: l.familyStatus ?? 'trial',
          name: l.familyName,
          timezone: l.timezone,
        }
      : null,
    referralFamily: l.referralFamily,
    trialOutcome: l.trialOutcome,
    lostReason: l.lostReason,
    statusNote: l.statusNote,
    spamFlags: l.spamFlags,
    convertedAt: l.convertedAt,
    convertedBy: staffRef(l.convertedById),
    utm: l.utm,
    activities: l.activities,
    trials: l.trials,
    students: l.students,
    duplicates: {
      leads: dupLeads.map((x) => ({
        id: x.id,
        parentName: x.parentName,
        status: x.status,
        createdAt: x.createdAt,
      })),
      families: [],
    },
    allowedActions: allowedActions(l, me),
  };
}

function log(
  l: LeadRow,
  me: MockUser | null,
  type: LeadDetailDto['activities'][number]['type'],
  extra: Partial<LeadDetailDto['activities'][number]> = {},
) {
  l.activities.unshift({
    id: crmdb.nextId.activity++,
    type,
    body: null,
    callResult: null,
    meta: {},
    user: me ? { id: me.id, name: me.name } : null,
    createdAt: iso(Date.now()),
    ...extra,
  });
}

function notify(userId: number, event: string, l: LeadRow) {
  crmdb.notifications.unshift({
    id: Math.max(0, ...crmdb.notifications.map((n) => n.id)) + 1,
    userId,
    kind: 'lead',
    event,
    data: { leadId: l.id, parentName: l.parentName },
    readAt: null,
    createdAt: iso(Date.now()),
  });
}

const leadOr404 = (id: unknown) => crmdb.leads.find((l) => l.id === Number(id)) ?? null;
const invalidTransition = () =>
  apiError(422, 'invalid_transition', 'This lead cannot move to that status.');

function setStatus(
  l: LeadRow,
  to: LeadStatus,
  me: MockUser,
  extra: { lostReason?: string | null; note?: string | null } = {},
) {
  const from = l.status;
  l.status = to;
  if (to === 'lost') l.lostReason = (extra.lostReason ?? null) as LeadRow['lostReason'];
  if (to !== 'lost') l.lostReason = null;
  l.statusNote = extra.note ?? null;
  if (to === 'lost' || to === 'spam' || to === 'job_applicant') {
    for (const t of l.trials) if (t.stage === 'scheduled') t.stage = 'cancelled';
  }
  log(l, me, 'status_changed', { meta: { from, to }, body: extra.note ?? null });
}

function canWorkLeads(userId: number) {
  return CRM_STAFF.some((s) => s.id === userId);
}

export const crmHandlers: HttpHandler[] = [
  // ---------------------------------------------------------------- queue
  http.get(`${API}/leads/summary`, ({ request }) => {
    const g = guard(request, 'leads.view');
    if ('error' in g) return g.error;
    const tz = queryOf(request).tz ?? g.me.timezone;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    const dayOf = (at: string) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(at));
    const month = today.slice(0, 7);
    const open = crmdb.leads.filter((l) => isOpenLeadStatus(l.status));
    const rows = open.map(presentLead);
    return HttpResponse.json({
      data: {
        date: today,
        timezone: tz,
        new: open.filter((l) => l.status === 'new').length,
        followUpsDue: open.filter((l) => l.nextFollowUpAt && dayOf(l.nextFollowUpAt) <= today)
          .length,
        trialsToday: crmdb.leads.filter((l) =>
          l.trials.some((t) => t.stage === 'scheduled' && dayOf(t.startsAt) === today),
        ).length,
        awaitingOutcome: open.filter(
          (l) =>
            l.status === 'trial_scheduled' &&
            l.trials.some((t) => Date.parse(t.startsAt) < Date.now()),
        ).length,
        convertedThisMonth: crmdb.leads.filter(
          (l) => l.convertedAt && dayOf(l.convertedAt).startsWith(month),
        ).length,
        lostThisMonth: crmdb.leads.filter(
          (l) => l.status === 'lost' && dayOf(l.createdAt).startsWith(month),
        ).length,
        openTotal: open.length,
        unassigned: open.filter((l) => l.assignedToId === null).length,
        uncontacted: rows.filter((l) => l.status === 'new' && !l.firstResponseAt).length,
        firstResponseOverdue: rows.filter((l) => l.firstResponseOverdue).length,
      },
    });
  }),

  http.get(`${API}/leads/funnel`, ({ request }) => {
    const g = guard(request, 'leads.view');
    if ('error' in g) return g.error;
    const q = queryOf(request);
    const to = q.to ?? new Date().toISOString().slice(0, 10);
    const from = q.from ?? `${to.slice(0, 7)}-01`;
    const inRange = crmdb.leads.filter(
      (l) => l.createdAt.slice(0, 10) >= from && l.createdAt.slice(0, 10) <= to,
    );
    const row = (ls: LeadRow[]) => ({
      created: ls.length,
      contacted: ls.filter((l) => l.firstResponseAt).length,
      trial: ls.filter((l) => l.trials.length).length,
      converted: ls.filter((l) => l.status === 'converted').length,
      lost: ls.filter((l) => l.status === 'lost').length,
      spam: ls.filter((l) => l.status === 'spam').length,
    });
    const sources = [...new Set(inRange.map((l) => l.source))];
    const owners = [...new Set(inRange.map((l) => l.assignedToId))];
    return HttpResponse.json({
      data: {
        from,
        to,
        total: row(inRange),
        bySource: sources.map((s) => ({
          source: s,
          ...row(inRange.filter((l) => l.source === s)),
        })),
        byAssignee: owners.map((u) => ({
          user: staffRef(u),
          ...row(inRange.filter((l) => l.assignedToId === u)),
        })),
      },
    });
  }),

  http.get(`${API}/leads/assignees`, ({ request }) => {
    const g = guard(request, 'leads.view');
    if ('error' in g) return g.error;
    return HttpResponse.json({
      data: CRM_STAFF.map((s) => ({
        id: s.id,
        name: s.name,
        role: s.role,
        openCount: crmdb.leads.filter((l) => l.assignedToId === s.id && isOpenLeadStatus(l.status))
          .length,
      })),
    });
  }),

  http.get(`${API}/leads`, ({ request }) => {
    const g = guard(request, 'leads.view');
    if ('error' in g) return g.error;
    const q = queryOf(request);
    const term = (q.q ?? '').trim().toLowerCase();
    const tz = q.tz ?? g.me.timezone;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    const filtered = crmdb.leads
      .filter((l) => {
        if (term) {
          const d = term.replace(/\D/g, '');
          const hit =
            l.parentName.toLowerCase().includes(term) ||
            (l.email ?? '').includes(term) ||
            (d.length >= 4 && digits(l.phone).includes(d)) ||
            String(l.id) === term;
          if (!hit) return false;
        }
        if (q.assigned === 'me' && l.assignedToId !== g.me.id) return false;
        if (q.assigned === 'none' && l.assignedToId !== null) return false;
        if (q.assigned && /^\d+$/.test(q.assigned) && l.assignedToId !== Number(q.assigned))
          return false;
        if (q.source && l.source !== q.source) return false;
        if (
          q.followUp === 'due' &&
          !(
            l.nextFollowUpAt &&
            new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(l.nextFollowUpAt)) <=
              today
          )
        )
          return false;
        if (
          (q.uncontacted === '1' || q.uncontacted === 'true') &&
          !(l.status === 'new' && !l.firstResponseAt)
        )
          return false;
        return true;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const counts: Record<string, number> = { all: filtered.length };
    for (const s of LEAD_STATUSES) counts[s] = filtered.filter((l) => l.status === s).length;
    counts.open = filtered.filter((l) => isOpenLeadStatus(l.status)).length;
    const status = q.status ?? 'open';
    const rows = filtered.filter((l) =>
      status === 'all'
        ? true
        : status === 'open'
          ? (OPEN_LEAD_STATUSES as readonly string[]).includes(l.status)
          : l.status === status,
    );
    return HttpResponse.json(
      paginate(rows.map(presentLead), Number(q.page ?? 1), Number(q.perPage ?? 25), counts),
    );
  }),

  http.post(`${API}/leads/bulk/assign`, async ({ request }) => {
    const g = guard(request, 'leads.assign');
    if ('error' in g) return g.error;
    const parsed = bulkAssignLeadsSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const updated: number[] = [];
    const failed: { id: number; code: string }[] = [];
    for (const id of parsed.data.ids) {
      const l = leadOr404(id);
      if (!l) failed.push({ id, code: 'not_found' });
      else if (!isOpenLeadStatus(l.status)) failed.push({ id, code: 'invalid_transition' });
      else {
        l.assignedToId = parsed.data.userId;
        log(l, g.me, 'assigned', { meta: { to: staffRef(parsed.data.userId)?.name ?? null } });
        if (parsed.data.userId) notify(parsed.data.userId, 'assigned', l);
        updated.push(id);
      }
    }
    return HttpResponse.json({ data: { updated, failed } });
  }),

  http.post(`${API}/leads/bulk/status`, async ({ request }) => {
    const g = guard(request, 'leads.manage');
    if ('error' in g) return g.error;
    const parsed = bulkLeadStatusSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const updated: number[] = [];
    const failed: { id: number; code: string }[] = [];
    for (const id of parsed.data.ids) {
      const l = leadOr404(id);
      if (!l) failed.push({ id, code: 'not_found' });
      else if (!isOpenLeadStatus(l.status)) failed.push({ id, code: 'invalid_transition' });
      else {
        setStatus(l, parsed.data.status, g.me, parsed.data);
        updated.push(id);
      }
    }
    return HttpResponse.json({ data: { updated, failed } });
  }),

  http.post(`${API}/leads`, async ({ request }) => {
    const g = guard(request, 'leads.manage');
    if ('error' in g) return g.error;
    const parsed = createLeadSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const v = parsed.data;
    const assignee = v.assignedTo === undefined ? g.me.id : v.assignedTo;
    if (assignee !== null && assignee !== g.me.id && !has(g.me, 'leads.assign')) {
      return apiError(403, 'forbidden', 'Forbidden.');
    }
    const id = crmdb.nextId.lead++;
    const row: LeadRow = {
      id,
      status: 'new',
      source: v.source,
      site: null,
      parentName: v.parentName,
      email: v.email ?? null,
      phone: v.phone ?? null,
      countryCode: v.countryCode ?? null,
      timezone: v.timezone ?? g.me.timezone,
      city: v.city ?? null,
      preferredLanguage: v.preferredLanguage ?? null,
      children: (v.children ?? []).map((c) => ({
        ...(c.name ? { name: c.name } : {}),
        ...(c.age ? { age: c.age } : {}),
        ...(c.gender ? { gender: c.gender } : {}),
        ...(c.courseId ? { courseId: c.courseId } : {}),
      })),
      courseInterest: v.courseInterest ?? null,
      preferredTimes: v.preferredTimes ?? null,
      preferredSchedule: null,
      teacherGenderPref: null,
      heardFrom: null,
      message: v.message ?? null,
      assignedToId: assignee,
      nextFollowUpAt: v.nextFollowUpAt ?? null,
      lastContactedAt: null,
      firstResponseAt: null,
      contactAttempts: 0,
      unansweredAttempts: 0,
      createdAt: iso(Date.now()),
      familyId: null,
      familyName: null,
      familyStatus: null,
      referralFamily: null,
      trialOutcome: null,
      lostReason: null,
      statusNote: null,
      spamScore: 0,
      spamFlags: [],
      submissions: 1,
      convertedAt: null,
      convertedById: null,
      utm: null,
      activities: [],
      trials: [],
      students: [],
    };
    log(row, g.me, 'created', { meta: { source: v.source } });
    crmdb.leads.unshift(row);
    if (assignee && assignee !== g.me.id) notify(assignee, 'assigned', row);
    return HttpResponse.json({ data: presentDetail(row, g.me) }, { status: 201 });
  }),

  // ---------------------------------------------------------------- workbench
  http.get(`${API}/leads/:id`, ({ request, params }) => {
    const g = guard(request, 'leads.view');
    if ('error' in g) return g.error;
    const l = leadOr404(params.id);
    return l ? HttpResponse.json({ data: presentDetail(l, g.me) }) : notFound();
  }),

  http.patch(`${API}/leads/:id`, async ({ request, params }) => {
    const g = guard(request, 'leads.manage');
    if ('error' in g) return g.error;
    const l = leadOr404(params.id);
    if (!l) return notFound();
    const parsed = updateLeadSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    for (const [k, v] of Object.entries(parsed.data)) {
      if (v === undefined) continue;
      if (k === 'children') {
        l.children = (v as LeadRow['children']).map((c) =>
          Object.fromEntries(Object.entries(c).filter(([, x]) => x !== null && x !== undefined)),
        );
      } else (l as unknown as Record<string, unknown>)[k] = v;
    }
    return HttpResponse.json({ data: presentDetail(l, g.me) });
  }),

  http.post(`${API}/leads/:id/activities`, async ({ request, params }) => {
    const g = guard(request, 'leads.manage');
    if ('error' in g) return g.error;
    const l = leadOr404(params.id);
    if (!l) return notFound();
    const parsed = leadActivityInputSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const v = parsed.data;
    const contact = v.type !== 'note';
    if (contact) {
      l.contactAttempts += 1;
      l.lastContactedAt = iso(Date.now());
      l.firstResponseAt ??= iso(Date.now());
      if (v.type === 'call' && v.callResult !== 'reached') l.unansweredAttempts += 1;
      else l.unansweredAttempts = 0;
      if (l.status === 'new') setStatus(l, 'contacted', g.me);
    }
    if (v.nextFollowUpAt !== undefined) l.nextFollowUpAt = v.nextFollowUpAt;
    log(l, g.me, v.type, { body: v.body ?? null, callResult: v.callResult ?? null });
    return HttpResponse.json({ data: l.activities[0] }, { status: 201 });
  }),

  http.post(`${API}/leads/:id/assign`, async ({ request, params }) => {
    const g = guard(request, 'leads.manage');
    if ('error' in g) return g.error;
    const l = leadOr404(params.id);
    if (!l) return notFound();
    const parsed = assignLeadSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const to = parsed.data.userId;
    const own =
      (to === g.me.id && l.assignedToId === null) || (to === null && l.assignedToId === g.me.id);
    if (!own && !has(g.me, 'leads.assign')) return apiError(403, 'forbidden', 'Forbidden.');
    if (to !== null && !canWorkLeads(to)) {
      return apiError(422, 'validation_failed', 'The given data was invalid.', {
        userId: ['This person cannot work leads.'],
      });
    }
    l.assignedToId = to;
    log(l, g.me, 'assigned', { meta: { to: staffRef(to)?.name ?? null } });
    if (to && to !== g.me.id) notify(to, 'assigned', l);
    return HttpResponse.json({ data: presentDetail(l, g.me) });
  }),

  http.post(`${API}/leads/:id/status`, async ({ request, params }) => {
    const g = guard(request, 'leads.manage');
    if ('error' in g) return g.error;
    const l = leadOr404(params.id);
    if (!l) return notFound();
    const parsed = leadStatusChangeSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const v = parsed.data;
    if (v.status === 'reopen') {
      if (!isParkedLeadStatus(l.status)) return invalidTransition();
      setStatus(l, l.trials.length ? 'contacted' : l.firstResponseAt ? 'contacted' : 'new', g.me);
    } else if (v.status === 'contacted') {
      if (l.status !== 'new') return invalidTransition();
      setStatus(l, 'contacted', g.me);
    } else {
      if (!isOpenLeadStatus(l.status)) return invalidTransition();
      setStatus(l, v.status, g.me, v);
    }
    return HttpResponse.json({ data: presentDetail(l, g.me) });
  }),

  http.post(`${API}/leads/:id/account`, async ({ request, params }) => {
    const g = guard(request, 'leads.manage', 'families.manage');
    if ('error' in g) return g.error;
    const l = leadOr404(params.id);
    if (!l) return notFound();
    if (l.familyId) return apiError(409, 'already_has_family', 'This lead already has a family.');
    const parsed = createLeadAccountSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const v = parsed.data;
    if (!v.familyId && v.email && people.families.some((f) => f.email === v.email)) {
      const f = people.families.find((x) => x.email === v.email)!;
      return apiError(
        422,
        'email_taken',
        'A login already uses this email.',
        { email: ['A login already uses this email.'] },
        { familyId: f.id },
      );
    }
    l.familyId = v.familyId ?? crmdb.nextId.family++;
    l.familyName = v.parentName ?? l.parentName;
    l.familyStatus = 'trial';
    if (v.timezone) l.timezone = v.timezone;
    l.students = v.children.map((c) => ({
      id: crmdb.nextId.student++,
      name: c.name,
      age: c.age ?? null,
      gender: c.gender ?? null,
      courseId: c.courseId,
      enrollments: [],
    }));
    log(l, g.me, 'account_created', { meta: { familyId: l.familyId } });
    return HttpResponse.json({ data: presentDetail(l, g.me), meta: {} }, { status: 201 });
  }),

  http.get(`${API}/leads/:id/trial-teachers`, ({ request, params }) => {
    const g = guard(request, 'leads.manage', 'schedule.manage');
    if ('error' in g) return g.error;
    const l = leadOr404(params.id);
    if (!l) return notFound();
    const parsed = trialTeachersQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const q = parsed.data;
    const tz = q.timezone ?? l.timezone;
    const startsAt = zonedUtc(q.localDate, q.localTime, tz);
    return HttpResponse.json(
      trialTeachers(l, { ...q, timezone: tz, durationMinutes: q.durationMinutes ?? 30 }, startsAt),
    );
  }),

  http.post(`${API}/leads/:id/trials`, async ({ request, params }) => {
    const g = guard(request, 'leads.manage', 'schedule.manage');
    if ('error' in g) return g.error;
    const l = leadOr404(params.id);
    if (!l) return notFound();
    if (!l.familyId) return apiError(422, 'no_family', 'Create the family account first.');
    const parsed = bookTrialSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const v = parsed.data;
    const student = l.students.find((s) => s.id === v.studentId);
    if (!student) {
      return apiError(422, 'validation_failed', 'The given data was invalid.', {
        studentId: ['Choose a child of this family.'],
      });
    }
    const tz = v.timezone ?? l.timezone;
    const at = Date.parse(zonedUtc(v.localDate, v.localTime, tz));
    if (at < Date.now()) {
      return apiError(422, 'validation_failed', 'The given data was invalid.', {
        localTime: ['The time is in the past.'],
      });
    }
    const weekday = ((new Date(`${v.localDate}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    const check = checkSlot({
      studentId: v.studentId,
      teacherId: v.teacherId,
      weekday,
      localStartTime: v.localTime,
      durationMinutes: v.durationMinutes ?? 30,
      timezone: tz,
      validFrom: v.localDate,
    });
    if (check.conflicts.length) {
      return apiError(409, 'schedule_conflict', 'The class clashes.', undefined, check);
    }
    // T2: an ineligible teacher needs a reason (busy is a clash, refused above).
    const option = trialTeachers(
      l,
      {
        studentId: v.studentId,
        courseId: v.courseId,
        localDate: v.localDate,
        localTime: v.localTime,
        timezone: tz,
        durationMinutes: v.durationMinutes ?? 30,
      },
      new Date(at).toISOString(),
    ).data.ineligible.find((o) => o.teacher.id === v.teacherId);
    if (option && !v.overrideReason) {
      return apiError(
        422,
        'teacher_not_eligible',
        'The teacher is not eligible for this trial.',
        { overrideReason: ['Give a reason to book this teacher.'] },
        { reasons: option.reasons },
      );
    }
    const missing = check.warnings.filter((w) => !v.acknowledgeWarnings?.includes(w.code));
    if (missing.length) {
      return apiError(
        422,
        'warnings_not_acknowledged',
        'Acknowledge the warnings.',
        undefined,
        check,
      );
    }
    for (const t of l.trials) if (t.stage === 'scheduled') t.stage = 'cancelled';
    const teacher = people.teachers.find((x) => x.id === v.teacherId);
    const trial = trialOf(
      crmdb.nextId.session++,
      { ...student, courseId: v.courseId },
      at,
      tz,
      'trial_scheduled',
      {
        id: v.teacherId,
        name: teacher?.name ?? 'Teacher',
        timezone: teacher?.timezone ?? 'Africa/Cairo',
      },
      v.durationMinutes ?? 30,
    );
    const course = COURSES.find((c) => c.id === v.courseId);
    if (course) trial.course = { id: course.id, nameAr: course.nameAr, nameEn: course.nameEn };
    l.trials.unshift(trial);
    if (isOpenLeadStatus(l.status)) l.status = 'trial_scheduled';
    log(l, g.me, 'trial_booked', { meta: { sessionId: trial.sessionId } });
    return HttpResponse.json(
      {
        data: presentDetail(l, g.me),
        meta: {
          trial: {
            sessionId: trial.sessionId,
            startsAt: trial.startsAt,
            durationMinutes: trial.durationMinutes,
            stage: trial.stage,
            familyZone: trial.familyZone,
            teacherZone: trial.teacherZone,
            familyLocal: trial.familyLocal,
            teacherLocal: trial.teacherLocal,
          },
        },
      },
      { status: 201 },
    );
  }),

  http.post(`${API}/leads/:id/trial-outcome`, async ({ request, params }) => {
    const g = guard(request, 'leads.manage');
    if ('error' in g) return g.error;
    const l = leadOr404(params.id);
    if (!l) return notFound();
    if (l.status !== 'trial_scheduled' && l.status !== 'trial_done') return invalidTransition();
    const parsed = trialOutcomeSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const v = parsed.data;
    l.trialOutcome = v.outcome;
    log(l, g.me, 'trial_outcome', { meta: { outcome: v.outcome }, body: v.note ?? null });
    if (v.outcome === 'interested') {
      for (const t of l.trials) if (t.stage === 'scheduled') t.stage = 'completed';
      l.status = 'trial_done';
    } else if (v.outcome === 'no_show') {
      for (const t of l.trials) if (t.stage === 'scheduled') t.stage = 'absent';
      l.status = 'contacted';
    } else
      setStatus(l, 'lost', g.me, { lostReason: v.lostReason ?? 'not_interested', note: v.note });
    return HttpResponse.json({ data: presentDetail(l, g.me), meta: {} });
  }),

  http.post(`${API}/leads/:id/convert`, async ({ request, params }) => {
    const g = guard(request, 'leads.manage', 'families.manage', 'schedule.manage');
    if ('error' in g) return g.error;
    const l = leadOr404(params.id);
    if (!l) return notFound();
    if (!l.familyId) return apiError(422, 'no_family', 'Create the family account first.');
    if (!isOpenLeadStatus(l.status)) return invalidTransition();
    const parsed = convertLeadSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const ids: number[] = [];
    for (const s of parsed.data.students) {
      const st = l.students.find((x) => x.id === s.studentId);
      if (!st) return notFound();
      for (const slot of s.slots) {
        const check = checkSlot({
          studentId: s.studentId,
          teacherId: s.teacherId,
          weekday: slot.weekday,
          localStartTime: slot.localStartTime,
          durationMinutes: s.sessionMinutes ?? 30,
          timezone: l.timezone,
          validFrom: s.startsOn,
        });
        if (check.conflicts.length) {
          return apiError(409, 'schedule_conflict', 'The class clashes.', undefined, check);
        }
      }
    }
    for (const s of parsed.data.students) {
      const st = l.students.find((x) => x.id === s.studentId)!;
      const id = 7000 + st.id;
      st.enrollments = [
        { id, kind: 'regular', courseId: s.courseId, teacherId: s.teacherId, status: 'active' },
      ];
      ids.push(id);
    }
    l.status = 'converted';
    l.familyStatus = 'regular';
    l.convertedAt = iso(Date.now());
    l.convertedById = g.me.id;
    log(l, g.me, 'converted', { meta: { enrollmentIds: ids } });
    return HttpResponse.json({ data: presentDetail(l, g.me), meta: { enrollmentIds: ids } });
  }),

  // ---------------------------------------------------------------- referrals, settings
  http.post(`${API}/me/referrals`, async ({ request }) => {
    const g = guard(request, 'leads.refer');
    if ('error' in g) return g.error;
    const parsed = referralSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    crmdb.referrals += 1;
    return HttpResponse.json({ data: { received: true } }, { status: 201 });
  }),

  http.get(`${API}/settings/crm`, ({ request }) => {
    const g = guard(request, 'settings.view');
    if ('error' in g) return g.error;
    return HttpResponse.json({ data: crmdb.settings });
  }),

  http.put(`${API}/settings/crm`, async ({ request }) => {
    const g = guard(request, 'settings.manage');
    if ('error' in g) return g.error;
    const parsed = updateCrmSettingsSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    crmdb.settings = { ...crmdb.settings, ...parsed.data };
    return HttpResponse.json({ data: crmdb.settings });
  }),

  // ---------------------------------------------------------------- the bell
  http.get(`${API}/me/notifications`, ({ request }) => {
    const me = currentUser();
    if (!me) return unauthenticated();
    const q = queryOf(request);
    const mine = crmdb.notifications
      .filter((n) => n.userId === me.id && (q.unread !== '1' || !n.readAt))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return HttpResponse.json({
      data: mine.slice(0, Number(q.limit ?? 20)).map(({ userId: _u, ...n }) => n),
      meta: { unread: mine.filter((n) => !n.readAt).length },
    });
  }),

  http.post(`${API}/me/notifications/read-all`, ({ request }) => {
    const g = guard(request);
    if ('error' in g) return g.error;
    let updated = 0;
    for (const n of crmdb.notifications) {
      if (n.userId === g.me.id && !n.readAt) {
        n.readAt = iso(Date.now());
        updated++;
      }
    }
    return HttpResponse.json({ data: { updated } });
  }),

  http.post(`${API}/me/notifications/:id/read`, ({ request, params }) => {
    const g = guard(request);
    if ('error' in g) return g.error;
    const n = crmdb.notifications.find((x) => x.id === Number(params.id) && x.userId === g.me.id);
    if (!n) return notFound();
    n.readAt ??= iso(Date.now());
    return new HttpResponse(null, { status: 204 });
  }),

  // ---------------------------------------------------------------- public (no login, no CSRF)
  http.get(`${API}/public/courses`, () =>
    HttpResponse.json({
      data: COURSES.filter((c) => c.isActive).map(({ id, nameAr, nameEn, category }) => ({
        id,
        nameAr,
        nameEn,
        category,
      })),
    }),
  ),

  http.post(`${API}/public/trial-requests`, async ({ request }) => {
    const input = (await body(request)) as Record<string, unknown>;
    if (typeof input.website === 'string' && input.website.trim()) {
      // Honeypot: the same answer as a success, nothing stored.
      return HttpResponse.json({ success: true, data: null });
    }
    const { website: _w, ...rest } = input;
    const parsed = publicTrialRequestSchema.safeParse(rest);
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const v = parsed.data;
    const id = crmdb.nextId.lead++;
    const row: LeadRow = {
      ...crmdb.leads[0]!,
      id,
      status: 'new',
      source: 'web_form',
      site: 'app_trial',
      parentName: v.parentName,
      email: v.email,
      phone: v.phone,
      countryCode: v.countryCode,
      timezone: v.timezone,
      children: v.children,
      preferredSchedule: {
        days: v.preferredDays,
        periods: v.preferredPeriods,
        note: v.preferredNote ?? undefined,
      },
      teacherGenderPref: v.teacherGenderPref,
      heardFrom: v.heardFrom ?? null,
      message: v.message ?? null,
      assignedToId: 21,
      createdAt: iso(Date.now()),
      firstResponseAt: null,
      contactAttempts: 0,
      unansweredAttempts: 0,
      nextFollowUpAt: null,
      lastContactedAt: null,
      familyId: null,
      students: [],
      trials: [],
      activities: [],
    };
    log(row, null, 'created', { meta: { source: 'web_form' } });
    crmdb.leads.unshift(row);
    return HttpResponse.json({ data: { received: true } }, { status: 201 });
  }),
];

/** The instant of a wall time on a date in `tz` (UTC ISO). */
export function zonedUtc(date: string, time: string, tz: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = time.split(':').map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, h!, min!);
  const offset = (at: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(at));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return (
      Date.UTC(
        get('year'),
        get('month') - 1,
        get('day'),
        get('hour'),
        get('minute'),
        get('second'),
      ) -
      Math.floor(at / 1000) * 1000
    );
  };
  let at = guess - offset(guess);
  at = guess - offset(at);
  return new Date(at).toISOString();
}
