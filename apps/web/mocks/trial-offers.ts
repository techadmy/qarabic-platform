import {
  assignTrialOfferSchema,
  cancelTrialOfferSchema,
  createTrialOfferSchema,
  isOpenLeadStatus,
  resendTrialOfferSchema,
  type MyTrialOfferDto,
  type TrialOfferDto,
  type TrialOfferResponse,
} from '@qarabic/shared';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { crmdb, iso, trialOf } from './crm-db';
import { zonedUtc } from './crm-handlers';
import { COURSES, db as people } from './people-db';
import { checkSlot, ownTeacherId } from './schedule-handlers';
import { apiError, guard, guardAny, notFound, validationFailed } from './session';
import { trialTeachers } from './trial-teachers';

/**
 * Open trial offers (T3, docs/33 §4.3) for the mocks: the CSR offers a trial to the eligible
 * teachers (or a shortlist); the first to accept is booked, or volunteers wait for the CSR's pick.
 * Teachers never see the family. One open offer per student; it closes 6 h before the trial.
 */
interface OfferRow extends Omit<TrialOfferDto, 'teachers'> {
  teachers: {
    teacher: { id: number; name: string };
    rank: number | null;
    response: TrialOfferResponse | null;
    respondedAt: string | null;
  }[];
}

const API = '*/api/v1';
const MINUTE = 60_000;
let offers: OfferRow[] = [];
let nextId = 1;

export function resetTrialOffers() {
  offers = [];
  nextId = 1;
  // An open offer for the demo teacher (teacher 1), so the teacher home shows the card.
  const lead = crmdb.leads.find((l) => l.id === 6);
  const student = lead?.students[0];
  if (!lead || !student) return;
  const startsAt = Date.now() + 2 * 86_400_000;
  offers.push({
    id: nextId++,
    leadId: lead.id,
    studentId: student.id,
    course: courseRef(student.courseId ?? 1),
    startsAt: iso(startsAt),
    durationMinutes: 30,
    familyZone: lead.timezone,
    familyLocal: localOf(startsAt, lead.timezone),
    policy: 'first_accept',
    audience: 'eligible',
    status: 'open',
    expiresAt: iso(Date.now() + 120 * MINUTE),
    note: 'A shy seven-year-old; please be patient.',
    createdBy: { id: 1, name: 'مدير النظام' },
    claimedTeacher: null,
    sessionId: null,
    closedAt: null,
    teachers: [1, 4].map((id, i) => ({
      teacher: teacherRef(id),
      rank: i + 1,
      response: null,
      respondedAt: null,
    })),
    createdAt: iso(Date.now() - 10 * MINUTE),
  });
}

