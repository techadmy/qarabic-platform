import type {
  TrialIneligibleReason,
  TrialTeacherOptionDto,
  TrialTeachersResponse,
} from '@qarabic/shared';
import { ADULT_AGE } from '@qarabic/shared';
import { crmdb, type LeadRow } from './crm-db';
import { db as people } from './people-db';
import { checkSlot } from './schedule-handlers';

/**
 * The trial teachers of a lead for one time (T2, docs/33 §4.1–4.2), as `GET
 * /leads/:id/trial-teachers` answers: the eligible teachers ranked, the others with their reasons.
 * Fake but deterministic factors (conversion, free hours) so the list has a stable order.
 */
export function trialTeachers(
  lead: LeadRow,
  q: {
    studentId: number;
    courseId: number;
    localDate: string;
    localTime: string;
    timezone: string;
    durationMinutes: number;
  },
  startsAt: string,
): TrialTeachersResponse {
  const student = lead.students.find((s) => s.id === q.studentId);
  const adult = student?.age == null ? null : student.age >= ADULT_AGE;
  const pref =
    lead.teacherGenderPref === 'male' || lead.teacherGenderPref === 'female'
      ? lead.teacherGenderPref
      : null;
  const weekday = ((new Date(`${q.localDate}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
  const options = people.teachers
    .filter((t) => t.status.value === 'active' && !t.archive)
    .map((t): TrialTeacherOptionDto => {
      const check = checkSlot({
        studentId: q.studentId,
        teacherId: t.id,
        weekday,
        localStartTime: q.localTime,
        durationMinutes: q.durationMinutes,
        timezone: q.timezone,
        validFrom: q.localDate,
      });
      const booked = crmdb.leads.flatMap((l) =>
        l.trials.filter((x) => x.teacher.id === t.id && x.stage !== 'cancelled'),
      );
      const trialsThisWeek = booked.filter(
        (x) => Math.abs(Date.parse(x.startsAt) - Date.parse(startsAt)) < 7 * 86_400_000,
      ).length;
      const reasons: TrialIneligibleReason[] = [];
      if (!t.courses.some((c) => c.id === q.courseId)) reasons.push('course');
      if (!t.acceptsTrials) reasons.push('not_accepting');
      if (t.maxTrialsPerWeek != null && trialsThisWeek >= t.maxTrialsPerWeek)
        reasons.push('weekly_limit');
      if (pref && t.gender !== pref) reasons.push('gender');
      if (adult != null && t.audience !== 'both' && (t.audience === 'adults') !== adult)
        reasons.push('audience');
      if (check.conflicts.length) reasons.push('busy');
      const trials = 4 + (t.id % 5);
      const converted = Math.round(trials * (0.3 + (t.id % 4) * 0.15));
      const local = new Intl.DateTimeFormat('en-CA', {
        timeZone: t.timezone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).formatToParts(new Date(startsAt));
      const part = (k: string) => local.find((p) => p.type === k)?.value ?? '';
      return {
        teacher: { id: t.id, name: t.name, gender: t.gender, timezone: t.timezone },
        eligible: reasons.length === 0,
        reasons,
        overridable: reasons.length > 0 && !reasons.includes('busy'),
        rank: null,
        teacherLocal: {
          date: `${part('year')}-${part('month')}-${part('day')}`,
          time: `${part('hour')}:${part('minute')}`,
        },
        inWorkHours: !check.warnings.some((w) => w.code === 'outside_work_hours'),
        check: { conflicts: check.conflicts, warnings: check.warnings },
        languageMatch: null,
        conversion: { trials, converted, rate: Math.round((converted / trials) * 100) },
        weeklyFreeHours: t.id === 7 ? null : 40 - ((t.id * 3) % 20),
        trialsThisWeek,
        maxTrialsPerWeek: t.maxTrialsPerWeek,
        recentTrials: booked.filter(
          (x) =>
            Date.now() - Date.parse(x.startsAt) < 14 * 86_400_000 &&
            Date.parse(x.startsAt) <= Date.now(),
        ).length,
      };
    });
  const lang = (x: boolean | null) => (x === true ? 0 : x === null ? 1 : 2);
  const eligible = options
    .filter((o) => o.eligible)
    .sort(
      (a, b) =>
        Number(b.inWorkHours) - Number(a.inWorkHours) ||
        lang(a.languageMatch) - lang(b.languageMatch) ||
        a.recentTrials - b.recentTrials ||
        (b.conversion.rate ?? -1) - (a.conversion.rate ?? -1) ||
        (b.weeklyFreeHours ?? -1) - (a.weeklyFreeHours ?? -1) ||
        a.teacher.name.localeCompare(b.teacher.name),
    )
    .map((o, i) => ({ ...o, rank: i + 1 }));
  const ineligible = options
    .filter((o) => !o.eligible)
    .sort((a, b) => a.teacher.name.localeCompare(b.teacher.name));
  return {
    data: { eligible, ineligible },
    meta: {
      startsAt,
      durationMinutes: q.durationMinutes,
      familyZone: q.timezone,
      adult,
      teacherGenderPref: pref,
    },
  };
}
