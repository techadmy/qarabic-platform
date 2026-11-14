'use client';

import {
  ATTENDANCE_SOURCE_LABELS,
  LEAVE_STATUSES,
  LEAVE_STATUS_LABELS,
  LEAVE_TYPE_LABELS,
  type AttendanceDto,
  type LeaveRequestDto,
  type LeaveStatus,
} from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { Label } from '@qarabic/ui/components/label';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@qarabic/ui/components/tabs';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import {
  CalendarPlusIcon,
  CalendarX2Icon,
  CheckIcon,
  InfoIcon,
  LogInIcon,
  LogOutIcon,
  PencilIcon,
  PlaneIcon,
  Undo2Icon,
  XIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { ColumnMeta } from '@/components/data-table';
import { DataTable } from '@/components/data-table';
import { FilterSelect, StatusTabs } from '@/components/list/list-toolbar';
import { fixFirstColumn, useColumnVisibility } from '@/components/list/column-chooser';
import { ResponsiveList } from '@/components/list/responsive-list';
import { PageHeader } from '@/components/page-header';
import { KeyFacts } from '@/components/people/detail';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import {
  checkIn,
  checkOut,
  decideLeave,
  fetchAttendance,
  fetchAttendanceToday,
  fetchLeaveRequests,
  payrollKeys,
} from '@/lib/api/payroll';
import { can } from '@/lib/auth/use-me';
import { useListParams } from '@/lib/list-params';
import {
  ACADEMY_TZ,
  clockIn,
  durationLabel,
  isPeriod,
  periodIn,
  workDayLabel,
} from '@/lib/payroll/labels';
import { dateKeyIn } from '@/lib/schedule-time';
import { formatDate, zoneLabel } from '@/lib/time';
import { LeaveRequestDialog, MarkDayDialog } from './dialogs';
import { AttendanceStatusBadge, LeaveStatusBadge, usePayrollError } from './payroll-bits';
import { MonthPicker } from '@/components/forms/date-time';

/**
 * Staff attendance and leave (docs/21 §5, §13; the current app's `AttendancePage`). Managers
 * (`attendance.manage`) get the month per person (summary → one person's days, mark or correct a
 * day with a reason) and the leave queue (pending first, approve / reject with a note); everyone
 * gets their own day (check in / check out, server clock) and can request leave. Teachers and
 * staff without `attendance.manage` see «حضوري وإجازاتي», mobile-first.
 */

// ------------------------------------------------------------------ my day