const courseRef = (id: number) => {
  const c = COURSES.find((x) => x.id === id) ?? COURSES[0]!;
  return { id: c.id, nameAr: c.nameAr, nameEn: c.nameEn };
};
const teacherRef = (id: number) => {
  const t = people.teachers.find((x) => x.id === id)!;
  return { id: t.id, name: t.name };
};
function localOf(at: number, tz: string) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(at));
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? '';
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}:${g('minute')}` };
}

/** Expired offers close when looked at (the API's job runs every minute). */
function expire() {
  for (const o of offers) {
    if (o.status === 'open' && Date.parse(o.expiresAt) <= Date.now()) {
      o.status = 'expired';
      o.closedAt = iso(Date.now());
    }
  }
}

const present = (o: OfferRow): TrialOfferDto => ({ ...o, teachers: o.teachers });

function presentMine(o: OfferRow, teacherId: number): MyTrialOfferDto {
  const t = people.teachers.find((x) => x.id === teacherId)!;
  const lead = crmdb.leads.find((l) => l.id === o.leadId);
  const student = lead?.students.find((s) => s.id === o.studentId);
  const mine = o.teachers.find((x) => x.teacher.id === teacherId);
  const state =
    o.status === 'claimed'
      ? o.claimedTeacher?.id === teacherId
        ? 'mine'
        : 'taken'
      : o.status === 'open'
        ? 'open'
        : 'closed';
  return {
    id: o.id,
    course: o.course,
    startsAt: o.startsAt,
    durationMinutes: o.durationMinutes,
    teacherZone: t.timezone,
    teacherLocal: localOf(Date.parse(o.startsAt), t.timezone),
    student: {
      age: student?.age ?? null,
      gender: (student?.gender as 'male' | 'female' | null) ?? null,
      level: null,
    },
    note: o.note,
    policy: o.policy,
    state,
    expiresAt: o.expiresAt,
    myResponse: mine?.response ?? null,
    sessionId: state === 'mine' ? o.sessionId : null,
  };
}

/** Books the trial under the teacher (the normal booking after a claim or a pick). */
function book(o: OfferRow, teacherId: number) {
  const lead = crmdb.leads.find((l) => l.id === o.leadId)!;
  const student = lead.students.find((s) => s.id === o.studentId)!;
  const teacher = people.teachers.find((x) => x.id === teacherId)!;
  for (const t of lead.trials) if (t.stage === 'scheduled') t.stage = 'cancelled';
  const trial = trialOf(
    crmdb.nextId.session++,
    { ...student, courseId: o.course.id },
    Date.parse(o.startsAt),
    o.familyZone,
    'trial_scheduled',
    { id: teacher.id, name: teacher.name, timezone: teacher.timezone },
    o.durationMinutes,
  );
  trial.course = o.course;
  lead.trials.unshift(trial);
  if (isOpenLeadStatus(lead.status)) lead.status = 'trial_scheduled';
  o.status = 'claimed';
  o.claimedTeacher = { id: teacher.id, name: teacher.name };
  o.sessionId = trial.sessionId;
  o.closedAt = iso(Date.now());
}

const offerOr404 = (id: unknown) => offers.find((o) => o.id === Number(id)) ?? null;
const closed = (o: OfferRow) =>
  apiError(409, 'offer_closed', 'The offer is closed.', undefined, { status: o.status });

export const trialOfferHandlers: HttpHandler[] = [
  http.post(`${API}/leads/:id/trial-offers`, async ({ request, params }) => {
    const g = guard(request, 'leads.manage', 'schedule.manage');
    if ('error' in g) return g.error;
    const lead = crmdb.leads.find((l) => l.id === Number(params.id));
    if (!lead) return notFound();
    const parsed = createTrialOfferSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const v = parsed.data;
    expire();
    if (offers.some((o) => o.studentId === v.studentId && o.status === 'open')) {
      return apiError(409, 'offer_open', 'The student already has an open offer.');
    }
    const tz = v.timezone ?? lead.timezone;
    const startsAt = zonedUtc(v.localDate, v.localTime, tz);
    const list = trialTeachers(
      lead,
      { ...v, timezone: tz, durationMinutes: v.durationMinutes ?? 30 },
      startsAt,
    ).data.eligible;
    const chosen =
      v.audience === 'shortlist' ? list.filter((o) => v.teacherIds?.includes(o.teacher.id)) : list;
    if (!chosen.length) {
      return apiError(422, 'no_eligible_teachers', 'Nobody is eligible for this trial.');
    }
    const at = Date.parse(startsAt);
    const expiresAt = Math.min(
      Date.now() + (v.expiresInMinutes ?? 120) * MINUTE,
      at - 6 * 3_600_000,
    );
    if (expiresAt < Date.now() + 15 * MINUTE) {
      return apiError(422, 'offer_too_late', 'The offer would close too soon.');
    }
    const row: OfferRow = {
      id: nextId++,
      leadId: lead.id,
      studentId: v.studentId,
      course: courseRef(v.courseId),
      startsAt,
      durationMinutes: v.durationMinutes ?? 30,
      familyZone: tz,
      familyLocal: { date: v.localDate, time: v.localTime },
      policy: v.policy,
      audience: v.audience,
      status: 'open',
      expiresAt: iso(expiresAt),
      note: v.note ?? null,
      createdBy: { id: g.me.id, name: g.me.name },
      claimedTeacher: null,
      sessionId: null,
      closedAt: null,
      teachers: chosen.map((o) => ({
        teacher: { id: o.teacher.id, name: o.teacher.name },
        rank: o.rank,
        response: null,
        respondedAt: null,
      })),
      createdAt: iso(Date.now()),
    };
    offers.push(row);
    return HttpResponse.json({ data: present(row) }, { status: 201 });
  }),

  http.get(`${API}/leads/:id/trial-offers`, ({ request, params }) => {
    const g = guard(request, 'leads.view');
    if ('error' in g) return g.error;
    expire();
    const rows = offers
      .filter((o) => o.leadId === Number(params.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return HttpResponse.json({ data: rows.map(present) });
  }),

  http.get(`${API}/trial-offers/:id`, ({ request, params }) => {
    const g = guard(request, 'leads.view');
    if ('error' in g) return g.error;
    expire();
    const o = offerOr404(params.id);
    return o ? HttpResponse.json({ data: present(o) }) : notFound();
  }),

  http.post(`${API}/trial-offers/:id/assign`, async ({ request, params }) => {
    const g = guard(request, 'leads.manage', 'schedule.manage');
    if ('error' in g) return g.error;
    expire();
    const o = offerOr404(params.id);
    if (!o) return notFound();
    const parsed = assignTrialOfferSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    if (o.status !== 'open') return closed(o);
    if (!o.teachers.some((t) => t.teacher.id === parsed.data.teacherId)) {
      return apiError(422, 'validation_failed', 'The given data was invalid.', {
        teacherId: ['Choose one of the offer’s teachers.'],
      });
    }
    // The booking's own check for this teacher at this date: a clash refuses, warnings need a tick.
    const lead = crmdb.leads.find((l) => l.id === o.leadId)!;
    const weekday = ((new Date(`${o.familyLocal.date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    const check = checkSlot({
      studentId: o.studentId,
      teacherId: parsed.data.teacherId,
      weekday,
      localStartTime: o.familyLocal.time,
      durationMinutes: o.durationMinutes,
      timezone: o.familyZone ?? lead.timezone,
      validFrom: o.familyLocal.date,
    });
    if (check.conflicts.length) {
      return apiError(409, 'schedule_conflict', 'The class clashes.', undefined, check);
    }
    const ack = parsed.data.acknowledgeWarnings ?? [];
    if (check.warnings.some((w) => !ack.includes(w.code))) {
      return apiError(
        422,
        'warnings_not_acknowledged',
        'Acknowledge the warnings.',
        undefined,
        check,
      );
    }
    book(o, parsed.data.teacherId);
    return HttpResponse.json({ data: present(o) });
  }),

  http.post(`${API}/trial-offers/:id/resend`, async ({ request, params }) => {
    const g = guard(request, 'leads.manage', 'schedule.manage');
    if ('error' in g) return g.error;
    expire();
    const o = offerOr404(params.id);
    if (!o) return notFound();
    const parsed = resendTrialOfferSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    if (o.status !== 'open' && o.status !== 'expired') return closed(o);
    const at = Date.parse(o.startsAt);
    const expiresAt = Math.min(
      Date.now() + (parsed.data.expiresInMinutes ?? 120) * MINUTE,
      at - 6 * 3_600_000,
    );
    if (expiresAt < Date.now() + 15 * MINUTE) {
      return apiError(422, 'offer_too_late', 'The offer would close too soon.');
    }
    o.status = 'open';
    o.expiresAt = iso(expiresAt);
    o.closedAt = null;
    return HttpResponse.json({ data: present(o) });
  }),

  http.post(`${API}/trial-offers/:id/cancel`, async ({ request, params }) => {
    const g = guard(request, 'leads.manage', 'schedule.manage');
    if ('error' in g) return g.error;
    const o = offerOr404(params.id);
    if (!o) return notFound();
    const parsed = cancelTrialOfferSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    if (o.status !== 'open' && o.status !== 'expired') return closed(o);
    o.status = 'cancelled';
    o.closedAt = iso(Date.now());
    return HttpResponse.json({ data: present(o) });
  }),

  http.get(`${API}/me/trial-offers`, ({ request }) => {
    const g = guardAny(request, 'sessions.conduct');
    if ('error' in g) return g.error;
    const teacherId = ownTeacherId(g.me);
    if (!teacherId) return apiError(403, 'not_a_teacher', 'Only teachers have trial offers.');
    expire();
    const rows = offers
      .filter((o) => o.teachers.some((t) => t.teacher.id === teacherId))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    return HttpResponse.json({ data: rows.map((o) => presentMine(o, teacherId)) });
  }),

  http.post(`${API}/me/trial-offers/:id/:answer`, ({ request, params }) => {
    const g = guardAny(request, 'sessions.conduct');
    if ('error' in g) return g.error;
    const teacherId = ownTeacherId(g.me);
    if (!teacherId) return apiError(403, 'not_a_teacher', 'Only teachers have trial offers.');
    expire();
    const o = offerOr404(params.id);
    const mine = o?.teachers.find((t) => t.teacher.id === teacherId);
    if (!o || !mine) return notFound();
    if (o.status === 'claimed') return apiError(409, 'offer_taken', 'Another teacher took it.');
    if (o.status !== 'open') return closed(o);
    if (params.answer === 'decline') {
      mine.response = 'decline';
    } else if (params.answer === 'accept') {
      if (o.policy === 'volunteer') {
        mine.response = 'volunteer';
      } else {
        mine.response = 'accept';
        book(o, teacherId);
      }
    } else return notFound();
    mine.respondedAt = iso(Date.now());
    return HttpResponse.json({ data: presentMine(o, teacherId) });
  }),
];

// Seeded at load too (the browser mocks are not reset before first use), like crm-db.
resetTrialOffers();

/** For tests: the offers as stored (to set up a taken or volunteered offer). */
export const offersForTests = () => offers;
