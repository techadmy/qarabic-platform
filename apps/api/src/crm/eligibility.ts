import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ADULT_AGE,
  OCCUPYING_STAGES,
  type TeacherLanguage,
  type TrialIneligibleReason,
  type TrialTeacherOptionDto,
  type TrialTeachersResponse,
  type trialTeachersQuerySchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import { Clock } from '../common/clock.js';
import { notFound, validationError } from '../common/errors.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { Tx } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConflictChecker, zoneOr } from '../schedule/conflicts.js';
import { LIVE_ENROLLMENT } from '../schedule/scope.js';
import {
  addDays,
  isoWeekday,
  local,
  minuteOf,
  startOfLocalDay,
  toDbDate,
  toUtc,
} from '../schedule/time.js';
import { SettingsService, type SettingsMap } from '../settings/settings.service.js';
import { TRIAL_DEFAULT_MINUTES } from './crm.config.js';
import { crmError } from './errors.js';

const DAY = 86_400_000;
const occupying = { in: [...OCCUPYING_STAGES] } as Prisma.EnumSessionStageFilter;
/** Hard conflicts that make a teacher `busy` for the trial. */
const BUSY = new Set(['teacher_overlap', 'teacher_blocked', 'teacher_inactive']);

/** Local wall time in `zone` → UTC ms; a time skipped by a clock change is a 422 on `field`. */
export function localToUtc(date: string, time: string, zone: string, field: string): number {
  const at = toUtc(date, time, zone);
  const back = local(at, zone);
  if (back.date !== date || back.time !== time.slice(0, 5)) {
    throw validationError({
      [field]: ['This time does not exist in the time zone (clock change).'],
    });
  }
  return at;
}

/** What eligibility is judged on: one student, one course, one time. */
export interface TrialContext {
  studentId: number;
  courseId: number;
  startsAt: number;
  minutes: number;
  /** `male` / `female` when the family asked; `any` or null otherwise. */
  teacherGenderPref: string | null;
  studentAge: number | null;
  studentLanguage: string | null;
}

/** Student languages → the teacher languages that serve them. */
function languagesFor(language: string | null): TeacherLanguage[] | null {
  if (!language) return null;
  if (language === 'english_urdu') return ['english', 'urdu'];
  return [language as TeacherLanguage];
}

const workMinutes = (start: string, end: string) => {
  const d = minuteOf(end) - minuteOf(start);
  return d > 0 ? d : d + 1440;
};

/**
 * Teacher eligibility and ranking for a trial (T2, docs/33 §4.1–4.2). A teacher is eligible when
 * they teach the course, take trials (and are under their weekly cap), match the family's teacher
 * gender and the child's age group, are not on leave and are free at that time (the same conflict
 * rules as booking). The ranking is shown with its factors, never hidden.
 */
