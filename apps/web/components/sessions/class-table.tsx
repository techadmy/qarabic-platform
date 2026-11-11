'use client';

import { ZOOM_STATUS_LABELS, type SessionDto } from '@qarabic/shared';
import { Card } from '@qarabic/ui/components/card';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@qarabic/ui/components/table';
import { useIsMobile } from '@qarabic/ui/hooks/use-mobile';
import { cn } from '@qarabic/ui/lib/utils';
import { CheckIcon, MinusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Fragment, type MouseEvent } from 'react';
import { clock, dayLabel, dateKeyIn, minutesBetween } from '@/lib/schedule-time';
import { AttentionBadge, KindBadge, StageBadge } from './badges';
import { RowActions } from './row-actions';
import { OtherTime, useUiLocale, useViewerTz } from './times';

const RUNNING = new Set(['activated', 'in_progress']);

function Progress({ s, now }: { s: SessionDto; now: Date }) {
  const t = useTranslations('classes');
  if (RUNNING.has(s.stage) && s.times.activatedAt) {
    const m = Math.max(0, Math.floor(minutesBetween(s.times.activatedAt, now)));
    return (
      <bdi className="tabular-nums">
        {m}/{s.durationMinutes}
      </bdi>
    );
  }
  if (s.attention.includes('late')) {
    return (
      <span className="font-semibold text-orange-700 dark:text-orange-400">
        {t('lateBy', { count: Math.floor(minutesBetween(s.startsAt, now)) })}
      </span>
    );
  }
  return <span>{t('minutes', { count: s.durationMinutes })}</span>;
}

function Joined({ at, label }: { at: string | null; label: string }) {
  const t = useTranslations('classes.detail');
  return (
    <span className="inline-flex items-center gap-0.5" title={at ? undefined : t('notJoined')}>
      {label}
      {at ? (
        <CheckIcon aria-label={t('joined')} className="size-3.5 text-emerald-700" />
      ) : (
        <MinusIcon aria-label={t('notJoined')} className="size-3.5" />
      )}
    </span>
  );
}

function Meeting({ s }: { s: SessionDto }) {
  const t = useTranslations('classes');
  const locale = useUiLocale();
  const showEvidence =
    !!s.evidence.teacherJoinedAt || !!s.evidence.studentJoinedAt || RUNNING.has(s.stage);
  return (
    <span className="flex flex-col text-sm">
      <span>{ZOOM_STATUS_LABELS[s.zoom.status][locale]}</span>
      {showEvidence && (
        <span className="flex gap-2 text-xs text-muted-foreground">
          <Joined at={s.evidence.teacherJoinedAt} label={t('party.teacher')} />
          <Joined at={s.evidence.studentJoinedAt} label={t('party.student')} />
        </span>
      )}
    </span>
  );
}

function NowDivider({ now }: { now: Date }) {
  const t = useTranslations('classes');
  const locale = useUiLocale();
  const tz = useViewerTz();
  return (
    <div
      role="separator"
      aria-label={t('now')}
      className="flex items-center gap-2 py-1 text-destructive"
    >
      <span className="h-0.5 flex-1 bg-destructive" />
      <span className="text-xs font-bold">
        {t('now')} <bdi>{clock(now.toISOString(), tz, locale)}</bdi>
      </span>
      <span className="h-0.5 flex-1 bg-destructive" />
    </div>
  );
}

const lateRow = 'bg-orange-50/70 dark:bg-orange-950/40';

/**
 * Class rows (docs/15 §6.1, the current app's `BoardTable`): the shadcn `Table` from 768 px, one
 * `Card` per class on phones. The viewer's time first, each party's labelled time under their name,
 * stage + kind + follow-up chips, progress, the meeting, and the row actions. A «الآن» divider;
 * late rows tinted orange; the row (or Enter on it) opens the class.
 */
