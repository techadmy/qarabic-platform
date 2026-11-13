import { HttpStatus, Injectable } from '@nestjs/common';
import {
  LEAD_SOURCES,
  LOST_REASONS,
  type LeadKpiRowDto,
  type LeadKpisDto,
  type LostReason,
  type RateDto,
} from '@qarabic/shared';
import { Clock } from '../common/clock.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { addDays, local, toUtc } from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';
import { crmError } from './errors.js';
import { WorkingHours } from './working-hours.js';

const DAY = 86_400_000;
/** A held trial (the class took place) and a no-show. */
const HELD = new Set(['taken', 'ended', 'in_progress']);
const NO_SHOW = 'absent';

export function rate(numerator: number, denominator: number): RateDto {
  return {
    numerator,
    denominator,
    pct: denominator ? Math.round((numerator / denominator) * 1000) / 10 : null,
  };
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

interface LeadRow {
  id: number;
  status: string;
  source: (typeof LEAD_SOURCES)[number];
  assignedToId: number | null;
  familyId: number | null;
  createdAt: Date;
  firstResponseAt: Date | null;
  convertedAt: Date | null;
}

interface TrialRow {
  id: number;
  stage: string;
  teacherId: number;
  courseId: number | null;
  familyId: number;
}

/**
 * The CRM rates (T5, docs/33 §6): first response, lead → trial, trial show-up, trial → regular,
 * time to regular — in total and by source, owner, teacher and course — and the lost reasons.
 * Leads are those created in the period (academy days); spam and job applicants are left out.
 */
@Injectable()
export class LeadKpis {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
  ) {}

  async kpis(from: string | undefined, to: string | undefined): Promise<LeadKpisDto> {
    const st = await this.settings.all();
    const zone = st['academy.timezone'];
    const today = local(this.clock.nowMs(), zone).date;
    const start = from ?? `${today.slice(0, 8)}01`;
    const end = to ?? today;
    if ((Date.parse(end) - Date.parse(start)) / DAY > 366) {
      throw crmError(HttpStatus.UNPROCESSABLE_ENTITY, 'range_too_long', {
        errors: { to: ['Choose a period of at most one year.'] },
      });
    }
    const range = {
      gte: new Date(toUtc(start, '00:00', zone)),
      lt: new Date(toUtc(addDays(end, 1), '00:00', zone)),
    };
    const leads: LeadRow[] = await this.prisma.lead.findMany({
      where: { createdAt: range, status: { notIn: ['spam', 'job_applicant'] } },
      select: {
        id: true,
        status: true,
        source: true,
        assignedToId: true,
        familyId: true,
        createdAt: true,
        firstResponseAt: true,
        convertedAt: true,
      },
    });
    const ids = leads.map((l) => l.id);
    const booked = new Set(
      (
        await this.prisma.leadActivity.findMany({
          where: { type: 'trial_booked', leadId: { in: ids } },
          select: { leadId: true },
          distinct: ['leadId'],
        })
      ).map((a) => a.leadId),
    );
    const families = [...new Set(leads.map((l) => l.familyId).filter((f) => f !== null))];
    const trials: TrialRow[] = (
      await this.prisma.classSession.findMany({
        where: {
          kind: 'trial',
          deletedAt: null,
          stage: { in: [...HELD, NO_SHOW] as Array<'taken' | 'ended' | 'in_progress' | 'absent'> },
          student: { familyId: { in: families } },
        },
        select: {
          id: true,
          stage: true,
          teacherId: true,
          courseId: true,
          student: { select: { familyId: true } },
        },
      })
    ).map((t) => ({ ...t, familyId: t.student.familyId }));
    const leadOfFamily = new Map<number, LeadRow>();
    for (const l of leads) if (l.familyId !== null) leadOfFamily.set(l.familyId, l);

    const hours = WorkingHours.fromSettings(st);
    const sla = st['crm.first_response_minutes'];
    const row = (group: LeadRow[]): LeadKpiRowDto => {
      const responded = group.filter((l) => l.firstResponseAt);
      const minutes = responded.map((l) =>
        Math.round((l.firstResponseAt!.getTime() - l.createdAt.getTime()) / 60_000),
      );
      const inSla = responded.filter(
        (l) => l.firstResponseAt!.getTime() <= hours.addWorkingMinutes(l.createdAt.getTime(), sla),
      ).length;
      const fams = new Set(group.map((l) => l.familyId).filter((f) => f !== null));
      const mine = trials.filter((t) => fams.has(t.familyId));
      const held = mine.filter((t) => HELD.has(t.stage));
      const heldLeads = new Set(held.map((t) => leadOfFamily.get(t.familyId)!.id));
      const converted = group.filter((l) => l.status === 'converted');
      const days = converted
        .filter((l) => l.convertedAt)
        .map((l) => (l.convertedAt!.getTime() - l.createdAt.getTime()) / DAY);
      const med = median(minutes);
      const medDays = median(days);
      return {
        leads: group.length,
        firstResponse: {
          measured: responded.length,
          medianMinutes: med === null ? null : Math.round(med),
          withinSla: rate(inSla, responded.length),
        },
        leadToTrial: rate(group.filter((l) => booked.has(l.id)).length, group.length),
        trialShowUp: rate(held.length, mine.length),
        trialToRegular: rate(converted.filter((l) => heldLeads.has(l.id)).length, heldLeads.size),
        medianDaysToRegular: medDays === null ? null : Math.round(medDays * 10) / 10,
      };
    };
    const trialRow = (group: TrialRow[]) => {
      const held = group.filter((t) => HELD.has(t.stage));
      const heldLeads = new Set(held.map((t) => leadOfFamily.get(t.familyId)!.id));
      const converted = [...heldLeads].filter(
        (id) => leads.find((l) => l.id === id)?.status === 'converted',
      ).length;
      return {
        trials: group.length,
        showUp: rate(held.length, group.length),
        toRegular: rate(converted, heldLeads.size),
      };
    };
    const groupBy = <T, K>(items: T[], key: (x: T) => K) => {
      const m = new Map<K, T[]>();
      for (const x of items) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
      return [...m];
    };

    const userIds = [...new Set(leads.map((l) => l.assignedToId).filter((x) => x !== null))];
    const teacherIds = [...new Set(trials.map((t) => t.teacherId))];
    const courseIds = [...new Set(trials.map((t) => t.courseId).filter((x) => x !== null))];
    const [users, teachers, courses, lost] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true },
      }),
      this.prisma.teacher.findMany({
        where: { id: { in: teacherIds } },
        select: { id: true, firstName: true, lastName: true },
      }),
      this.prisma.course.findMany({
        where: { id: { in: courseIds } },
        select: { id: true, nameAr: true, nameEn: true },
      }),
      this.prisma.lead.findMany({
        where: { status: 'lost', statusChangedAt: range },
        select: { lostReason: true, source: true },
      }),
    ]);
    const reasonOf = (r: LostReason | null): LostReason => r ?? 'other';

    return {
      from: start,
      to: end,
      total: row(leads),
      bySource: groupBy(leads, (l) => l.source)
        .sort(([a], [b]) => LEAD_SOURCES.indexOf(a) - LEAD_SOURCES.indexOf(b))
        .map(([source, g]) => ({ source, ...row(g) })),
      byAssignee: groupBy(leads, (l) => l.assignedToId).map(([userId, g]) => ({
        user:
          userId === null
            ? null
            : { id: userId, name: users.find((u) => u.id === userId)?.name ?? '' },
        ...row(g),
      })),
      byTeacher: groupBy(trials, (t) => t.teacherId).map(([teacherId, g]) => {
        const t = teachers.find((x) => x.id === teacherId);
        return {
          teacher: {
            id: teacherId,
            name: t ? [t.firstName, t.lastName].filter(Boolean).join(' ') : '',
          },
          ...trialRow(g),
        };
      }),
      byCourse: groupBy(
        trials.filter((t) => t.courseId !== null),
        (t) => t.courseId!,
      ).map(([courseId, g]) => ({
        course: courses.find((c) => c.id === courseId) ?? {
          id: courseId,
          nameAr: '',
          nameEn: '',
        },
        ...trialRow(g),
      })),
      lostReasons: LOST_REASONS.map((reason) => {
        const mine = lost.filter((l) => reasonOf(l.lostReason) === reason);
        return {
          reason,
          count: mine.length,
          bySource: groupBy(mine, (l) => l.source).map(([source, g]) => ({
            source,
            count: g.length,
          })),
        };
      }),
      lostTotal: lost.length,
    };
  }
}
