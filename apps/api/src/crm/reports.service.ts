import { HttpStatus, Injectable } from '@nestjs/common';
import {
  CONTACT_ACTIVITY_TYPES,
  isOpenLeadStatus,
  isParkedLeadStatus,
  LEAD_STATUSES,
  type LeadActivityDto,
  type LeadAllowedAction,
  type LeadAssigneeDto,
  type LeadChildDto,
  type LeadDetailDto,
  type LeadDto,
  type LeadFunnelDto,
  type leadListQuerySchema,
  type LeadSummaryDto,
  type LeadTrialDto,
  OPEN_LEAD_STATUSES,
  type Paginated,
} from '@qarabic/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { notFound } from '../common/errors.js';
import { pageArgs, pageMeta } from '../common/pagination.js';
import { contains, searchId } from '../common/search.js';
import type { Lead, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { addDays, isValidZone, isoZ, local, toUtc } from '../schedule/time.js';
import { SettingsService, type SettingsMap } from '../settings/settings.service.js';
import { crmError } from './errors.js';
import { usersWithPermission } from './notifier.js';
import { WorkingHours } from './working-hours.js';

const OFF_STAGES = ['cancelled', 'moved_out'] as const;
const DAY = 86_400_000;

const leadInclude = {
  assignedTo: { select: { id: true, name: true } },
  convertedBy: { select: { id: true, name: true } },
  family: { select: { id: true, status: true, timezone: true, user: { select: { name: true } } } },
  referralFamily: { select: { id: true, user: { select: { name: true } } } },
} satisfies Prisma.LeadInclude;
type LeadRow = Prisma.LeadGetPayload<{ include: typeof leadInclude }>;

const trialInclude = {
  student: { select: { id: true, name: true, family: { select: { timezone: true } } } },
  teacher: { select: { id: true, firstName: true, lastName: true, timezone: true } },
  course: { select: { id: true, nameAr: true, nameEn: true } },
} satisfies Prisma.ClassSessionInclude;
type TrialRow = Prisma.ClassSessionGetPayload<{ include: typeof trialInclude }>;

const teacherName = (t: { firstName: string; lastName: string | null }) =>
  [t.firstName, t.lastName].filter(Boolean).join(' ');

/** `YYYY-MM-DDTHH:MM` of an instant in a zone. */
const wall = (ms: number, zone: string) => {
  const l = local(ms, zone);
  return `${l.date}T${l.time}`;
};

/** Both parties' wall times of a class (D30). */
export function bothTimes(
  startsAt: Date,
  familyZone: string,
  teacherZone: string,
): { familyZone: string; teacherZone: string; familyLocal: string; teacherLocal: string } {
  const ms = startsAt.getTime();
  return {
    familyZone,
    teacherZone,
    familyLocal: wall(ms, familyZone),
    teacherLocal: wall(ms, teacherZone),
  };
}

/**
 * The read side of the CRM (Laravel `LeadReportService` + the lead resources): the queue with
 * its tabs, the workbench, today tiles, the funnel, trials and duplicates of a lead.
 */
@Injectable()
export class LeadReports {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
  ) {}

  /** `tz` when valid, else the viewer's zone, else the academy's. */
  zone(tz: string | undefined, viewer: AuthUser | null, s: SettingsMap): string {
    if (tz && isValidZone(tz)) return tz;
    if (viewer?.timezone && isValidZone(viewer.timezone)) return viewer.timezone;
    return s['academy.timezone'];
  }

  // ---------------------------------------------------------------- list

  async list(
    q: z.output<typeof leadListQuerySchema>,
    viewer: AuthUser,
  ): Promise<Paginated<LeadDto>> {
    const s = await this.settings.all();
    const zone = this.zone(q.tz, viewer, s);
    const and: Prisma.LeadWhereInput[] = [];
    if (q.q) {
      const term = q.q.trim();
      const digits = term.replace(/\D+/g, '');
      const id = searchId(term);
      and.push({
        OR: [
          { parentName: contains(term) },
          { email: contains(term.toLowerCase()) },
          ...(digits.length >= 4 ? [{ phoneDigits: contains(digits.replace(/^0+/, '')) }] : []),
          ...(id ? [{ id }] : []),
        ],
      });
    }
    if (q.assigned === 'me') and.push({ assignedToId: viewer.id });
    else if (q.assigned === 'none') and.push({ assignedToId: null });
    else if (q.assigned) and.push({ assignedToId: Number(q.assigned) });
    if (q.source) and.push({ source: q.source });
    if (q.followUp === 'due') {
      const endOfDay = toUtc(addDays(local(this.clock.nowMs(), zone).date, 1), '00:00', zone);
      and.push({ nextFollowUpAt: { not: null, lt: new Date(endOfDay) } });
    }
    if (q.awaitingOutcome) and.push(this.awaitingOutcomeWhere());
    if (q.uncontacted) and.push(this.uncontactedWhere());
    const where: Prisma.LeadWhereInput = { AND: and };

    const groups = await this.prisma.lead.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    });
    const counts: Record<string, number> = { all: 0 };
    for (const st of LEAD_STATUSES) counts[st] = 0;
    for (const g of groups) {
      counts[g.status] = g._count._all;
      counts.all! += g._count._all;
    }
    counts.open = OPEN_LEAD_STATUSES.reduce((n, st) => n + (counts[st] ?? 0), 0);

    const listWhere: Prisma.LeadWhereInput =
      q.status === 'open'
        ? { AND: [...and, { status: { in: [...OPEN_LEAD_STATUSES] } }] }
        : q.status === 'all'
          ? where
          : { AND: [...and, { status: q.status }] };
    const orderBy: Prisma.LeadOrderByWithRelationInput[] = [
      ...(q.followUp === 'due' ? [{ nextFollowUpAt: 'asc' as const }] : []),
      { createdAt: 'desc' },
      { id: 'desc' },
    ];
    const [rows, total] = await Promise.all([
      this.prisma.lead.findMany({
        where: listWhere,
        include: leadInclude,
        orderBy,
        ...pageArgs(q),
      }),
      this.prisma.lead.count({ where: listWhere }),
    ]);
    const trials = await this.latestTrialByFamily([
      ...new Set(rows.map((r) => r.familyId).filter((id): id is number => id !== null)),
    ]);
    return {
      data: rows.map((r) => this.row(r, s, r.familyId ? (trials.get(r.familyId) ?? null) : null)),
      meta: pageMeta(q, total, counts),
    };
  }

  /** A queue row (Laravel `LeadResource`). */
  row(
    l: LeadRow,
    s: SettingsMap,
    trial: { id: number; startsAt: Date; stage: string } | null = null,
  ): LeadDto {
    // First-response SLA (docs/33 §3.2): only while a new lead has had no contact.
    const due =
      l.status === 'new' && !l.firstResponseAt && !l.lastContactedAt
        ? WorkingHours.firstResponseDue(l.createdAt.getTime(), s)
        : null;
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
      childrenCount: Array.isArray(l.children) ? l.children.length : 0,
      assignedTo: l.assignedTo ? { id: l.assignedTo.id, name: l.assignedTo.name } : null,
      nextFollowUpAt: isoZ(l.nextFollowUpAt),
      lastContactedAt: isoZ(l.lastContactedAt),
      createdAt: isoZ(l.createdAt)!,
      familyId: l.familyId,
      trial: trial
        ? { sessionId: trial.id, startsAt: isoZ(trial.startsAt)!, stage: trial.stage }
        : null,
      spamScore: l.spamScore,
      submissions: l.submissions,
      firstResponseAt: isoZ(l.firstResponseAt),
      contactAttempts: l.contactAttempts,
      firstResponseDueAt: isoZ(due),
      firstResponseOverdue: due !== null && due <= this.clock.nowMs(),
    };
  }

  // ---------------------------------------------------------------- workbench

  async detail(id: number, viewer: AuthUser): Promise<LeadDetailDto> {
    const l = await this.prisma.lead.findUnique({ where: { id }, include: leadInclude });
    if (!l) throw notFound();
    const s = await this.settings.all();
    const activities = await this.prisma.leadActivity.findMany({
      where: { leadId: id },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { id: 'desc' },
      take: 200,
    });
    const trials = await this.trials(l);
    const latest = trials.find((t) => !(OFF_STAGES as readonly string[]).includes(t.stage)) ?? null;
    const unanswered = unansweredStreak(activities);
    const students = l.familyId
      ? await this.prisma.student.findMany({
          where: { familyId: l.familyId, archivedAt: null },
          include: {
            enrollments: {
              where: { status: { in: ['active', 'paused'] } },
              select: { id: true, kind: true, courseId: true, teacherId: true, status: true },
              orderBy: { id: 'asc' },
            },
          },
          orderBy: { id: 'asc' },
        })
      : [];
    return {
      ...this.row(
        l,
        s,
        latest ? { id: latest.id, startsAt: latest.startsAt, stage: latest.stage } : null,
      ),
      children: (Array.isArray(l.children) ? l.children : []) as LeadChildDto[],
      city: l.city,
      preferredLanguage: l.preferredLanguage,
      courseInterest: l.courseInterest,
      preferredTimes: l.preferredTimes,
      preferredSchedule: (l.preferredSchedule ?? null) as LeadDetailDto['preferredSchedule'],
      teacherGenderPref: l.teacherGenderPref,
      heardFrom: l.heardFrom,
      unansweredAttempts: unanswered,
      suggestLostNoResponse:
        isOpenLeadStatus(l.status) &&
        unanswered >= Math.max(1, s['crm.unanswered_attempts_suggest_lost']),
      message: l.message,
      family: l.family
        ? {
            id: l.family.id,
            status: l.family.status,
            name: l.family.user.name,
            timezone: l.family.timezone,
          }
        : null,
      referralFamily: l.referralFamily
        ? { id: l.referralFamily.id, name: l.referralFamily.user.name }
        : null,
      trialOutcome: l.trialOutcome,
      lostReason: l.lostReason,
      statusNote: l.statusNote,
      spamFlags: (Array.isArray(l.spamFlags) ? l.spamFlags : []) as string[],
      convertedAt: isoZ(l.convertedAt),
      convertedBy: l.convertedBy ? { id: l.convertedBy.id, name: l.convertedBy.name } : null,
      utm: (l.utm ?? null) as Record<string, string> | null,
      activities: activities.map(activityDto),
      trials: trials.map((t) => this.trialDto(t, s)),
      students: students.map((st) => ({
        id: st.id,
        name: st.name,
        age: st.age,
        gender: st.gender,
        courseId: st.regularCourseId,
        enrollments: st.enrollments,
      })),
      duplicates: await this.duplicates(l),
      allowedActions: allowedActions(l, viewer),
    };
  }

  trialDto(t: TrialRow, s: SettingsMap): LeadTrialDto {
    return {
      sessionId: t.id,
      student: { id: t.student.id, name: t.student.name },
      teacher: { id: t.teacher.id, name: teacherName(t.teacher) },
      course: t.course,
      startsAt: isoZ(t.startsAt)!,
      durationMinutes: t.durationMinutes,
      stage: t.stage,
      ...bothTimes(t.startsAt, zoneOr(t.student.family.timezone, s), zoneOr(t.teacher.timezone, s)),
    };
  }

  /** Trial classes of the lead's family, newest first. */
  async trials(lead: { familyId: number | null }): Promise<TrialRow[]> {
    if (!lead.familyId) return [];
    return this.prisma.classSession.findMany({
      where: { kind: 'trial', deletedAt: null, student: { familyId: lead.familyId } },
      include: trialInclude,
      orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
      take: 20,
    });
  }

  async trialSession(id: number): Promise<TrialRow> {
    return this.prisma.classSession.findUniqueOrThrow({ where: { id }, include: trialInclude });
  }

  /** Latest non-cancelled trial per family, for list rows. */
  async latestTrialByFamily(
    familyIds: number[],
  ): Promise<Map<number, { id: number; startsAt: Date; stage: string }>> {
    const out = new Map<number, { id: number; startsAt: Date; stage: string }>();
    if (!familyIds.length) return out;
    const rows = await this.prisma.classSession.findMany({
      where: {
        kind: 'trial',
        deletedAt: null,
        stage: { notIn: [...OFF_STAGES] },
        student: { familyId: { in: familyIds } },
      },
      select: { id: true, startsAt: true, stage: true, student: { select: { familyId: true } } },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
    for (const r of rows) out.set(r.student.familyId, r); // later rows overwrite: latest wins
    return out;
  }

  /** Other leads and families with the same email or phone (shown, never merged automatically). */
  async duplicates(l: Lead): Promise<LeadDetailDto['duplicates']> {
    const email = l.email;
    const digits = l.phoneDigits;
    if (!email && !digits) return { leads: [], families: [] };
    const leads = await this.prisma.lead.findMany({
      where: {
        id: { not: l.id },
        OR: [...(email ? [{ email }] : []), ...(digits ? [{ phoneDigits: digits }] : [])],
      },
      select: { id: true, parentName: true, status: true, createdAt: true },
      orderBy: { id: 'desc' },
      take: 10,
    });
    const userOr: Prisma.UserWhereInput[] = [];
    if (email) userOr.push({ email: { equals: email, mode: 'insensitive' } });
    if (digits && digits.length >= 7) userOr.push({ phone: { endsWith: digits.slice(-9) } });
    const families = userOr.length
      ? await this.prisma.family.findMany({
          where: { user: { OR: userOr }, ...(l.familyId ? { id: { not: l.familyId } } : {}) },
          select: { id: true, status: true, user: { select: { name: true } } },
          orderBy: { id: 'asc' },
          take: 10,
        })
      : [];
    return {
      leads: leads.map((d) => ({
        id: d.id,
        parentName: d.parentName,
        status: d.status,
        createdAt: isoZ(d.createdAt)!,
      })),
      families: families.map((f) => ({ id: f.id, name: f.user.name, status: f.status })),
    };
  }

  // ---------------------------------------------------------------- tiles, funnel, assignees

  /** New leads nobody has contacted yet (spam and parked leads are not "new"). */
  uncontactedWhere(): Prisma.LeadWhereInput {
    return { status: 'new', firstResponseAt: null, lastContactedAt: null };
  }

  /** A booked trial whose class time has passed and no outcome yet. */
  awaitingOutcomeWhere(): Prisma.LeadWhereInput {
    return {
      status: 'trial_scheduled',
      family: {
        students: {
          some: {
            sessions: {
              some: {
                kind: 'trial',
                deletedAt: null,
                stage: { notIn: [...OFF_STAGES] },
                endsAt: { lt: this.clock.now() },
              },
            },
          },
        },
      },
    };
  }

  async summary(tz: string | undefined, viewer: AuthUser): Promise<LeadSummaryDto> {
    const s = await this.settings.all();
    const zone = this.zone(tz, viewer, s);
    const now = this.clock.nowMs();
    const today = local(now, zone).date;
    const dayStart = new Date(toUtc(today, '00:00', zone));
    const dayEnd = new Date(toUtc(addDays(today, 1), '00:00', zone));
    const monthStart = new Date(toUtc(`${today.slice(0, 8)}01`, '00:00', zone));
    const open = { status: { in: [...OPEN_LEAD_STATUSES] } };

    const groups = await this.prisma.lead.groupBy({ by: ['status'], _count: { _all: true } });
    const byStatus = Object.fromEntries(groups.map((g) => [g.status, g._count._all]));
    const uncontacted = await this.prisma.lead.findMany({
      where: this.uncontactedWhere(),
      select: { createdAt: true },
    });
    const [followUps, trialsToday, awaiting, converted, lost, unassigned] = await Promise.all([
      this.prisma.lead.count({ where: { ...open, nextFollowUpAt: { not: null, lt: dayEnd } } }),
      this.prisma.classSession.count({
        where: {
          kind: 'trial',
          deletedAt: null,
          stage: { notIn: [...OFF_STAGES] },
          startsAt: { gte: dayStart, lt: dayEnd },
        },
      }),
      this.prisma.lead.count({ where: this.awaitingOutcomeWhere() }),
      this.prisma.lead.count({ where: { status: 'converted', convertedAt: { gte: monthStart } } }),
      this.prisma.lead.count({ where: { status: 'lost', statusChangedAt: { gte: monthStart } } }),
      this.prisma.lead.count({ where: { ...open, assignedToId: null } }),
    ]);
    return {
      date: today,
      timezone: zone,
      new: byStatus.new ?? 0,
      followUpsDue: followUps,
      trialsToday,
      awaitingOutcome: awaiting,
      convertedThisMonth: converted,
      lostThisMonth: lost,
      openTotal: OPEN_LEAD_STATUSES.reduce((n, st) => n + (byStatus[st] ?? 0), 0),
      unassigned,
      uncontacted: uncontacted.length,
      firstResponseOverdue: uncontacted.filter(
        (l) => WorkingHours.firstResponseDue(l.createdAt.getTime(), s) <= now,
      ).length,
    };
  }

  /** Leads created in [from, to] (academy-zone dates) by source and by assignee. */
  async funnel(from: string | undefined, to: string | undefined): Promise<LeadFunnelDto> {
    const s = await this.settings.all();
    const zone = s['academy.timezone'];
    const today = local(this.clock.nowMs(), zone).date;
    const start = from ?? `${today.slice(0, 8)}01`;
    const end = to ?? today;
    if ((Date.parse(end) - Date.parse(start)) / DAY > 366) {
      throw crmError(HttpStatus.UNPROCESSABLE_ENTITY, 'range_too_long', {
        errors: { to: ['Choose a period of at most one year.'] },
      });
    }
    const leads = await this.prisma.lead.findMany({
      where: {
        createdAt: {
          gte: new Date(toUtc(start, '00:00', zone)),
          lt: new Date(toUtc(addDays(end, 1), '00:00', zone)),
        },
      },
      select: { id: true, status: true, source: true, assignedToId: true, lastContactedAt: true },
    });
    const booked = new Set(
      (
        await this.prisma.leadActivity.findMany({
          where: { type: 'trial_booked', leadId: { in: leads.map((l) => l.id) } },
          select: { leadId: true },
          distinct: ['leadId'],
        })
      ).map((a) => a.leadId),
    );
    const row = (group: typeof leads) => {
      const real = group.filter((l) => l.status !== 'spam');
      return {
        created: real.length,
        contacted: real.filter(
          (l) => l.lastContactedAt !== null || !['new', 'job_applicant'].includes(l.status),
        ).length,
        trial: real.filter((l) => booked.has(l.id)).length,
        converted: real.filter((l) => l.status === 'converted').length,
        lost: real.filter((l) => l.status === 'lost').length,
        spam: group.length - real.length,
      };
    };
    const groupBy = <K>(key: (l: (typeof leads)[number]) => K) => {
      const m = new Map<K, typeof leads>();
      for (const l of leads) m.set(key(l), [...(m.get(key(l)) ?? []), l]);
      return m;
    };
    const assigneeIds = [...new Set(leads.map((l) => l.assignedToId).filter((x) => x !== null))];
    const names = new Map(
      (
        await this.prisma.user.findMany({
          where: { id: { in: assigneeIds } },
          select: { id: true, name: true },
        })
      ).map((u) => [u.id, u.name]),
    );
    return {
      from: start,
      to: end,
      total: row(leads),
      bySource: [...groupBy((l) => l.source)].map(([source, g]) => ({
        source: source,
        ...row(g),
      })),
      byAssignee: [...groupBy((l) => l.assignedToId)].map(([userId, g]) => ({
        user: userId === null ? null : { id: userId, name: names.get(userId) ?? '' },
        ...row(g),
      })),
    };
  }

  /** Staff who can take leads, with their open-lead count. */
  async assignees(): Promise<LeadAssigneeDto[]> {
    const users = await usersWithPermission(this.prisma, 'leads.manage');
    const open = await this.prisma.lead.groupBy({
      by: ['assignedToId'],
      where: { status: { in: [...OPEN_LEAD_STATUSES] }, assignedToId: { not: null } },
      _count: { _all: true },
    });
    const counts = new Map(open.map((o) => [o.assignedToId, o._count._all]));
    return users
      .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
      .map((u) => ({
        id: u.id,
        name: u.name,
        role: u.role?.name ?? null,
        openCount: counts.get(u.id) ?? 0,
      }));
  }
}

const zoneOr = (zone: string | null | undefined, s: SettingsMap) =>
  zone && isValidZone(zone) ? zone : s['academy.timezone'];

export function activityDto(a: {
  id: number;
  type: string;
  body: string | null;
  callResult: string | null;
  meta: unknown;
  user: { id: number; name: string } | null;
  createdAt: Date;
}): LeadActivityDto {
  return {
    id: a.id,
    type: a.type as LeadActivityDto['type'],
    body: a.body,
    callResult: a.callResult as LeadActivityDto['callResult'],
    meta: (a.meta && typeof a.meta === 'object' ? a.meta : {}) as Record<string, unknown>,
    user: a.user,
    createdAt: isoZ(a.createdAt)!,
  };
}

/** Contact attempts without an answer since the family was last reached (newest first). */
export function unansweredStreak(
  activities: ReadonlyArray<{ type: string; callResult: string | null }>,
): number {
  let streak = 0;
  for (const a of activities) {
    if (!(CONTACT_ACTIVITY_TYPES as readonly string[]).includes(a.type)) continue;
    if (a.callResult === 'no_answer' || a.callResult === 'busy') {
      streak++;
      continue;
    }
    // An email / WhatsApp note without an outcome says nothing either way.
    if (a.callResult === null && a.type !== 'call') continue;
    break;
  }
  return streak;
}

/** The workbench buttons for this viewer (Laravel `allowed_actions`). */
export function allowedActions(
  l: Pick<Lead, 'status' | 'assignedToId' | 'familyId'>,
  user: AuthUser,
): LeadAllowedAction[] {
  const can = (p: string) => user.permissions.has(p);
  if (!can('leads.manage')) return [];
  const open = isOpenLeadStatus(l.status);
  const scheduling = can('families.manage') && can('schedule.manage');
  const actions: LeadAllowedAction[] = ['add_activity', 'edit'];
  if (l.assignedToId === null) actions.push('assign_self');
  else if (l.assignedToId === user.id) actions.push('release');
  if (can('leads.assign')) actions.push('assign');
  if (l.status === 'new') actions.push('mark_contacted');
  if (open) {
    actions.push('lose', 'spam', 'job_applicant');
    if (!l.familyId && can('families.manage')) actions.push('create_account');
    if (l.familyId && scheduling) actions.push('book_trial', 'convert');
  }
  if (l.status === 'trial_scheduled' || l.status === 'trial_done') actions.push('record_outcome');
  if (isParkedLeadStatus(l.status)) actions.push('reopen');
  return actions;
}
