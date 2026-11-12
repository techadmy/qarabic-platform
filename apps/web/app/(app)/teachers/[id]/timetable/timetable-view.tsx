'use client';

import {
  TEACHER_BLOCK_KIND_LABELS,
  TEACHER_BLOCK_REASON_LABELS,
  TEACHER_BLOCK_REASONS,
  type TeacherBlockDto,
  type TeacherBlockKind,
  type TeacherBlockReason,
  type WorkHourDto,
} from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Badge } from '@qarabic/ui/components/badge';
import { Button } from '@qarabic/ui/components/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@qarabic/ui/components/card';
import { Field, FieldGroup, FieldLabel } from '@qarabic/ui/components/field';
import { Input } from '@qarabic/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Spinner } from '@qarabic/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@qarabic/ui/components/table';
import { ToggleGroup, ToggleGroupItem } from '@qarabic/ui/components/toggle-group';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon, CalendarXIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { TimeSelect } from '@/components/forms/date-time';
import { PageHeader } from '@/components/page-header';
import { ProfileSkeleton } from '@/components/people/detail';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import {
  createBlock,
  deleteBlock,
  fetchTimetable,
  replaceWorkHours,
  scheduleKeys,
} from '@/lib/api/schedule';
import { can } from '@/lib/auth/use-me';
import { refreshClasses } from '@/lib/sessions/cache';
import { useClassError } from '@/lib/sessions/errors';
import {
  dateKeyIn,
  dayAndClock,
  otherSideOf,
  STAFF_WEEK,
  wallTime,
  weekdayName,
} from '@/lib/schedule-time';
import { cityOf } from '@/lib/time';

/**
 * A teacher's week (docs/15 §3.1 K5 "teacher row → Schedule", §6.3; the current app's
 * `TeacherTimetablePage`): the weekly times by day in the teacher's zone or the viewer's, then
 * the work hours (edited as a set) and the blocked times (add / remove, confirmed).
 */