export function TodayCard() {
  const t = useTranslations('payroll.attendance');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const queryClient = useQueryClient();
  const message = usePayrollError();
  const today = useQuery({
    queryKey: payrollKeys.today,
    queryFn: ({ signal }) => fetchAttendanceToday(signal),
  });
  const done = (text: string) => () => {
    void queryClient.invalidateQueries({ queryKey: payrollKeys.all });
    toast.success(text);
  };
  const inMut = useMutation({ mutationFn: checkIn, onSuccess: done(t('checkedInToast')) });
  const outMut = useMutation({ mutationFn: checkOut, onSuccess: done(t('checkedOutToast')) });
  const busy = inMut.isPending || outMut.isPending;
  const failure = inMut.error ?? outMut.error;

  if (today.isError) {
    return <ErrorState onRetry={() => void today.refetch()} />;
  }
  if (!today.data) return <Skeleton className="h-40 rounded-xl" />;
  const { record, onLeave, date, timezone } = today.data;
  const checkedIn = !!record?.checkInAt;
  const checkedOut = !!record?.checkOutAt;
  const marked = record && !checkedIn ? record.status : null;

  return (
    <Card className="gap-3 shadow-none">
      <CardHeader>
        <CardTitle className="text-base font-bold">
          <h2>{t('today')}</h2>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {t('todayFor', { date: formatDate(date, locale) ?? date })}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div role="status" className="flex flex-col gap-1">
          {onLeave ? (
            <p className="font-semibold">{t('onLeave')}</p>
          ) : marked ? (
            <p className="font-semibold">{t('marked', { status: t(marked) })}</p>
          ) : !checkedIn ? (
            <p className="font-semibold">{t('notYet')}</p>
          ) : (
            <>
              <p className="font-semibold">
                {t('checkedIn', { time: clockIn(record!.checkInAt, tz, locale) })}
              </p>
              {checkedOut && (
                <p className="text-muted-foreground">
                  {t('checkedOut', { time: clockIn(record!.checkOutAt, tz, locale) })} ·{' '}
                  {t('dayDone', { duration: durationLabel(record!.workedMinutes) })}
                </p>
              )}
            </>
          )}
        </div>
        {!onLeave && !marked && !checkedOut && (
          <Button
            size="lg"
            className="h-12 w-full text-base sm:w-auto sm:self-start sm:px-8"
            disabled={busy}
            onClick={() => (checkedIn ? outMut.mutate() : inMut.mutate())}
          >
            {busy ? (
              <Spinner />
            ) : checkedIn ? (
              <LogOutIcon className="rtl:-scale-x-100" />
            ) : (
              <LogInIcon className="rtl:-scale-x-100" />
            )}
            {checkedIn ? t('checkOut') : t('checkIn')}
          </Button>
        )}
        {failure && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{message(failure)}</AlertDescription>
          </Alert>
        )}
        <p className="text-sm text-muted-foreground">
          {t('zoneHint', { zone: zoneLabel(timezone, locale) })}
        </p>
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ leave list

type LeaveAction = { leave: LeaveRequestDto; action: 'approve' | 'reject' | 'cancel' };

function LeaveActions({
  leave,
  onAction,
}: {
  leave: LeaveRequestDto;
  onAction: (a: LeaveAction) => void;
}) {
  const t = useTranslations('payroll.leave');
  const name = leave.user.name;
  return (
    <div className="flex flex-wrap gap-2">
      {leave.can.decide && (
        <>
          <Button
            size="sm"
            className="h-8"
            aria-label={`${t('approve')}: ${name}`}
            onClick={() => onAction({ leave, action: 'approve' })}
          >
            <CheckIcon />
            {t('approve')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            aria-label={`${t('reject')}: ${name}`}
            onClick={() => onAction({ leave, action: 'reject' })}
          >
            <XIcon />
            {t('reject')}
          </Button>
        </>
      )}
      {leave.can.cancel && !leave.can.decide && (
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          onClick={() => onAction({ leave, action: 'cancel' })}
        >
          <Undo2Icon className="rtl:-scale-x-100" />
          {t('cancel')}
        </Button>
      )}
    </div>
  );
}

/** Leave requests (pending first) with status tabs; managers decide, owners withdraw. */
export function LeaveList({ mine }: { mine?: boolean }) {
  const t = useTranslations('payroll');
  const locale = useUiLocale();
  const queryClient = useQueryClient();
  const message = usePayrollError();
  const me = useCurrentUser();
  const [columnVisibility, setColumnVisibility] = useColumnVisibility(
    `leave${mine ? '-mine' : ''}:${me.id}`,
  );
  const [status, setStatus] = useState<LeaveStatus | ''>('');
  const [acting, setActing] = useState<LeaveAction | null>(null);
  const query = { status: status || undefined, perPage: 50 };
  const list = useQuery({
    queryKey: payrollKeys.leave(query),
    queryFn: ({ signal }) => fetchLeaveRequests(query, signal),
    placeholderData: keepPreviousData,
  });
  const decide = useMutation({
    mutationFn: (v: { id: number; action: LeaveAction['action']; note: string | null }) =>
      decideLeave(v.id, v.action, v.note),
    onSuccess: (_, v) => {
      void queryClient.invalidateQueries({ queryKey: payrollKeys.all });
      toast.success(
        t(
          `leave.${v.action === 'approve' ? 'approved' : v.action === 'reject' ? 'rejected' : 'cancelled'}`,
        ),
      );
      setActing(null);
    },
  });
  const rows = list.data?.data ?? [];
  const counts = list.data?.meta.counts;
  const range = (l: LeaveRequestDto) =>
    t('leave.range', {
      from: formatDate(l.startsOn, locale) ?? l.startsOn,
      to: formatDate(l.endsOn, locale) ?? l.endsOn,
    });

  const columns = useMemo<ColumnDef<LeaveRequestDto, unknown>[]>(
    () => [
      ...(mine
        ? []
        : [
            {
              id: 'person',
              header: t('person'),
              cell: ({ row: { original: l } }) => (
                <span className="font-semibold">{l.user.name}</span>
              ),
            } satisfies ColumnDef<LeaveRequestDto, unknown>,
          ]),
      {
        id: 'range',
        header: t('date'),
        cell: ({ row: { original: l } }) => <span className="whitespace-nowrap">{range(l)}</span>,
      },
      {
        id: 'days',
        header: t('days'),
        meta: { numeric: true } satisfies ColumnMeta,
        cell: ({ row: { original: l } }) => <bdi>{l.days}</bdi>,
      },
      {
        id: 'type',
        header: t('leave.type'),
        cell: ({ row: { original: l } }) => LEAVE_TYPE_LABELS[l.leaveType][locale],
      },
      {
        id: 'reason',
        header: t('reason'),
        cell: ({ row: { original: l } }) => (
          <span className="block max-w-72 break-words whitespace-normal">
            <span className="block" dir="auto">
              {l.reason}
            </span>
            {l.decisionNote && (
              <span className="block text-muted-foreground">
                {t('leave.decision')}: <bdi>{l.decisionNote}</bdi>
              </span>
            )}
          </span>
        ),
      },
      {
        id: 'status',
        header: t('status'),
        cell: ({ row: { original: l } }) => <LeaveStatusBadge status={l.status} />,
      },
      {
        id: 'actions',
        header: t('actions'),
        cell: ({ row: { original: l } }) => <LeaveActions leave={l} onAction={setActing} />,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `range` only reads t and locale
    [t, locale, mine],
  );

  return (
    <Card className="gap-0 py-0 shadow-none">
      <div className="flex flex-col gap-3 border-b p-4">
        <h2 className="text-base font-bold">{mine ? t('leave.mine') : t('leave.title')}</h2>
        <div className="-mx-1 overflow-x-auto px-1 pb-0.5">
          <StatusTabs
            label={t('leave.tabs')}
            value={status}
            onChange={(v) => setStatus(v as LeaveStatus | '')}
            options={[
              { value: '', label: t('leave.all'), count: counts?.all },
              ...LEAVE_STATUSES.map((s) => ({
                value: s,
                label: LEAVE_STATUS_LABELS[s][locale],
                count: counts?.[s],
              })),
            ]}
          />
        </div>
      </div>
      {list.isError ? (
        <div className="p-4">
          <ErrorState onRetry={() => void list.refetch()} />
        </div>
      ) : !list.isPending && rows.length === 0 ? (
        <div className="p-4">
          <EmptyState icon={PlaneIcon} title={t('leave.none')} description={t('leave.noneHint')} />
        </div>
      ) : (
        <ResponsiveList
          columns={fixFirstColumn(columns)}
          rows={rows}
          loading={list.isPending}
          label={t('leave.table')}
          emptyText={t('leave.none')}
          getRowId={(l) => l.id}
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={setColumnVisibility}
          renderCard={(l) => (
            <div className="flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 font-semibold">
                  {mine ? LEAVE_TYPE_LABELS[l.leaveType][locale] : l.user.name}
                </span>
                <LeaveStatusBadge status={l.status} />
              </div>
              <span className="text-sm text-muted-foreground">
                {range(l)} · {t('daysCount', { count: l.days })}
              </span>
              <span className="text-sm break-words" dir="auto">
                {l.reason}
              </span>
              {l.decisionNote && (
                <span className="text-sm text-muted-foreground" dir="auto">
                  {t('leave.decision')}: <bdi>{l.decisionNote}</bdi>
                </span>
              )}
              <LeaveActions leave={l} onAction={setActing} />
            </div>
          )}
        />
      )}
      {acting && (
        <ReasonDialog
          open
          destructive={acting.action !== 'approve'}
          onOpenChange={(o) => {
            if (!o) {
              setActing(null);
              decide.reset();
            }
          }}
          title={
            acting.action === 'approve'
              ? t('leave.approveTitle', { name: acting.leave.user.name })
              : acting.action === 'reject'
                ? t('leave.rejectTitle', { name: acting.leave.user.name })
                : t('leave.cancelTitle')
          }
          description={
            acting.action === 'approve'
              ? t('leave.approveBody', { range: range(acting.leave) })
              : acting.action === 'reject'
                ? t('leave.rejectBody')
                : t('leave.cancelBody', { range: range(acting.leave) })
          }
          confirmLabel={t(`leave.${acting.action}`)}
          textLabel={acting.action === 'approve' ? t('leave.approveNote') : t('reason')}
          textRequired={acting.action !== 'approve'}
          textMin={acting.action === 'approve' ? undefined : 3}
          busy={decide.isPending}
          error={decide.isError ? message(decide.error) : null}
          onConfirm={({ text }) =>
            decide.mutate({ id: acting.leave.id, action: acting.action, note: text || null })
          }
        />
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ days

function MonthInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useTranslations('payroll');
  const id = useId();
  return (
    <div className="flex min-w-40 flex-col gap-1.5">
      <Label htmlFor={id} className="text-caption text-muted-foreground">
        {t('month')}
      </Label>
      <MonthPicker id={id} value={value} onChange={onChange} />
    </div>
  );
}

function DaysTable({
  rows,
  loading,
  onMark,
}: {
  rows: AttendanceDto[];
  loading: boolean;
  onMark?: (row: AttendanceDto) => void;
}) {
  const t = useTranslations('payroll');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const columns = useMemo<ColumnDef<AttendanceDto, unknown>[]>(
    () => [
      {
        id: 'date',
        header: t('date'),
        cell: ({ row: { original: r } }) => (
          <span className="whitespace-nowrap">{workDayLabel(r.workDate, locale)}</span>
        ),
      },
      {
        id: 'status',
        header: t('status'),
        cell: ({ row: { original: r } }) => (
          <span className="flex flex-wrap items-center gap-1">
            <AttendanceStatusBadge status={r.status} />
            {r.deductible && (
              <span className="text-caption text-destructive">{t('attendance.deductedDay')}</span>
            )}
          </span>
        ),
      },
      {
        id: 'in',
        header: t('attendance.checkInAt'),
        cell: ({ row: { original: r } }) => <bdi>{clockIn(r.checkInAt, tz, locale)}</bdi>,
      },
      {
        id: 'out',
        header: t('attendance.checkOutAt'),
        cell: ({ row: { original: r } }) => <bdi>{clockIn(r.checkOutAt, tz, locale)}</bdi>,
      },
      {
        id: 'worked',
        header: t('attendance.worked'),
        meta: { numeric: true } satisfies ColumnMeta,
        cell: ({ row: { original: r } }) => <bdi dir="ltr">{durationLabel(r.workedMinutes)}</bdi>,
      },
      {
        id: 'source',
        header: t('attendance.source'),
        cell: ({ row: { original: r } }) => (
          <span className="text-muted-foreground">
            {ATTENDANCE_SOURCE_LABELS[r.source][locale]}
            {r.note && (
              <span className="block break-words" dir="auto">
                {r.note}
              </span>
            )}
          </span>
        ),
      },
      ...(onMark
        ? [
            {
              id: 'actions',
              header: t('actions'),
              cell: ({ row: { original: r } }) => (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  aria-label={t('attendance.markDayFor', {
                    date: formatDate(r.workDate, locale) ?? r.workDate,
                    name: r.user.name,
                  })}
                  onClick={() => onMark(r)}
                >
                  <PencilIcon />
                  {t('attendance.markDay')}
                </Button>
              ),
            } satisfies ColumnDef<AttendanceDto, unknown>,
          ]
        : []),
    ],
    [t, locale, tz, onMark],
  );
  return (
    <ResponsiveList
      columns={columns}
      rows={rows}
      loading={loading}
      label={t('attendance.daysTable')}
      emptyText={t('attendance.noDays')}
      getRowId={(r) => r.id}
      renderCard={(r) => (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-start justify-between gap-2">
            <span className="font-semibold">{workDayLabel(r.workDate, locale)}</span>
            <AttendanceStatusBadge status={r.status} />
          </div>
          {r.checkInAt && (
            <span className="text-sm text-muted-foreground">
              {t('attendance.checkInAt')} <bdi>{clockIn(r.checkInAt, tz, locale)}</bdi> ·{' '}
              {t('attendance.checkOutAt')} <bdi>{clockIn(r.checkOutAt, tz, locale)}</bdi> ·{' '}
              <bdi dir="ltr">{durationLabel(r.workedMinutes)}</bdi>
            </span>
          )}
          {r.deductible && (
            <span className="text-sm text-destructive">{t('attendance.deductedDay')}</span>
          )}
          {onMark && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 self-start"
              aria-label={t('attendance.markDayFor', {
                date: formatDate(r.workDate, locale) ?? r.workDate,
                name: r.user.name,
              })}
              onClick={() => onMark(r)}
            >
              <PencilIcon />
              {t('attendance.markDay')}
            </Button>
          )}
        </div>
      )}
    />
  );
}

// ------------------------------------------------------------------ staff view

/** `/attendance` for staff with `attendance.manage`: own day, month per person, leave queue. */
export function AttendanceView() {
  const t = useTranslations('payroll');
  const me = useCurrentUser();
  const params = useListParams();
  const manage = can(me, 'attendance.manage');
  const tab = params.get('tab') === 'leave' ? 'leave' : 'days';
  const monthParam = params.get('month');
  const month = isPeriod(monthParam) ? monthParam : periodIn(ACADEMY_TZ);
  const userId = Number(params.get('user')) || null;
  const [leaveOpen, setLeaveOpen] = useState<null | 'own' | 'other'>(null);
  const [marking, setMarking] = useState<null | {
    person: { id: number; name: string };
    date: string;
    row?: AttendanceDto;
  }>(null);
  const query = { month, userId: userId ?? undefined };
  const list = useQuery({
    queryKey: payrollKeys.attendance(query),
    queryFn: ({ signal }) => fetchAttendance(query, signal),
    placeholderData: keepPreviousData,
    enabled: manage,
  });
  const people = useQuery({
    queryKey: payrollKeys.attendance({ month, summary: true }),
    queryFn: ({ signal }) => fetchAttendance({ month }, signal),
    enabled: manage,
  });
  const pending = useQuery({
    queryKey: payrollKeys.leave({ status: 'pending', perPage: 1 }),
    queryFn: ({ signal }) => fetchLeaveRequests({ status: 'pending', perPage: 1 }, signal),
    enabled: manage,
  });

  if (!manage || isApiError(list.error, 403)) {
    return (
      <>
        <PageHeader title={t('attendance.title')} />
        <ForbiddenState />
      </>
    );
  }

  const summary = people.data?.meta.summary ?? [];
  const selected = summary.find((s) => s.user.id === userId)?.user;
  const pendingCount = pending.data?.meta.counts.pending;

  return (
    <>
      <PageHeader
        title={t('attendance.title')}
        meta={pendingCount ? t('leave.pendingHint', { count: pendingCount }) : undefined}
        actions={
          <>
            <Button variant="outline" className="h-10" onClick={() => setLeaveOpen('other')}>
              <CalendarPlusIcon />
              {t('leave.requestFor')}
            </Button>
            {can(me, 'attendance.request') && (
              <Button variant="outline" className="h-10" onClick={() => setLeaveOpen('own')}>
                <PlaneIcon />
                {t('leave.request')}
              </Button>
            )}
          </>
        }
      />
      {can(me, 'attendance.request') && <TodayCard />}
      <Tabs
        value={tab}
        onValueChange={(v) => params.set({ tab: v === 'leave' ? 'leave' : null })}
        className="gap-4"
      >
        <TabsList aria-label={t('attendance.tabs')}>
          <TabsTrigger value="days">{t('attendance.tabDays')}</TabsTrigger>
          <TabsTrigger value="leave">
            {t('attendance.tabLeave')}
            {pendingCount ? <bdi className="tabular-nums"> ({pendingCount})</bdi> : null}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="days">
          <Card className="gap-0 py-0 shadow-none">
            <div className="flex flex-wrap items-end gap-3 border-b p-4">
              <MonthInput value={month} onChange={(v) => params.set({ month: v })} />
              <FilterSelect
                label={t('person')}
                value={userId ? String(userId) : ''}
                onChange={(v) => params.set({ user: v || null })}
                allLabel={t('allPeople')}
                options={summary.map((s) => ({ value: String(s.user.id), label: s.user.name }))}
                className="flex min-w-48 flex-col gap-1.5"
              />
              {selected && (
                <Button
                  className="h-10"
                  onClick={() =>
                    setMarking({
                      person: selected,
                      date: periodIn(ACADEMY_TZ) === month ? dateKeyIn(ACADEMY_TZ) : `${month}-01`,
                    })
                  }
                >
                  <CalendarX2Icon />
                  {t('attendance.markDay')}
                </Button>
              )}
            </div>
            {list.isError ? (
              <div className="p-4">
                <ErrorState onRetry={() => void list.refetch()} />
              </div>
            ) : userId ? (
              <>
                <h2 className="sr-only">
                  {t('attendance.personDays', { name: selected?.name ?? '' })}
                </h2>
                <DaysTable
                  rows={list.data?.data ?? []}
                  loading={list.isPending}
                  onMark={(r) => setMarking({ person: r.user, date: r.workDate, row: r })}
                />
              </>
            ) : (
              <SummaryTable
                rows={list.data?.meta.summary ?? []}
                loading={list.isPending}
                onOpen={(id) => params.set({ user: String(id) })}
              />
            )}
          </Card>
          <p className="mt-3 flex items-start gap-2 text-sm text-muted-foreground">
            <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t('attendance.deductibleHint')}
          </p>
        </TabsContent>
        <TabsContent value="leave">
          <LeaveList />
        </TabsContent>
      </Tabs>
      {leaveOpen && (
        <LeaveRequestDialog
          open
          forSomeone={leaveOpen === 'other'}
          onOpenChange={(o) => !o && setLeaveOpen(null)}
        />
      )}
      {marking && (
        <MarkDayDialog
          open
          onOpenChange={(o) => !o && setMarking(null)}
          person={marking.person}
          date={marking.date}
          current={marking.row}
        />
      )}
    </>
  );
}

type SummaryRow = NonNullable<
  Awaited<ReturnType<typeof fetchAttendance>>
>['meta']['summary'][number];

function SummaryTable({
  rows,
  loading,
  onOpen,
}: {
  rows: SummaryRow[];
  loading: boolean;
  onOpen: (userId: number) => void;
}) {
  const t = useTranslations('payroll');
  const num = { numeric: true } satisfies ColumnMeta;
  const columns = useMemo<ColumnDef<SummaryRow, unknown>[]>(
    () => [
      {
        id: 'person',
        header: t('person'),
        cell: ({ row: { original: r } }) => (
          <Button
            variant="link"
            className="h-auto p-0 font-semibold"
            aria-label={t('attendance.showDays', { name: r.user.name })}
            onClick={() => onOpen(r.user.id)}
          >
            {r.user.name}
          </Button>
        ),
      },
      {
        id: 'present',
        header: t('attendance.present'),
        meta: num,
        cell: (c) => c.row.original.present,
      },
      {
        id: 'absent',
        header: t('attendance.absent'),
        meta: num,
        cell: (c) => c.row.original.absent,
      },
      { id: 'leave', header: t('attendance.leave'), meta: num, cell: (c) => c.row.original.leave },
      {
        id: 'holiday',
        header: t('attendance.holiday'),
        meta: num,
        cell: (c) => c.row.original.holiday,
      },
      {
        id: 'deductible',
        header: t('attendance.deductible'),
        meta: num,
        cell: ({ row: { original: r } }) => (
          <span className={r.deductibleDays ? 'font-semibold text-destructive' : undefined}>
            {r.deductibleDays}
          </span>
        ),
      },
      {
        id: 'worked',
        header: t('attendance.worked'),
        meta: num,
        cell: ({ row: { original: r } }) => <bdi dir="ltr">{durationLabel(r.workedMinutes)}</bdi>,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `num` is a constant
    [t, onOpen],
  );
  return (
    <DataTable
      bare
      columns={columns}
      data={rows}
      loading={loading}
      label={t('attendance.summaryTable')}
      emptyText={t('attendance.noPeople')}
    />
  );
}

// ------------------------------------------------------------------ my attendance

/** «حضوري وإجازاتي» (teacher portal, mobile-first): my day, my month, my leave. */
export function MyAttendanceView() {
  const t = useTranslations('payroll');
  const me = useCurrentUser();
  const params = useListParams();
  const allowed = can(me, 'attendance.request');
  const monthParam = params.get('month');
  const month = isPeriod(monthParam) ? monthParam : periodIn(ACADEMY_TZ);
  const [requesting, setRequesting] = useState(false);
  const query = { month };
  const list = useQuery({
    queryKey: payrollKeys.attendance(query),
    queryFn: ({ signal }) => fetchAttendance(query, signal),
    placeholderData: keepPreviousData,
    enabled: allowed,
  });
  if (!allowed) {
    return (
      <>
        <PageHeader title={t('attendance.myTitle')} />
        <ForbiddenState />
      </>
    );
  }
  const mine = list.data?.meta.summary[0];
  return (
    <>
      <PageHeader
        title={t('attendance.myTitle')}
        actions={
          <Button className="h-10" onClick={() => setRequesting(true)}>
            <PlaneIcon />
            {t('leave.request')}
          </Button>
        }
      />
      <TodayCard />
      <section aria-labelledby="my-month" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="my-month" className="text-base font-bold">
            {t('attendance.summary')}
          </h2>
          <MonthInput value={month} onChange={(v) => params.set({ month: v })} />
        </div>
        {mine && (
          <KeyFacts
            items={[
              { label: t('attendance.present'), value: <bdi>{mine.present}</bdi> },
              { label: t('attendance.absent'), value: <bdi>{mine.absent}</bdi> },
              { label: t('attendance.leave'), value: <bdi>{mine.leave}</bdi> },
              {
                label: t('attendance.worked'),
                value: <bdi dir="ltr">{durationLabel(mine.workedMinutes)}</bdi>,
              },
            ]}
          />
        )}
        <Card className="gap-0 py-0 shadow-none">
          {list.isError ? (
            <div className="p-4">
              <ErrorState onRetry={() => void list.refetch()} />
            </div>
          ) : (
            <DaysTable rows={list.data?.data ?? []} loading={list.isPending} />
          )}
        </Card>
      </section>
      <LeaveList mine />
      {requesting && <LeaveRequestDialog open onOpenChange={setRequesting} />}
    </>
  );
}
