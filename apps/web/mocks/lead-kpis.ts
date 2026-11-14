import {
  LEAD_SOURCES,
  LOST_REASONS,
  type LeadKpisDto,
  type LeadKpiRowDto,
  type RateDto,
} from '@qarabic/shared';
import { crmdb, staffRef, type LeadRow } from './crm-db';

/** T5 rates for the mocks (docs/33 §6), from the fake CRM data; same shapes as the API. */
const rate = (numerator: number, denominator: number): RateDto => ({
  numerator,
  denominator,
  pct: denominator ? Math.round((numerator / denominator) * 1000) / 10 : null,
});
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

function row(leads: LeadRow[]): LeadKpiRowDto {
  const sla = crmdb.settings['crm.first_response_minutes'];
  const responses = leads
    .filter((l) => l.firstResponseAt)
    .map((l) => Math.round((Date.parse(l.firstResponseAt!) - Date.parse(l.createdAt)) / 60_000));
  const withTrial = leads.filter((l) => l.trials.length > 0);
  const held = withTrial.filter((l) => l.trials.some((t) => t.stage === 'completed'));
  const absent = withTrial.filter(
    (l) =>
      !l.trials.some((t) => t.stage === 'completed') && l.trials.some((t) => t.stage === 'absent'),
  );
  const converted = leads.filter((l) => l.status === 'converted');
  return {
    leads: leads.length,
    firstResponse: {
      measured: responses.length,
      medianMinutes: median(responses),
      withinSla: rate(responses.filter((m) => m <= sla).length, responses.length),
    },
    leadToTrial: rate(withTrial.length, leads.length),
    trialShowUp: rate(held.length, held.length + absent.length),
    trialToRegular: rate(converted.filter((l) => l.trials.length > 0).length, held.length),
    medianDaysToRegular: median(
      converted
        .filter((l) => l.convertedAt)
        .map((l) =>
          Math.round((Date.parse(l.convertedAt!) - Date.parse(l.createdAt)) / 86_400_000),
        ),
    ),
  };
}

export function leadKpis(from: string, to: string): LeadKpisDto {
  const leads = crmdb.leads.filter((l) => {
    const day = l.createdAt.slice(0, 10);
    return day >= from && day <= to;
  });
  const trials = leads.flatMap((l) =>
    l.trials.map((t) => ({ ...t, converted: l.status === 'converted' })),
  );
  const trialRow = (list: typeof trials) => {
    const held = list.filter((t) => t.stage === 'completed');
    const absent = list.filter((t) => t.stage === 'absent');
    return {
      trials: list.length,
      showUp: rate(held.length, held.length + absent.length),
      toRegular: rate(held.filter((t) => t.converted).length, held.length),
    };
  };
  const teachers = [...new Map(trials.map((t) => [t.teacher.id, t.teacher])).values()];
  const courses = [
    ...new Map(trials.filter((t) => t.course).map((t) => [t.course!.id, t.course!])).values(),
  ];
  const assignees = [...new Set(leads.map((l) => l.assignedToId))];
  const lost = leads.filter((l) => l.status === 'lost');
  return {
    from,
    to,
    total: row(leads),
    bySource: LEAD_SOURCES.map((source) => ({
      source,
      ...row(leads.filter((l) => l.source === source)),
    })).filter((r) => r.leads > 0),
    byAssignee: assignees.map((id) => ({
      user: staffRef(id),
      ...row(leads.filter((l) => l.assignedToId === id)),
    })),
    byTeacher: teachers.map((teacher) => ({
      teacher,
      ...trialRow(trials.filter((t) => t.teacher.id === teacher.id)),
    })),
    byCourse: courses.map((course) => ({
      course,
      ...trialRow(trials.filter((t) => t.course?.id === course.id)),
    })),
    lostReasons: LOST_REASONS.map((reason) => {
      const mine = lost.filter((l) => l.lostReason === reason);
      return {
        reason,
        count: mine.length,
        bySource: LEAD_SOURCES.map((source) => ({
          source,
          count: mine.filter((l) => l.source === source).length,
        })).filter((x) => x.count > 0),
      };
    }),
    lostTotal: lost.length,
  };
}