@Injectable()
export class TrialEligibility {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly checker: ConflictChecker,
  ) {}

  /** `GET /leads/:id/trial-teachers`. */
  async options(
    leadId: number,
    q: z.output<typeof trialTeachersQuerySchema>,
  ): Promise<TrialTeachersResponse> {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw notFound();
    if (!lead.familyId) {
      throw crmError(HttpStatus.UNPROCESSABLE_ENTITY, 'no_family', {
        errors: { studentId: ['Create the family account first.'] },
      });
    }
    const student = await this.prisma.student.findFirst({
      where: { id: q.studentId, familyId: lead.familyId },
      include: { family: { select: { timezone: true } } },
    });
    if (!student) throw notFound();
    if (!(await this.prisma.course.findUnique({ where: { id: q.courseId } }))) {
      throw validationError({ courseId: ['The selected course is invalid.'] });
    }
    const st = await this.settings.all();
    const familyZone = zoneOr(student.family.timezone, st['academy.timezone']);
    const startsAt = localToUtc(q.localDate, q.localTime, q.timezone ?? familyZone, 'localTime');
    const minutes = q.durationMinutes ?? TRIAL_DEFAULT_MINUTES;
    const ctx: TrialContext = {
      studentId: student.id,
      courseId: q.courseId,
      startsAt,
      minutes,
      teacherGenderPref: lead.teacherGenderPref,
      studentAge: student.age,
      studentLanguage: student.language,
    };
    const all = await this.evaluate(this.prisma, ctx, st);
    const pref = ctx.teacherGenderPref;
    return {
      data: {
        eligible: all.filter((o) => o.eligible),
        ineligible: all.filter((o) => !o.eligible),
      },
      meta: {
        startsAt: new Date(startsAt).toISOString(),
        durationMinutes: minutes,
        familyZone,
        adult: student.age === null ? null : student.age >= ADULT_AGE,
        teacherGenderPref: pref === 'male' || pref === 'female' ? pref : null,
      },
    };
  }

  /**
   * Every active teacher (or only `teacherIds`, whatever their status), judged and ranked: the
   * eligible first, ranked 1, 2, …; then the bookable-with-a-reason; then the busy.
   */
  async evaluate(
    db: Tx | PrismaService,
    ctx: TrialContext,
    st: SettingsMap,
    teacherIds?: number[],
  ): Promise<TrialTeacherOptionDto[]> {
    const academy = st['academy.timezone'];
    const now = this.clock.nowMs();
    const teachers = await db.teacher.findMany({
      where: teacherIds ? { id: { in: teacherIds } } : { status: 'active', archivedAt: null },
      include: { courses: { select: { courseId: true } }, workHours: true },
      orderBy: { id: 'asc' },
    });
    if (teachers.length === 0) return [];
    const ids = teachers.map((t) => t.id);

    const [trialEnrollments, recent, leaves, slots] = await Promise.all([
      db.enrollment.findMany({
        where: {
          teacherId: { in: ids },
          kind: 'trial',
          createdAt: { gte: new Date(now - 90 * DAY) },
        },
        select: { teacherId: true, studentId: true, createdAt: true },
      }),
      db.classSession.groupBy({
        by: ['teacherId'],
        where: {
          teacherId: { in: ids },
          kind: 'trial',
          stage: occupying,
          deletedAt: null,
          startsAt: { gte: new Date(now - 14 * DAY) },
        },
        _count: { _all: true },
      }),
      db.leaveRequest.findMany({
        where: {
          status: 'approved',
          userId: { in: teachers.map((t) => t.userId) },
          startsOn: { lte: toDbDate(local(ctx.startsAt + 2 * DAY, 'UTC').date) },
          endsOn: { gte: toDbDate(local(ctx.startsAt - 2 * DAY, 'UTC').date) },
        },
        select: { userId: true, startsOn: true, endsOn: true },
      }),
      db.scheduleSlot.findMany({
        where: {
          teacherId: { in: ids },
          enrollment: LIVE_ENROLLMENT,
          validFrom: { lte: new Date(now) },
          OR: [{ validTo: null }, { validTo: { gte: new Date(now) } }],
        },
        select: { teacherId: true, durationMinutes: true },
      }),
    ]);
    // A rebooking moves the student's current trial out first, so it never makes anyone busy.
    const current = await db.classSession.findFirst({
      where: { studentId: ctx.studentId, kind: 'trial', stage: 'scheduled', deletedAt: null },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    const regular = trialEnrollments.length
      ? await db.enrollment.findMany({
          where: { kind: 'regular', studentId: { in: trialEnrollments.map((e) => e.studentId) } },
          select: { studentId: true, createdAt: true },
        })
      : [];
    const recentBy = new Map(recent.map((r) => [r.teacherId, r._count._all]));
    const wanted = languagesFor(ctx.studentLanguage);
    const pref = ctx.teacherGenderPref === 'male' || ctx.teacherGenderPref === 'female';
    const adult = ctx.studentAge === null ? null : ctx.studentAge >= ADULT_AGE;

    const out: Array<TrialTeacherOptionDto & { sortName: string }> = [];
    for (const t of teachers) {
      const zone = zoneOr(t.timezone, academy);
      const at = local(ctx.startsAt, zone);
      const reasons: TrialIneligibleReason[] = [];
      if (!t.courses.some((c) => c.courseId === ctx.courseId)) reasons.push('course');
      if (!t.acceptsTrials) reasons.push('not_accepting');

      // The teacher's week (Monday to Sunday, their zone) of the trial.
      const monday = addDays(at.date, 1 - isoWeekday(at.date));
      const trialsThisWeek = await db.classSession.count({
        where: {
          teacherId: t.id,
          kind: 'trial',
          stage: occupying,
          deletedAt: null,
          studentId: { not: ctx.studentId },
          startsAt: {
            gte: new Date(startOfLocalDay(monday, zone)),
            lt: new Date(startOfLocalDay(addDays(monday, 7), zone)),
          },
        },
      });
      if (t.maxTrialsPerWeek !== null && trialsThisWeek >= t.maxTrialsPerWeek) {
        reasons.push('weekly_limit');
      }
      if (pref && t.gender !== ctx.teacherGenderPref) reasons.push('gender');
      if (adult !== null && t.audience !== 'both' && (t.audience === 'adults') !== adult) {
        reasons.push('audience');
      }
      const onLeave = leaves.some(
        (l) =>
          l.userId === t.userId && toDbDate(at.date) >= l.startsOn && toDbDate(at.date) <= l.endsOn,
      );
      if (onLeave) reasons.push('on_leave');

      const check = await this.checker.checkSession(
        db,
        {
          teacherId: t.id,
          studentId: ctx.studentId,
          startsAt: ctx.startsAt,
          durationMinutes: ctx.minutes,
          excludeSessionId: current?.id ?? null,
        },
        st,
      );
      if (check.conflicts.some((c) => BUSY.has(c.code))) reasons.push('busy');
      const inWorkHours = !check.warnings.some((w) => w.code === 'outside_work_hours');

      const mine = trialEnrollments.filter((e) => e.teacherId === t.id);
      const converted = mine.filter((e) =>
        regular.some((r) => r.studentId === e.studentId && r.createdAt >= e.createdAt),
      ).length;
      const work = t.workHours.reduce(
        (sum, h) => sum + workMinutes(h.localStartTime, h.localEndTime),
        0,
      );
      const booked = slots
        .filter((s) => s.teacherId === t.id)
        .reduce((sum, s) => sum + s.durationMinutes, 0);
      const name = [t.firstName, t.lastName].filter(Boolean).join(' ');
      const languages = t.languages as TeacherLanguage[];
      out.push({
        teacher: { id: t.id, name, gender: t.gender, timezone: zone },
        eligible: reasons.length === 0,
        reasons,
        overridable: reasons.length > 0 && !reasons.includes('busy'),
        rank: null,
        teacherLocal: { date: at.date, time: at.time },
        inWorkHours,
        languageMatch: wanted ? languages.some((l) => wanted.includes(l)) : null,
        conversion: {
          trials: mine.length,
          converted,
          rate: mine.length ? Math.round((converted / mine.length) * 100) : null,
        },
        weeklyFreeHours: t.workHours.length
          ? Math.round((Math.max(0, work - booked) / 60) * 10) / 10
          : null,
        trialsThisWeek,
        maxTrialsPerWeek: t.maxTrialsPerWeek,
        recentTrials: recentBy.get(t.id) ?? 0,
        sortName: name.toLocaleLowerCase(),
      });
    }

    const eligible = out.filter((o) => o.eligible).sort(byRank);
    eligible.forEach((o, i) => (o.rank = i + 1));
    const rest = out
      .filter((o) => !o.eligible)
      .sort(
        (a, b) =>
          Number(b.overridable) - Number(a.overridable) ||
          a.reasons.length - b.reasons.length ||
          a.sortName.localeCompare(b.sortName),
      );
    return [...eligible, ...rest].map(({ sortName: _s, ...o }) => o);
  }
}

/** Inside work hours, language match, fewer recent trials, conversion, free hours, name. */
function byRank(
  a: TrialTeacherOptionDto & { sortName: string },
  b: TrialTeacherOptionDto & { sortName: string },
): number {
  return (
    Number(b.inWorkHours) - Number(a.inWorkHours) ||
    Number(b.languageMatch === true) - Number(a.languageMatch === true) ||
    a.recentTrials - b.recentTrials ||
    (b.conversion.rate ?? -1) - (a.conversion.rate ?? -1) ||
    (b.weeklyFreeHours ?? -1) - (a.weeklyFreeHours ?? -1) ||
    a.sortName.localeCompare(b.sortName)
  );
}
