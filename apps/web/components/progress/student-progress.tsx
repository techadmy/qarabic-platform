'use client';

import {
  HIFZ_TYPE_LABELS,
  HIFZ_TYPES,
  PROGRESS_LABELS,
  type HifzType,
  type ProgressDto,
  type ProgressTimelineItemDto,
} from '@qarabic/shared';
import { Badge } from '@qarabic/ui/components/badge';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@qarabic/ui/components/chart';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@qarabic/ui/components/collapsible';
import { Progress } from '@qarabic/ui/components/progress';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@qarabic/ui/components/toggle-group';
import { cn } from '@qarabic/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { BookOpenIcon, ChevronDownIcon, LockIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { HifzLine, RatingStars } from '@/components/reports/report-bits';
import { useOpenSession } from '@/components/sessions/session-sheet';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState } from '@/components/states';
import { fetchProgress, teachingKeys } from '@/lib/api/teaching';
import { rangeText, shortLabel, surahName } from '@/lib/reports/format';
import { clock, dateKeyIn, dayLabel } from '@/lib/schedule-time';
import { intlLocale } from '@/lib/time';

const PAGE = 10;

/**
 * «التقدم وسجل الدروس» (the current app's `StudentProgress`): the last position of each hifz
 * type, how much of the Quran is memorised (coverage with each surah), new ayahs per month as a
 * shadcn Chart, and the lesson log newest first with a type filter. Read-only for everyone; the
 * internal note only when the API sends it (never to parents). Staff and teachers open the class.
 */
