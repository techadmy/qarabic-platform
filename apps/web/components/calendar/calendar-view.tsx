'use client';

import {
  SESSION_KIND_LABELS,
  SESSION_STAGE_LABELS,
  type CalendarBackgroundDto,
  type CalendarEventDto,
  type SessionStage,
} from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Badge } from '@qarabic/ui/components/badge';
import { Button } from '@qarabic/ui/components/button';
import { EventCalendar } from '@qarabic/ui/components/reui/event-calendar/event-calendar';
import { EventCalendarContent } from '@qarabic/ui/components/reui/event-calendar/event-calendar-content';
import { EventCalendarNav } from '@qarabic/ui/components/reui/event-calendar/event-calendar-nav';
import {
  EventCalendarDayView,
  EventCalendarWeekView,
} from '@qarabic/ui/components/reui/event-calendar/event-calendar-time-grid';
import type {
  CalendarEvent,
  CalendarView as ReuiView,
} from '@qarabic/ui/components/reui/event-calendar/event-calendar-types';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@qarabic/ui/components/sheet';
import { TooltipProvider } from '@qarabic/ui/components/tooltip';
import { useIsMobile } from '@qarabic/ui/hooks/use-mobile';
import { cn } from '@qarabic/ui/lib/utils';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ar, enUS } from '@qarabic/ui/lib/date-locales';
import {
  InfoIcon,
  ListFilterIcon,
  ListIcon,
  RefreshCwIcon,
  StarIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { RescheduleDialog, type MovableClass } from '@/components/sessions/reschedule-dialog';
import { SessionSheet, useOpenSession } from '@/components/sessions/session-sheet';
import { useNow, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { ErrorState, ForbiddenState } from '@/components/states';
import { calendarKeys, fetchCalendarBackground, fetchCalendarEvents } from '@/lib/api/calendar';
import { isApiError } from '@/lib/api/client';
import { can } from '@/lib/auth/use-me';
import { ACADEMY_TZ } from '@/lib/billing/labels';
import {
  calendarParams,
  calendarState,
  eventsQuery,
  viewRange,
  zoneOf,
  type CalendarState,
  type CalendarView,
} from '@/lib/calendar/view';
import { useListParams } from '@/lib/list-params';
import { intlLocale } from '@/lib/time';
import { dateKeyIn, hhmmIn, isoWeekday, zonedInstant } from '@/lib/schedule-time';
import { CalendarFilters } from './calendar-filters';
import { TrialBanner, TrialPickDialog, trialModeOf, useTrialTeachers } from './trial-pick';

/** URL view ↔ ReUI view. */
const TO_REUI: Record<CalendarView, ReuiView> = {
  month: 'month',
  week: 'week',
  day: 'day',
  list: 'agenda',
  teachers: 'resource',
};
const FROM_REUI: Partial<Record<ReuiView, CalendarView>> = {
  month: 'month',
  week: 'week',
  day: 'day',
  agenda: 'list',
  resource: 'teachers',
};

/**
 * An event's colour by its stage (D35, the old system's colours: taken green, running yellow,
 * absent red, leave violet, declined light blue), always with the stage in words beside it.
 */
const STAGE_COLOUR: Record<SessionStage, string> = {
  scheduled: 'var(--primary)',
  activated: 'var(--status-amber-emphasis)',
  in_progress: 'var(--status-amber-emphasis)',
  ended: 'var(--status-orange-emphasis)',
  taken: 'var(--status-green-emphasis)',
  absent: 'var(--status-red-emphasis)',
  leave: 'var(--status-violet-emphasis)',
  declined: 'var(--status-sky-emphasis)',
  cancelled: 'var(--muted-foreground)',
  moved_out: 'var(--muted-foreground)',
};

/** Classes have no all-day events: the empty «طوال اليوم» row is hidden. */
const WeekNoAllDay = () => <EventCalendarWeekView showAllDay={false} />;
const DayNoAllDay = () => <EventCalendarDayView showAllDay={false} />;

/** The stage colours in words, above the grid (D35: never colour alone). */
const LEGEND: SessionStage[] = [
  'scheduled',
  'in_progress',
  'ended',
  'taken',
  'absent',
  'leave',
  'declined',
  'cancelled',
];
function StageLegend() {
  const t = useTranslations('calendar');
  const locale = useUiLocale();
  return (
    <ul aria-label={t('legend')} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      {LEGEND.map((st) => (
        <li key={st} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-3 shrink-0 rounded-sm"
            style={{ background: STAGE_COLOUR[st] }}
          />
          {SESSION_STAGE_LABELS[st][locale]}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <StarIcon aria-hidden className="size-3.5" />
        {SESSION_KIND_LABELS.trial[locale]}
      </li>
      <li className="flex items-center gap-1.5">
        <RefreshCwIcon aria-hidden className="size-3.5" />
        {SESSION_KIND_LABELS.rescheduled[locale]}
      </li>
      <li className="flex items-center gap-1.5">
        <TriangleAlertIcon aria-hidden className="size-3.5" />
        {t('needsAttention')}
      </li>
    </ul>
  );
}

type Move = { event: CalendarEventDto; startsAt: string; durationMinutes: number };

/**
 * «الجدول» as a calendar (C2, docs/42 §3, D148/D149): ReUI Event Calendar (month, week, day,
 * agenda, and a teachers view with one column per chosen teacher), the classes of the range from
 * `GET /calendar/events`, the teacher's working hours, blocks and holidays shaded behind them
 * (`GET /calendar/background`), filters and the zone in the URL. A class opens the same sheet as
 * the board; dragging or resizing a scheduled class opens the move dialog (conflict check, «this
 * class / this and following», a reason): nothing moves before it is confirmed. A click on empty
 * time starts a new enrollment at that time.
 */
export function CalendarView() {
  const t = useTranslations('calendar');
  const locale = useUiLocale();
  const viewerTz = useViewerTz();
  const me = useCurrentUser();
  const router = useRouter();
  const params = useListParams();
  const { open } = useOpenSession();
  const allowed = can(me, 'schedule.view');
  const manage = can(me, 'sessions.manage');
  const isTeacher = me.role?.kind === 'teacher';

  // The zone first decides "today"; the teacher's/student's zone comes from the data.
  const rough = calendarState(params.get, dateKeyIn(ACADEMY_TZ));
  const [zoneHints, setZoneHints] = useState<{ teacher: string | null; student: string | null }>({
    teacher: null,
    student: null,
  });
  const tz = zoneOf(rough.zone, {
    academy: ACADEMY_TZ,
    mine: viewerTz,
    teacherTz: zoneHints.teacher,
    studentTz: zoneHints.student,
  });
  const today = dateKeyIn(tz);
  const isMobile = useIsMobile();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const parsed = calendarState(params.get, today);
  // Without a chosen view: phones open on the list (a 7-day grid is unreadable at 375 px); staff
  // with no teacher or student chosen open on the teachers view (a week of every teacher's classes
  // packs them too narrow to read or tap); a teacher on their own week.
  const defaultView: CalendarView = isMobile
    ? 'list'
    : !isTeacher && !parsed.teacherIds.length && !parsed.studentIds.length
      ? 'teachers'
      : 'week';
  const state = params.get('view') ? parsed : { ...parsed, view: defaultView };
  const set = (patch: Partial<CalendarState>) =>
    params.set(calendarParams(patch, today), { resetPage: false });

  const query = eventsQuery(state, tz);
  const events = useQuery({
    queryKey: calendarKeys.events(query),
    queryFn: ({ signal }) => fetchCalendarEvents(query, signal),
    enabled: allowed,
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const bgQuery = {
    ...viewRange(state.view, state.date, tz),
    ...(state.teacherIds.length ? { teacherIds: state.teacherIds } : {}),
  };
  const background = useQuery({
    queryKey: calendarKeys.background(bgQuery),
    queryFn: ({ signal }) => fetchCalendarBackground(bgQuery, signal),
    enabled: allowed,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });

  // The one chosen teacher's / student's zone, for the zone switch.
  const oneTeacher =
    state.teacherIds.length === 1
      ? (background.data?.teachers.find((x) => x.teacherId === state.teacherIds[0])?.timezone ??
        null)
      : null;
  const oneStudent =
    state.studentIds.length === 1
      ? (events.data?.events.find((e) => e.student.id === state.studentIds[0])?.student.timezone ??
        null)
      : null;
  if (oneTeacher !== zoneHints.teacher || oneStudent !== zoneHints.student) {
    setZoneHints({ teacher: oneTeacher, student: oneStudent });
  }

  const [move, setMove] = useState<Move | null>(null);
  // C3: picking a trial teacher on the teachers view (from the trial booking).
  const trial = trialModeOf(params.get);
  const trialTeachers = useTrialTeachers(trial, state.date, tz);
  const [trialPick, setTrialPick] = useState<{ at: Date; teacherId: number | null } | null>(null);
  const now = useNow(60_000);
  const reuiEvents = useMemo<CalendarEvent<CalendarEventDto>[]>(
    () =>
      (events.data?.events ?? []).map((e) => {
        const movable = manage && e.stage === 'scheduled' && Date.parse(e.startsAt) > now.getTime();
        const course = e.course ? (locale === 'ar' ? e.course.nameAr : e.course.nameEn) : null;
        return {
          id: String(e.id),
          // D35: the stage in words (never by colour alone), then kind and follow-up; this is
          // also the chip's tooltip and accessible name.
          title: [
            e.student.name,
            SESSION_STAGE_LABELS[e.stage][locale],
            e.kind === 'trial' || e.kind === 'rescheduled'
              ? SESSION_KIND_LABELS[e.kind][locale]
              : null,
            e.attention.length ? t('needsAttention') : null,
            course,
          ]
            .filter(Boolean)
            .join(' · '),
          start: new Date(e.startsAt),
          end: new Date(e.endsAt),
          color: STAGE_COLOUR[e.stage],
          draggable: movable,
          resizable: movable,
          readOnly: !movable,
          resourceId: String(e.teacher.id),
          data: e,
        };
      }),
    [events.data, manage, locale, now, t],
  );
  // The teachers view: the chosen teachers (or the first 12), one column each; picking a trial
  // teacher keeps the teachers who can take it (course, gender, age group, taking trials).
  const trialOk = new Set((trialTeachers.data ?? []).map((x) => x.id));
  const resources = (background.data?.teachers ?? [])
    .filter((x) => !state.teacherIds.length || state.teacherIds.includes(x.teacherId))
    .filter((x) => !trial || trialOk.has(x.teacherId))
    .slice(0, 12)
    .map((x) => ({ id: String(x.teacherId), title: x.name }));
  const holidays = background.data?.holidays ?? [];
  const capped = !state.teacherIds.length && (background.data?.teachers.length ?? 0) > 12;
  // A week of every teacher packs the classes too narrow: ask for teachers first.
  const weekOfEveryone =
    !isTeacher &&
    (state.view === 'week' || state.view === 'day') &&
    !state.teacherIds.length &&
    !state.studentIds.length;
  const shaded =
    state.teacherIds.length === 1
      ? background.data?.teachers.find((x) => x.teacherId === state.teacherIds[0])
      : undefined;

  if (!allowed || isApiError(events.error, 403)) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }

  const filters = (
    <CalendarFilters
      state={state}
      onChange={set}
      showTeachers={!isTeacher}
      stacked={isMobile}
      zones={{ academy: ACADEMY_TZ, mine: viewerTz, teacher: oneTeacher, student: oneStudent }}
    />
  );
  const activeFilters =
    state.teacherIds.length +
    state.studentIds.length +
    [state.courseId, state.kind, state.stage].filter(Boolean).length;

  // The date the view shows, as an instant at noon in the zone (safe across DST).
  const viewDate = new Date(zonedInstant(state.date, '12:00', tz));
  const isOffDay = (day: Date) => {
    const key = dateKeyIn(tz, day);
    return holidays.some(
      (h) => key >= dateKeyIn(tz, new Date(h.start)) && key < dateKeyIn(tz, new Date(h.end)),
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          can(me, 'schedule.view') && !isTeacher ? (
            <Button asChild variant="outline" className="h-10">
              <Link href="/schedule/enrollments">
                <ListIcon />
                {t('enrollments')}
              </Link>
            </Button>
          ) : undefined
        }
      />
      {isMobile ? (
        <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" className="h-10 w-fit">
              <ListFilterIcon />
              {t('filtersOpen')}
              {activeFilters > 0 && (
                <Badge variant="secondary" className="tabular-nums">
                  {activeFilters}
                </Badge>
              )}
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom" className="max-h-[85svh] overflow-y-auto">
            <SheetHeader>
              <SheetTitle>{t('filters.label')}</SheetTitle>
            </SheetHeader>
            <div className="px-4 pb-4">{filters}</div>
          </SheetContent>
        </Sheet>
      ) : (
        filters
      )}
      {events.data?.truncated && (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertDescription>{t('truncated')}</AlertDescription>
        </Alert>
      )}
      {events.isError && !events.data ? (
        <ErrorState onRetry={() => void events.refetch()} />
      ) : (
        <TooltipProvider>
          {weekOfEveryone && (
            <Alert>
              <InfoIcon />
              <AlertDescription className="flex flex-wrap items-center gap-2">
                {t('pickTeachers')}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => document.getElementById('calendar-teachers')?.click()}
                >
                  {t('pickTeachersAction')}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {state.view === 'teachers' && capped && (
            <p className="text-sm text-muted-foreground">{t('teachersCap')}</p>
          )}
          {trial && <TrialBanner mode={trial} />}
          <StageLegend />
          {/* The calendar's own day headings are h3 (agenda): an h2 above keeps the order. */}
          <h2 className="sr-only">{t('calendarLabel')}</h2>
          <div
            className="h-[75svh] min-h-[480px] overflow-hidden rounded-xl border bg-card"
            aria-busy={events.isFetching || undefined}
          >
            <EventCalendar<CalendarEventDto>
              className="h-full"
              events={reuiEvents}
              view={TO_REUI[state.view]}
              date={viewDate}
              views={[
                'month',
                'week',
                'day',
                'agenda',
                ...(isTeacher ? [] : ['resource' as const]),
              ]}
              resources={resources}
              timeZone={tz}
              locale={locale === 'ar' ? ar : enUS}
              weekStartsOn={6}
              scrollToHour={Math.max(
                0,
                Number(hhmmIn(new Date().toISOString(), tz).slice(0, 2)) - 2,
              )}
              slotDuration={60}
              snapDuration={15}
              loading={events.isPending}
              interactions={{ drag: manage, resize: manage, selectSlot: false }}
              offDays={{ weekendDays: [], isOffDay, className: 'bg-muted' }}
              // «+N أخرى» is a 24 px target at least (WCAG 2.2 target size).
              classNames={{
                moreIndicator: 'inline-flex min-h-6 items-center',
                // The day number at the top-start of a month cell (ui-ux), not the bottom.
                monthCellFooter: 'order-first justify-start pt-1.5 pb-0',
              }}
              i18n={{
                labels: {
                  today: t('nav.today'),
                  previous: t('nav.previous'),
                  next: t('nav.next'),
                  allDay: t('nav.allDay'),
                  more: (n: number) => t('nav.more', { count: n }),
                  noEvents: t('nav.noEvents'),
                  loading: t('nav.loading'),
                  selectView: t('nav.selectView'),
                  resources: t('nav.teachers'),
                  goToDate: t('nav.goToDate'),
                  dropNotAllowed: t('nav.dropNotAllowed'),
                },
                // Titles in the UI language with Intl (date-fns patterns read English-style).
                functions: {
                  formatTitle: (v, { date, activeRange }) => {
                    const fmt = (o: Intl.DateTimeFormatOptions) =>
                      new Intl.DateTimeFormat(intlLocale(locale), { ...o, timeZone: tz });
                    if (v === 'month') return fmt({ month: 'long', year: 'numeric' }).format(date);
                    if (v === 'day' || v === 'resource') {
                      return fmt({
                        weekday: 'long',
                        day: 'numeric',
                        month: 'long',
                        year: 'numeric',
                      }).format(date);
                    }
                    return fmt({ day: 'numeric', month: 'long', year: 'numeric' }).formatRange(
                      activeRange.start,
                      new Date(activeRange.end.getTime() - 1),
                    );
                  },
                },
                viewNames: {
                  month: t('views.month'),
                  week: t('views.week'),
                  day: t('views.day'),
                  agenda: t('views.list'),
                  resource: t('views.teachers'),
                },
              }}
              onViewChange={(v) => {
                const next = FROM_REUI[v];
                if (next) set({ view: next });
              }}
              onDateChange={(d) => set({ date: dateKeyIn(tz, d) })}
              onEventClick={(o) => open(Number(o.event.id))}
              // Our rules first: never into the past, never to another teacher by dragging
              // (the move dialog checks conflicts, work hours and holidays with the API).
              canDropEvent={(u) =>
                u.start.getTime() > now.getTime() &&
                (!u.resourceId || u.resourceId === u.event.resourceId)
              }
              onEventUpdate={(u) => {
                if (u.event.data) {
                  setMove({
                    event: u.event.data,
                    startsAt: u.start.toISOString(),
                    durationMinutes: Math.round((u.end.getTime() - u.start.getTime()) / 60_000),
                  });
                }
                // Nothing moves until the dialog is confirmed.
                return false;
              }}
              onSlotClick={(slot) => {
                if (slot.view === 'month') {
                  set({ view: 'day', date: dateKeyIn(tz, slot.date) });
                  return;
                }
                if (trial) {
                  setTrialPick({
                    at: slot.date,
                    teacherId: slot.resourceId ? Number(slot.resourceId) : null,
                  });
                  return;
                }
                if (!can(me, 'schedule.manage')) return;
                const teacherId =
                  slot.resourceId ??
                  (state.teacherIds.length === 1 ? String(state.teacherIds[0]) : '');
                const zone = oneStudent ?? tz;
                const at = slot.date.toISOString();
                const q = new URLSearchParams({
                  weekday: String(isoWeekday(dateKeyIn(zone, slot.date))),
                  time: hhmmIn(at, zone),
                  ...(teacherId ? { teacherId } : {}),
                  ...(state.studentIds.length === 1
                    ? { studentId: String(state.studentIds[0]) }
                    : {}),
                });
                router.push(`/schedule/new?${q}`);
              }}
              renderEvent={({ occurrence }) => {
                const e = occurrence.event.data;
                if (!e) return occurrence.event.title;
                return (
                  <span
                    className={cn(
                      'flex min-w-0 items-center gap-1 font-medium',
                      (e.stage === 'cancelled' || e.stage === 'moved_out') && 'line-through',
                    )}
                  >
                    {e.attention.length > 0 && (
                      <TriangleAlertIcon
                        aria-label={t('needsAttention')}
                        className="size-3 shrink-0"
                      />
                    )}
                    {e.kind === 'trial' && <StarIcon aria-hidden className="size-3 shrink-0" />}
                    {e.kind === 'rescheduled' && (
                      <RefreshCwIcon aria-hidden className="size-3 shrink-0" />
                    )}
                    <span className="truncate">{occurrence.event.title}</span>
                  </span>
                );
              }}
              // Outside working hours grey, blocks hatched: behind the one chosen teacher, and
              // behind each teacher's own column on the teachers view (free time stays white).
              renderDayColumnBackground={({ day, boundsStartMin, totalMinutes, resourceId }) => {
                const teacher = resourceId
                  ? background.data?.teachers.find((x) => String(x.teacherId) === resourceId)
                  : shaded;
                return teacher ? (
                  <DayShade
                    day={day}
                    startMin={boundsStartMin}
                    total={totalMinutes}
                    teacher={teacher}
                  />
                ) : null;
              }}
            >
              <EventCalendarNav />
              <EventCalendarContent components={{ week: WeekNoAllDay, day: DayNoAllDay }} />
            </EventCalendar>
          </div>
        </TooltipProvider>
      )}
      <SessionSheet />
      {trial && trialPick && (
        <TrialPickDialog
          key={`${trialPick.at.getTime()}-${trialPick.teacherId}`}
          mode={trial}
          at={trialPick.at}
          tz={tz}
          teacherId={trialPick.teacherId}
          onClose={() => setTrialPick(null)}
        />
      )}
      {move && (
        <RescheduleDialog
          key={`${move.event.id}-${move.startsAt}-${move.durationMinutes}`}
          session={move.event as MovableClass}
          open
          onOpenChange={(o) => !o && setMove(null)}
          initial={{ startsAt: move.startsAt, durationMinutes: move.durationMinutes }}
          zone={tz}
          requireReason
        />
      )}
    </div>
  );
}

/**
 * Behind one teacher's day: outside working hours in grey, blocks and leave hatched (docs/42
 * §3.2). Minutes are counted from the zoned day start the calendar gives.
 */
function DayShade({
  day,
  startMin,
  total,
  teacher,
}: {
  day: Date;
  startMin: number;
  total: number;
  teacher: CalendarBackgroundDto['teachers'][number];
}) {
  const t = useTranslations('calendar');
  const dayStart = day.getTime();
  const span = (s: string, e: string) => {
    const a = Math.max((Date.parse(s) - dayStart) / 60_000, startMin);
    const b = Math.min((Date.parse(e) - dayStart) / 60_000, startMin + total);
    return b > a ? { top: ((a - startMin) / total) * 100, height: ((b - a) / total) * 100 } : null;
  };
  const work = teacher.workHours
    .map((w) => span(w.start, w.end))
    .filter((x): x is { top: number; height: number } => !!x)
    .sort((a, b) => a.top - b.top);
  // Outside hours = the gaps between working spans.
  const off: { top: number; height: number }[] = [];
  let cursor = 0;
  for (const w of work) {
    if (w.top > cursor) off.push({ top: cursor, height: w.top - cursor });
    cursor = Math.max(cursor, w.top + w.height);
  }
  if (cursor < 100) off.push({ top: cursor, height: 100 - cursor });
  const blocks = teacher.blocks
    .map((b) => span(b.start, b.end))
    .filter((x): x is { top: number; height: number } => !!x);
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {off.map((o, i) => (
        <div
          key={`o${i}`}
          title={t('outsideHours')}
          className="absolute inset-x-0 bg-muted"
          style={{ top: `${o.top}%`, height: `${o.height}%` }}
        />
      ))}
      {blocks.map((b, i) => (
        <div
          key={`b${i}`}
          className="absolute inset-x-0 bg-muted"
          style={{
            top: `${b.top}%`,
            height: `${b.height}%`,
            backgroundImage:
              'repeating-linear-gradient(45deg, var(--border) 0 2px, transparent 2px 8px)',
          }}
        />
      ))}
    </div>
  );
}