export function TimetableView({ id, mine }: { id: number; mine?: boolean }) {
  const t = useTranslations('timetable');
  const locale = useUiLocale();
  const viewerTz = useViewerTz();
  const me = useCurrentUser();
  const [zone, setZone] = useState<'teacher' | 'mine'>('teacher');
  const query = useQuery({
    queryKey: scheduleKeys.timetable(id, {}),
    queryFn: ({ signal }) => fetchTimetable(id, {}, signal),
    enabled: Number.isInteger(id) && id > 0,
  });
  if (!can(me, 'schedule.view') && !can(me, 'sessions.conduct')) return <ForbiddenState />;
  if (isApiError(query.error, 403)) return <ForbiddenState />;
  if (isApiError(query.error, 404)) {
    return (
      <EmptyState
        icon={CalendarXIcon}
        role="alert"
        title={t('notFoundTitle')}
        description={t('notFound')}
      />
    );
  }
  if (query.isError) return <ErrorState onRetry={() => void query.refetch()} />;
  if (query.isPending) return <ProfileSkeleton />;
  const data = query.data;
  const tz = zone === 'teacher' ? data.teacher.timezone : viewerTz;
  const today = dateKeyIn(tz);
  const shown = data.slots.map((s) => ({ s, side: otherSideOf(s, tz, today) }));
  const canManage = can(me, 'schedule.manage');

  return (
    <>
      <PageHeader
        back={mine ? undefined : { href: `/teachers/${id}`, label: t('back') }}
        title={mine ? t('mineTitle') : t('title', { name: data.teacher.name })}
        meta={t('zoneNote', { city: cityOf(tz, locale) })}
        actions={
          data.teacher.timezone !== viewerTz ? (
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={0}
              aria-label={t('showIn')}
              value={zone}
              onValueChange={(v) => v && setZone(v as 'teacher' | 'mine')}
              className="bg-card"
            >
              <ToggleGroupItem
                value="teacher"
                className="h-9 px-3 data-[state=on]:bg-accent data-[state=on]:font-semibold"
              >
                {t('teacherZone', { city: cityOf(data.teacher.timezone, locale) })}
              </ToggleGroupItem>
              <ToggleGroupItem
                value="mine"
                className="h-9 px-3 data-[state=on]:bg-accent data-[state=on]:font-semibold"
              >
                {t('myZone', { city: cityOf(viewerTz, locale) })}
              </ToggleGroupItem>
            </ToggleGroup>
          ) : undefined
        }
      />
      <Card className="gap-0 py-0 shadow-none">
        <CardHeader className="border-b py-4">
          <CardTitle className="text-base font-bold">{t('weekTitle')}</CardTitle>
          <CardDescription>{t('weekHint', { count: data.slots.length })}</CardDescription>
        </CardHeader>
        <div className="overflow-x-auto">
          <Table aria-label={t('weekTitle')}>
            <TableHeader>
              <TableRow className="bg-subtle hover:bg-subtle">
                <TableHead className="w-28 px-3 font-semibold text-muted-foreground">
                  {t('day')}
                </TableHead>
                <TableHead className="px-3 font-semibold text-muted-foreground">
                  {t('classes')}
                </TableHead>
                <TableHead className="w-48 px-3 font-semibold text-muted-foreground">
                  {t('workHours')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {STAFF_WEEK.map((d) => {
                const items = shown
                  .filter((x) => x.side.weekday === d)
                  .sort((a, b) => a.side.time.localeCompare(b.side.time));
                const hours = data.workHours.filter((w) => w.weekday === d);
                return (
                  <TableRow key={d}>
                    <TableCell className="px-3 align-top font-semibold">
                      {weekdayName(d, locale)}
                    </TableCell>
                    <TableCell className="px-3 whitespace-normal">
                      {items.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className="flex flex-wrap gap-1.5">
                          {items.map(({ s, side }) => (
                            <Badge
                              key={s.id}
                              variant="outline"
                              className="h-auto gap-1.5 px-2 py-1 text-caption font-normal whitespace-normal"
                            >
                              <bdi className="font-semibold">{wallTime(side.time, locale)}</bdi>
                              <span>{s.label}</span>
                            </Badge>
                          ))}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="px-3 text-sm whitespace-normal text-muted-foreground">
                      {hours.length
                        ? hours
                            .map(
                              (h) =>
                                `${wallTime(h.localStartTime, locale)} – ${wallTime(h.localEndTime, locale)}`,
                            )
                            .join('، ')
                        : '—'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </Card>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <WorkHoursCard
          // Saved hours come back from the server: start the editor again from them.
          key={JSON.stringify(data.workHours)}
          teacherId={id}
          hours={data.workHours}
          timezone={data.teacher.timezone}
          editable={canManage || !!mine}
        />
        <BlocksCard
          teacherId={id}
          blocks={data.blocks}
          timezone={data.teacher.timezone}
          editable={canManage}
        />
      </div>
    </>
  );
}

type HourRow = { weekday: number; localStartTime: string; localEndTime: string };

function WorkHoursCard({
  teacherId,
  hours,
  timezone,
  editable,
}: {
  teacherId: number;
  hours: WorkHourDto[];
  timezone: string;
  editable: boolean;
}) {
  const t = useTranslations('timetable');
  const locale = useUiLocale();
  const queryClient = useQueryClient();
  const message = useClassError();
  const [rows, setRows] = useState<HourRow[]>(() =>
    hours.map(({ weekday, localStartTime, localEndTime }) => ({
      weekday,
      localStartTime,
      localEndTime,
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const dirty =
    JSON.stringify(rows) !==
    JSON.stringify(
      hours.map(({ weekday, localStartTime, localEndTime }) => ({
        weekday,
        localStartTime,
        localEndTime,
      })),
    );
  const invalid = rows.some((r) => r.localStartTime === r.localEndTime);
  const save = useMutation({
    mutationFn: () =>
      replaceWorkHours(teacherId, { workHours: rows.map((r) => ({ ...r, timezone })) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: scheduleKeys.all });
      setError(null);
      toast.success(t('hoursSaved'));
    },
    onError: (e) => setError(message(e)),
  });
  const update = (i: number, patch: Partial<HourRow>) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Card className="gap-2 shadow-none">
      <CardHeader className="border-b">
        <CardTitle className="text-base font-bold">{t('workHours')}</CardTitle>
        <CardDescription>{t('workHoursHint', { city: cityOf(timezone, locale) })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {rows.length === 0 && <p className="text-muted-foreground">{t('noHours')}</p>}
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2">
            <Field>
              <FieldLabel htmlFor={`wh-day-${i}`} className="text-xs">
                {t('day')}
              </FieldLabel>
              <Select
                value={String(r.weekday)}
                onValueChange={(v) => update(i, { weekday: Number(v) })}
                disabled={!editable}
              >
                <SelectTrigger id={`wh-day-${i}`} className="h-10! w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  {STAFF_WEEK.map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {weekdayName(d, locale)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`wh-from-${i}`} className="text-xs">
                {t('from')}
              </FieldLabel>
              <TimeSelect
                id={`wh-from-${i}`}
                value={r.localStartTime}
                onChange={(v) => update(i, { localStartTime: v })}
              />
            </Field>
            <Field data-invalid={r.localStartTime === r.localEndTime}>
              <FieldLabel htmlFor={`wh-to-${i}`} className="text-xs">
                {t('to')}
              </FieldLabel>
              <TimeSelect
                id={`wh-to-${i}`}
                value={r.localEndTime}
                onChange={(v) => update(i, { localEndTime: v })}
                invalid={r.localStartTime === r.localEndTime}
              />
            </Field>
            {editable && (
              <Button
                variant="ghost"
                size="icon-lg"
                aria-label={t('removeHours', { day: weekdayName(r.weekday, locale) })}
                onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
              >
                <Trash2Icon />
              </Button>
            )}
          </div>
        ))}
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertCircleIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {editable && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              className="text-primary"
              onClick={() =>
                setRows((prev) => [
                  ...prev,
                  { weekday: 6, localStartTime: '14:00', localEndTime: '22:00' },
                ])
              }
            >
              <PlusIcon />
              {t('addHours')}
            </Button>
            <Button disabled={!dirty || invalid || save.isPending} onClick={() => save.mutate()}>
              {save.isPending && <Spinner />}
              {t('saveHours')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BlocksCard({
  teacherId,
  blocks,
  timezone,
  editable,
}: {
  teacherId: number;
  blocks: TeacherBlockDto[];
  timezone: string;
  editable: boolean;
}) {
  const t = useTranslations('timetable');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const queryClient = useQueryClient();
  const message = useClassError();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<TeacherBlockDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<TeacherBlockKind>('recurring');
  const [reason, setReason] = useState<TeacherBlockReason>('break');
  const [weekday, setWeekday] = useState(5);
  const [time, setTime] = useState('12:00');
  const [minutes, setMinutes] = useState(60);
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const remove = useMutation({
    mutationFn: (b: TeacherBlockDto) => deleteBlock(teacherId, b.id),
    onSuccess: () => {
      refreshClasses(queryClient);
      setRemoving(null);
      toast.success(t('blockRemoved'));
    },
    onError: (e) => setError(message(e)),
  });
  const add = useMutation({
    mutationFn: (note: string) =>
      createBlock(teacherId, {
        kind,
        reason,
        note: note || null,
        ...(kind === 'recurring'
          ? { weekday, localStartTime: time, durationMinutes: minutes, timezone }
          : { startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString() }),
      }),
    onSuccess: () => {
      refreshClasses(queryClient);
      setAdding(false);
      toast.success(t('blockAdded'));
    },
    onError: (e) => setError(message(e)),
  });
  const describe = (b: TeacherBlockDto) =>
    b.kind === 'recurring'
      ? `${weekdayName(b.weekday ?? 1, locale)} ${wallTime(b.localStartTime, locale)} · ${t('minutes', { count: b.durationMinutes ?? 0 })}`
      : `${b.startsAt ? dayAndClock(b.startsAt, tz, locale) : ''} – ${b.endsAt ? dayAndClock(b.endsAt, tz, locale) : ''}`;

  return (
    <Card className="gap-2 shadow-none">
      <CardHeader className="border-b">
        <CardTitle className="text-base font-bold">{t('blocks')}</CardTitle>
        <CardDescription>{t('blocksHint')}</CardDescription>
        {editable && (
          <CardAction>
            <Button
              variant="ghost"
              size="sm"
              className="text-primary"
              onClick={() => {
                setError(null);
                setAdding(true);
              }}
            >
              <PlusIcon />
              {t('addBlock')}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {blocks.length === 0 ? (
          <p className="py-2 text-muted-foreground">{t('noBlocks')}</p>
        ) : (
          <ul className="divide-y">
            {blocks.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-2 py-2.5">
                <span className="flex flex-col">
                  <span className="font-medium">
                    {TEACHER_BLOCK_REASON_LABELS[b.reason as TeacherBlockReason]?.[locale] ??
                      b.reason}{' '}
                    · {TEACHER_BLOCK_KIND_LABELS[b.kind][locale]}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    <bdi>{describe(b)}</bdi>
                    {b.note && (
                      <>
                        {' '}
                        · <bdi>{b.note}</bdi>
                      </>
                    )}
                  </span>
                </span>
                {editable && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('removeBlock', { block: describe(b) })}
                    onClick={() => {
                      setError(null);
                      setRemoving(b);
                    }}
                  >
                    <Trash2Icon />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <ReasonDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        destructive
        title={t('removeBlockTitle')}
        description={removing ? describe(removing) : ''}
        confirmLabel={t('removeBlockConfirm')}
        busy={remove.isPending}
        error={error}
        onConfirm={() => removing && remove.mutate(removing)}
      />
      <ReasonDialog
        open={adding}
        onOpenChange={setAdding}
        title={t('addBlock')}
        description={t('addBlockHint', { city: cityOf(timezone, locale) })}
        confirmLabel={t('addBlockConfirm')}
        textLabel={t('note')}
        busy={add.isPending}
        error={error}
        extra={
          <FieldGroup>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="block-kind">{t('blockKind')}</FieldLabel>
                <Select value={kind} onValueChange={(v) => setKind(v as TeacherBlockKind)}>
                  <SelectTrigger id="block-kind" className="h-10! w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {(['recurring', 'one_off'] as const).map((k) => (
                      <SelectItem key={k} value={k}>
                        {TEACHER_BLOCK_KIND_LABELS[k][locale]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="block-reason">{t('blockReason')}</FieldLabel>
                <Select value={reason} onValueChange={(v) => setReason(v as TeacherBlockReason)}>
                  <SelectTrigger id="block-reason" className="h-10! w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {TEACHER_BLOCK_REASONS.map((r) => (
                      <SelectItem key={r} value={r}>
                        {TEACHER_BLOCK_REASON_LABELS[r][locale]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            {kind === 'recurring' ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field>
                  <FieldLabel htmlFor="block-day">{t('day')}</FieldLabel>
                  <Select value={String(weekday)} onValueChange={(v) => setWeekday(Number(v))}>
                    <SelectTrigger id="block-day" className="h-10! w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {STAFF_WEEK.map((d) => (
                        <SelectItem key={d} value={String(d)}>
                          {weekdayName(d, locale)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="block-time">{t('from')}</FieldLabel>
                  <TimeSelect id="block-time" value={time} onChange={setTime} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="block-minutes">{t('length')}</FieldLabel>
                  <Select value={String(minutes)} onValueChange={(v) => setMinutes(Number(v))}>
                    <SelectTrigger id="block-minutes" className="h-10! w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {[30, 60, 90, 120, 180, 240].map((m) => (
                        <SelectItem key={m} value={String(m)}>
                          {t('minutes', { count: m })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="block-start">{t('startsAt')}</FieldLabel>
                  <Input
                    id="block-start"
                    type="datetime-local"
                    dir="ltr"
                    className="h-10 text-start"
                    value={startsAt}
                    onChange={(e) => setStartsAt(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="block-end">{t('endsAt')}</FieldLabel>
                  <Input
                    id="block-end"
                    type="datetime-local"
                    dir="ltr"
                    className="h-10 text-start"
                    value={endsAt}
                    onChange={(e) => setEndsAt(e.target.value)}
                  />
                </Field>
              </div>
            )}
          </FieldGroup>
        }
        onConfirm={(r) => {
          if (kind === 'one_off' && (!startsAt || !endsAt || endsAt <= startsAt)) {
            setError(t('blockTimesInvalid'));
            return;
          }
          add.mutate(r.text);
        }}
      />
    </Card>
  );
}