export function StudentProgress({ studentId }: { studentId: number }) {
  const t = useTranslations('progress');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const parent = me.role?.kind === 'parent';
  const L = (k: keyof typeof PROGRESS_LABELS) => PROGRESS_LABELS[k][locale];
  const query = useQuery({
    queryKey: teachingKeys.progress(studentId),
    queryFn: ({ signal }) => fetchProgress(studentId, signal),
  });
  const data = query.data;
  const empty = data && !data.timeline.length && !data.lastPositions.length;

  return (
    <Card
      className="gap-0 shadow-none lg:col-span-2"
      aria-labelledby="progress-title"
      role="region"
    >
      <CardHeader className="border-b pb-4">
        <CardTitle
          id="progress-title"
          className="flex flex-wrap items-center gap-2 text-base font-bold"
        >
          {L('title')}
          {parent && (
            <Badge variant="outline" className="font-normal">
              {t('readOnly')}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6 pt-4">
        {query.isPending ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-20" />
            <Skeleton className="h-48" />
          </div>
        ) : query.isError || !data ? (
          <ErrorState onRetry={() => void query.refetch()} />
        ) : empty ? (
          <EmptyState icon={BookOpenIcon} title={L('noProgress')} description={t('emptyHint')} />
        ) : (
          <>
            <LastPositions data={data} />
            <div className="grid items-start gap-6 lg:grid-cols-2">
              <Coverage data={data} />
              <MonthlyAyahs data={data} />
            </div>
            <Timeline items={data.timeline} linkClasses={!parent} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SubTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-bold">{children}</h3>;
}

function LastPositions({ data }: { data: ProgressDto }) {
  const locale = useUiLocale();
  const tz = useViewerTz();
  if (!data.lastPositions.length) return null;
  return (
    <section className="flex flex-col gap-2" aria-labelledby="progress-last">
      <h3 id="progress-last" className="text-sm font-bold">
        {PROGRESS_LABELS.lastPositions[locale]}
      </h3>
      <ul className="grid gap-3 sm:grid-cols-3">
        {data.lastPositions.map((h) => (
          <li key={h.type}>
            <Card size="sm" className="gap-1 px-4 shadow-none">
              <span className="text-sm text-muted-foreground">
                {HIFZ_TYPE_LABELS[h.type][locale]}
              </span>
              <bdi className="text-base font-bold">{rangeText(h, locale)}</bdi>
              <span className="text-xs text-muted-foreground">
                {dayLabel(dateKeyIn(tz, new Date(h.date)), locale, true)}
              </span>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Coverage({ data }: { data: ProgressDto }) {
  const t = useTranslations('progress');
  const locale = useUiLocale();
  const c = data.coverage;
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-col gap-3" aria-labelledby="progress-coverage">
      <h3 id="progress-coverage" className="text-sm font-bold">
        {PROGRESS_LABELS.coverage[locale]}
      </h3>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-2xl font-bold tabular-nums">
            <bdi>{c.percent}%</bdi>
          </span>
          <span className="text-sm text-muted-foreground">
            {t('ayahsOf', { count: c.memorisedAyahs, total: c.totalAyahs })}
          </span>
        </div>
        <Progress
          value={c.percent}
          aria-label={PROGRESS_LABELS.coverage[locale]}
          className="h-2.5"
        />
        <p className="text-sm text-muted-foreground">
          {PROGRESS_LABELS.completeSurahs[locale]}:{' '}
          <bdi className="font-semibold text-foreground">{c.completeSurahs}</bdi>
          {' · '}
          {t('surahsStarted', { count: c.surahs.length })}
        </p>
      </div>
      {c.surahs.length > 0 && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="self-start px-2 text-primary">
              {open ? t('hideSurahs') : t('showSurahs')}
              <ChevronDownIcon className={cn('transition-transform', open && 'rotate-180')} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 flex flex-col gap-2">
              {c.surahs.map((s) => (
                <li
                  key={s.number}
                  className="grid grid-cols-[7rem_1fr_auto] items-center gap-2 text-sm"
                >
                  <span className="truncate">
                    <bdi>{s.number}</bdi>. {surahName(s.number, locale)}
                  </span>
                  <Progress
                    value={(s.memorisedAyahs / s.ayahCount) * 100}
                    aria-label={surahName(s.number, locale)}
                  />
                  <span className="text-muted-foreground tabular-nums">
                    <bdi>
                      {s.memorisedAyahs}/{s.ayahCount}
                    </bdi>
                  </span>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  );
}

function MonthlyAyahs({ data }: { data: ProgressDto }) {
  const t = useTranslations('progress');
  const locale = useUiLocale();
  const label = PROGRESS_LABELS.monthlyAyahs[locale];
  const months = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(intlLocale(locale), {
      month: 'short',
      year: '2-digit',
      timeZone: 'UTC',
    });
    // The last six months (the old chart's span); newest at the inline end.
    return data.monthlyAyahs.slice(-6).map((m) => ({
      ...m,
      label: fmt.format(new Date(`${m.month}-01T00:00:00Z`)),
    }));
  }, [data.monthlyAyahs, locale]);
  const config = {
    ayahs: { label: t('newAyahs'), color: 'var(--primary)' },
  } satisfies ChartConfig;
  const summary = months.map((m) => `${m.label}: ${m.ayahs}`).join('، ');
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-labelledby="progress-monthly">
      <h3 id="progress-monthly" className="text-sm font-bold">
        {label}
      </h3>
      <div role="img" aria-label={`${label}: ${summary}`}>
        <ChartContainer config={config} className="aspect-auto h-48 w-full" dir="ltr">
          <BarChart
            accessibilityLayer
            data={locale === 'ar' ? [...months].reverse() : months}
            margin={{ top: 8, left: 0, right: 0 }}
          >
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis
              width={32}
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              orientation={locale === 'ar' ? 'right' : 'left'}
            />
            <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel={false} />} />
            <Bar dataKey="ayahs" fill="var(--color-ayahs)" radius={4} />
          </BarChart>
        </ChartContainer>
      </div>
    </section>
  );
}

function Timeline({
  items,
  linkClasses,
}: {
  items: ProgressTimelineItemDto[];
  linkClasses: boolean;
}) {
  const t = useTranslations('progress');
  const locale = useUiLocale();
  const [type, setType] = useState<HifzType | 'all'>('all');
  const [shown, setShown] = useState(PAGE);
  const rows = useMemo(
    () => (type === 'all' ? items : items.filter((x) => x.hifz.some((h) => h.type === type))),
    [items, type],
  );
  return (
    <section className="flex flex-col gap-3" aria-labelledby="progress-timeline">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SubTitle>
          <span id="progress-timeline">{PROGRESS_LABELS.timeline[locale]}</span>{' '}
          <span className="text-sm font-normal text-muted-foreground">
            ({t('lessons', { count: rows.length })})
          </span>
        </SubTitle>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          value={type}
          onValueChange={(v) => {
            if (!v) return;
            setType(v as HifzType | 'all');
            setShown(PAGE);
          }}
          aria-label={t('filter')}
          className="bg-card"
        >
          <ToggleGroupItem value="all" className="h-9 px-3 data-[state=on]:bg-accent">
            {t('all')}
          </ToggleGroupItem>
          {HIFZ_TYPES.map((x) => (
            <ToggleGroupItem key={x} value={x} className="h-9 px-3 data-[state=on]:bg-accent">
              {shortLabel(HIFZ_TYPE_LABELS[x][locale])}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      {rows.length === 0 ? (
        <p className="text-muted-foreground">{PROGRESS_LABELS.noProgress[locale]}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {rows.slice(0, shown).map((item) => (
            <li key={item.sessionId}>
              <LessonItem item={item} type={type} linkClass={linkClasses} />
            </li>
          ))}
        </ol>
      )}
      {rows.length > shown && (
        <Button variant="outline" className="self-center" onClick={() => setShown((n) => n + PAGE)}>
          {t('showMore')}
        </Button>
      )}
    </section>
  );
}

/** One lesson's report, read-only (also what a parent reads). */
function LessonItem({
  item,
  type,
  linkClass,
}: {
  item: ProgressTimelineItemDto;
  type: HifzType | 'all';
  linkClass: boolean;
}) {
  const t = useTranslations('progress');
  const tr = useTranslations('reports');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const { open } = useOpenSession();
  const hifz = type === 'all' ? item.hifz : item.hifz.filter((h) => h.type === type);
  return (
    <Card size="sm" className="gap-2 px-4 shadow-none">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-semibold">
          {dayLabel(dateKeyIn(tz, new Date(item.startsAt)), locale, true)} ·{' '}
          <bdi>{clock(item.startsAt, tz, locale)}</bdi>
        </span>
        {item.teacher && (
          <span className="text-sm text-muted-foreground">
            {t('teacher')}: {item.teacher.name}
          </span>
        )}
      </div>
      <p className="whitespace-pre-wrap" dir="auto">
        {item.summary}
      </p>
      {hifz.length > 0 ? (
        <ul className="flex list-disc flex-col gap-0.5 ps-5 text-sm">
          {hifz.map((h, i) => (
            <li key={`${h.type}-${i}`}>
              <HifzLine h={h} />
            </li>
          ))}
        </ul>
      ) : (
        <span className="text-sm text-muted-foreground">{tr('noHifz')}</span>
      )}
      {item.tajweedNotes && (
        <p className="text-sm">
          <span className="font-semibold">{tr('form.tajweedShort')}:</span> {item.tajweedNotes}
        </p>
      )}
      {item.homework && (
        <p className="text-sm">
          <span className="font-semibold">{tr('form.homeworkShort')}:</span> {item.homework}
        </p>
      )}
      {item.rating !== undefined && item.rating !== null && <RatingStars value={item.rating} />}
      {item.teacherNotes && (
        <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
          <LockIcon aria-hidden className="mt-1 size-3.5 shrink-0" />
          <span>
            {t('internalNote')}: {item.teacherNotes}
          </span>
        </p>
      )}
      {linkClass && (
        <Button
          variant="link"
          size="sm"
          className="self-start px-0"
          onClick={() => open(item.sessionId)}
        >
          {t('openClass')}
        </Button>
      )}
    </Card>
  );
}