export function ClassTable({
  rows,
  loading,
  now,
  nowIndex = -1,
  onOpen,
  label,
  showDate,
  hideTeacher,
  primaryActions,
}: {
  rows: SessionDto[];
  loading?: boolean;
  now: Date;
  nowIndex?: number;
  onOpen: (s: SessionDto) => void;
  label: string;
  /** Rows over several days: the date goes with the time. */
  showDate?: boolean;
  /** The teacher's own list: no teacher column. */
  hideTeacher?: boolean;
  primaryActions?: boolean;
}) {
  const t = useTranslations('classes');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const isMobile = useIsMobile();
  const course = (s: SessionDto) => (locale === 'ar' ? s.course.nameAr : s.course.nameEn);
  const open = (event: MouseEvent, s: SessionDto) => {
    if ((event.target as HTMLElement).closest('a,button,[role="menuitem"],input,label')) return;
    onOpen(s);
  };
  // The name is the keyboard way in (a real button); the row click is a shortcut.
  const name = (s: SessionDto) => (
    <button
      type="button"
      onClick={() => onOpen(s)}
      className="text-start font-semibold text-primary hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
    >
      {s.student.name}
    </button>
  );
  const when = (s: SessionDto) => (
    <span className="flex flex-col">
      <bdi className="font-bold">{clock(s.startsAt, tz, locale)}</bdi>
      {showDate && (
        <span className="text-xs text-muted-foreground">
          {dayLabel(dateKeyIn(tz, new Date(s.startsAt)), locale)}
        </span>
      )}
    </span>
  );

  if (loading) {
    return (
      <div className="flex flex-col gap-2 p-4" aria-busy="true">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className={isMobile ? 'h-28' : 'h-11'} />
        ))}
      </div>
    );
  }

  if (isMobile) {
    return (
      <ul aria-label={label} className="flex flex-col gap-3 p-3">
        {rows.map((s, i) => (
          <Fragment key={s.id}>
            {i === nowIndex && (
              <li>
                <NowDivider now={now} />
              </li>
            )}
            <li>
              <Card
                onClick={(e) => open(e, s)}
                className={cn(
                  'cursor-pointer gap-1.5 px-4 py-3 shadow-none',
                  s.attention.includes('late') && lateRow,
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  {when(s)}
                  <StageBadge session={s} />
                </div>
                {name(s)}
                <OtherTime at={s.startsAt} tz={s.student.timezone} party="student" />
                {!hideTeacher && (
                  <>
                    <span>{s.teacher.name}</span>
                    <OtherTime at={s.startsAt} tz={s.teacher.timezone} party="teacher" />
                  </>
                )}
                <span className="text-sm text-muted-foreground">{course(s)}</span>
                <div className="flex flex-wrap gap-1">
                  <KindBadge kind={s.kind} />
                  {s.attention
                    .filter((a) => a !== 'late')
                    .map((a) => (
                      <AttentionBadge key={a} code={a} />
                    ))}
                </div>
                <RowActions session={s} primary={primaryActions} className="flex-wrap" />
              </Card>
            </li>
          </Fragment>
        ))}
        {nowIndex === rows.length && (
          <li>
            <NowDivider now={now} />
          </li>
        )}
      </ul>
    );
  }

  const columns = hideTeacher ? 8 : 9;
  return (
    <div className="overflow-x-auto">
      <Table aria-label={label} className="tabular-nums">
        <TableHeader>
          <TableRow className="bg-subtle hover:bg-subtle">
            {(
              [
                'time',
                'student',
                ...(hideTeacher ? [] : ['teacher']),
                'course',
                'kind',
                'stage',
                'duration',
                'meeting',
                'actions',
              ] as const
            ).map((c) => (
              <TableHead
                key={c}
                className={cn(
                  'h-10 px-3 text-[0.8125rem] font-semibold text-muted-foreground',
                  c === 'actions' && 'text-end',
                )}
              >
                {c === 'actions' ? (
                  <span className="sr-only">{t('columns.actions')}</span>
                ) : (
                  t(`columns.${c}`)
                )}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((s, i) => (
            <Fragment key={s.id}>
              {i === nowIndex && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={columns} className="border-0 p-0 px-3">
                    <NowDivider now={now} />
                  </TableCell>
                </TableRow>
              )}
              <TableRow
                data-session-id={s.id}
                onClick={(e) => open(e, s)}
                className={cn(
                  'cursor-pointer hover:bg-subtle',
                  s.attention.includes('late') && lateRow,
                )}
              >
                <TableCell className="h-14 px-3 py-1.5 whitespace-nowrap">{when(s)}</TableCell>
                <TableCell className="px-3 py-1.5">
                  <span className="flex flex-col">
                    {name(s)}
                    <OtherTime
                      at={s.startsAt}
                      tz={s.student.timezone}
                      party="student"
                      showParty={false}
                    />
                  </span>
                </TableCell>
                {!hideTeacher && (
                  <TableCell className="px-3 py-1.5">
                    <span className="flex flex-col">
                      <span>{s.teacher.name}</span>
                      <OtherTime
                        at={s.startsAt}
                        tz={s.teacher.timezone}
                        party="teacher"
                        showParty={false}
                      />
                    </span>
                  </TableCell>
                )}
                <TableCell className="max-w-44 truncate px-3 py-1.5" title={course(s)}>
                  {course(s)}
                </TableCell>
                <TableCell className="px-3 py-1.5">
                  <KindBadge kind={s.kind} showRegular />
                </TableCell>
                <TableCell className="px-3 py-1.5">
                  <span className="flex flex-col items-start gap-1">
                    <StageBadge session={s} />
                    {s.attention
                      .filter((a) => a !== 'late')
                      .map((a) => (
                        <AttentionBadge key={a} code={a} />
                      ))}
                  </span>
                </TableCell>
                <TableCell className="px-3 py-1.5 whitespace-nowrap">
                  <Progress s={s} now={now} />
                </TableCell>
                <TableCell className="px-3 py-1.5">
                  <Meeting s={s} />
                </TableCell>
                <TableCell className="px-2 py-1.5">
                  <RowActions session={s} primary={primaryActions} />
                </TableCell>
              </TableRow>
            </Fragment>
          ))}
          {nowIndex === rows.length && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columns} className="border-0 p-0 px-3">
                <NowDivider now={now} />
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
