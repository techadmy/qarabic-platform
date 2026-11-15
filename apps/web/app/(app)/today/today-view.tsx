'use client';

import { Alert, AlertAction, AlertDescription, AlertTitle } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import {
  SESSION_KIND_LABELS,
  SESSION_KINDS,
  SESSION_STAGE_LABELS,
  SESSION_STAGES,
  type SessionKind,
  type SessionStage,
} from '@qarabic/shared';
import { Badge } from '@qarabic/ui/components/badge';
import { Card } from '@qarabic/ui/components/card';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@qarabic/ui/components/sheet';
import { useIsMobile } from '@qarabic/ui/hooks/use-mobile';
import { Label } from '@qarabic/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Switch } from '@qarabic/ui/components/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@qarabic/ui/components/dropdown-menu';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@qarabic/ui/components/input-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@qarabic/ui/components/tooltip';
import {
  CalendarXIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EllipsisVerticalIcon,
  InfoIcon,
  ListFilterIcon,
  RefreshCwIcon,
  SearchIcon,
  SearchXIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Combobox } from '@/components/forms/fields';
import { DatePicker } from '@/components/forms/date-time';
import { PageHeader } from '@/components/page-header';
import { ClassTable } from '@/components/sessions/class-table';
import { SessionSheet, useOpenSession } from '@/components/sessions/session-sheet';
import { useNow, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useBoard } from '@/components/sessions/use-board';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { can } from '@/lib/auth/use-me';
import { ACADEMY_TZ } from '@/lib/billing/labels';
import { useListParams } from '@/lib/list-params';
import {
  ALL_TILES,
  applyFilters,
  orderRows,
  PRIMARY_TILES,
  STATUS_TILES,
  type BoardTile,
} from '@/lib/sessions/board';
import { addDays, dateKeyIn, dayLabel, isDateKey, relativeTime } from '@/lib/schedule-time';
import { BoardTiles } from './board-tiles';
import { SyncDialog } from './sync-dialog';

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

/**
 * «حصص اليوم» — the Today board (docs/15 §3.1 K1–K4, §6.1; the current app's `BoardPage`; v2 D148,
 * docs/42 §2): the old counters as filter tiles, a date switcher, filters (search, teacher, course,
 * kind, state, problems only), rows in pure time order with the page on the «الآن» line, the
 * academy's time first then each party's labelled time, rows tinted by state; the class in a
 * sheet; live by 15 s cursor polling. Every filter, the date and the open class live in the URL.
 */
export function TodayView() {
  const t = useTranslations('today');
  const tl = useTranslations('list');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const params = useListParams();
  const { open } = useOpenSession();
  const now = useNow(15_000);
  const today = dateKeyIn(tz, now);
  const date = isDateKey(params.get('date')) ? params.get('date') : today;
  const tileParam = params.get('tile') as BoardTile;
  const tile = ALL_TILES.includes(tileParam) ? tileParam : null;
  const teacher = Number(params.get('teacher')) || null;
  const course = Number(params.get('course')) || null;
  const kindParam = params.get('kind') as SessionKind;
  const kind = SESSION_KINDS.includes(kindParam) ? kindParam : null;
  const stageParam = params.get('stage') as SessionStage;
  const stage = SESSION_STAGES.includes(stageParam) ? stageParam : null;
  const problems = params.get('problems') === '1';
  const isMobile = useIsMobile();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilters = [teacher, course, kind, stage, problems].filter(Boolean).length;
  const [syncing, setSyncing] = useState(false);
  const showAll =
    params.get('statuses') === '1' || (!!tile && STATUS_TILES.includes(tile as never));
  const allowed = can(me, 'sessions.view');

  const board = useBoard(date, tz, allowed);
  const all = useMemo(() => board.data?.sessions ?? [], [board.data]);
  const { rows, nowIndex } = useMemo(() => {
    const filtered = applyFilters(all, {
      tile,
      teacher,
      stage,
      q: params.q,
      course,
      kind,
      problems,
    });
    const ordered = orderRows(filtered, now);
    return { rows: ordered.rows, nowIndex: date === today ? ordered.nowIndex : -1 };
  }, [all, tile, teacher, stage, params.q, course, kind, problems, now, date, today]);
  const teachers = useMemo(() => {
    const map = new Map(all.map((s) => [s.teacher.id, s.teacher.name]));
    return [...map].sort((a, b) => a[1].localeCompare(b[1]));
  }, [all]);
  const courses = useMemo(() => {
    const map = new Map(
      all.map((s) => [s.course.id, locale === 'ar' ? s.course.nameAr : s.course.nameEn]),
    );
    return [...map].sort((a, b) => a[1].localeCompare(b[1]));
  }, [all, locale]);
  const filtered = !!tile || !!teacher || !!params.q || !!course || !!kind || !!stage || problems;
  const clearAll = () =>
    params.set({
      tile: null,
      teacher: null,
      q: null,
      statuses: null,
      course: null,
      kind: null,
      stage: null,
      problems: null,
    });
  const setDate = (key: string) => params.set({ date: key === today ? null : key, session: null });

  // Keys 1–5 pick the main tiles (docs/15 §5.17); never while typing or with a dialog open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector('[role="dialog"],[role="alertdialog"]')) return;
      if (!/^[1-5]$/.test(e.key)) return;
      const key = PRIMARY_TILES[Number(e.key) - 1]!;
      params.set({ tile: tile === key ? null : key });
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [params, tile]);

  if (!allowed || isApiError(board.error, 403)) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }

  const stopped = board.isError && !!board.data;
  const lastUpdated = board.dataUpdatedAt ? new Date(board.dataUpdatedAt) : null;

  const filterControls = (
    <>
      <Combobox
        id="board-teacher"
        ariaLabel={t('teacher')}
        className="w-full sm:w-52"
        value={teacher ? String(teacher) : null}
        onChange={(v) => params.set({ teacher: v })}
        options={teachers.map(([id, name]) => ({ value: String(id), label: name }))}
        placeholder={t('allTeachers')}
        searchPlaceholder={t('searchTeacher')}
        clearable
      />
      <Combobox
        id="board-course"
        ariaLabel={t('filters.course')}
        className="w-full sm:w-52"
        value={course ? String(course) : null}
        onChange={(v) => params.set({ course: v })}
        options={courses.map(([id, name]) => ({ value: String(id), label: name }))}
        placeholder={t('filters.allCourses')}
        searchPlaceholder={t('filters.searchCourse')}
        clearable
      />
      <Select
        value={kind ?? 'all'}
        onValueChange={(v) => params.set({ kind: v === 'all' ? null : v })}
      >
        <SelectTrigger aria-label={t('filters.kind')} className="h-10! w-full bg-card sm:w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="all">{t('filters.allKinds')}</SelectItem>
          {SESSION_KINDS.map((k) => (
            <SelectItem key={k} value={k}>
              {SESSION_KIND_LABELS[k][locale]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={stage ?? 'all'}
        onValueChange={(v) => params.set({ stage: v === 'all' ? null : v })}
      >
        <SelectTrigger aria-label={t('filters.stage')} className="h-10! w-full bg-card sm:w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="all">{t('filters.allStages')}</SelectItem>
          {SESSION_STAGES.filter((st) => st !== 'moved_out').map((st) => (
            <SelectItem key={st} value={st}>
              {SESSION_STAGE_LABELS[st][locale]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex h-10 items-center gap-2 px-1">
        <Switch
          id="board-problems"
          checked={problems}
          onCheckedChange={(on) => params.set({ problems: on ? '1' : null })}
        />
        <Label htmlFor="board-problems">{t('filters.problems')}</Label>
      </div>
    </>
  );

  return (
    <>
      <PageHeader
        title={t('title')}
        meta={
          <span aria-live="polite">
            {dayLabel(date, locale, true)} · {t('count', { count: rows.length })}
            {lastUpdated && board.data && (
              <>
                {' '}
                · {t('lastUpdated', { ago: relativeTime(lastUpdated.toISOString(), now, locale) })}
              </>
            )}
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <InputGroup className="h-10 w-full bg-card sm:w-64">
              <InputGroupAddon>
                <SearchIcon aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                aria-label={t('search')}
                placeholder={t('search')}
                value={params.searchInput}
                onChange={(e) => params.setSearchInput(e.target.value)}
              />
              {params.searchInput && (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    size="icon-xs"
                    aria-label={tl('clearSearch')}
                    onClick={() => params.setSearchInput('')}
                  >
                    <XIcon />
                  </InputGroupButton>
                </InputGroupAddon>
              )}
            </InputGroup>
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-lg"
                    aria-label={t('prevDay')}
                    onClick={() => setDate(addDays(date, -1))}
                  >
                    <ChevronRightIcon className="ltr:rotate-180" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('prevDay')}</TooltipContent>
              </Tooltip>
              <DatePicker value={date} onChange={setDate} label={t('pickDate')} className="w-44" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-lg"
                    aria-label={t('nextDay')}
                    onClick={() => setDate(addDays(date, 1))}
                  >
                    <ChevronLeftIcon className="ltr:rotate-180" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('nextDay')}</TooltipContent>
              </Tooltip>
              {date !== today && (
                <Button variant="outline" className="h-10" onClick={() => setDate(today)}>
                  {t('today')}
                </Button>
              )}
              {can(me, 'schedule.manage') && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-lg" aria-label={t('moreDayActions')}>
                      <EllipsisVerticalIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setSyncing(true)}>
                      <RefreshCwIcon />
                      {t('sync.action')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>
        }
      />

      {board.data?.generator.stale && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>{t('generatorStale')}</AlertTitle>
        </Alert>
      )}
      {stopped && (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>{t('liveStopped')}</AlertTitle>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={() => void board.refetch()}>
              <RefreshCwIcon />
              {t('reconnect')}
            </Button>
          </AlertAction>
        </Alert>
      )}
      {date < today && (
        <Alert>
          <InfoIcon />
          <AlertDescription>{t('pastDay')}</AlertDescription>
        </Alert>
      )}

      <BoardTiles
        counters={board.data?.counters}
        rows={all}
        selected={tile}
        onSelect={(k) => params.set({ tile: k })}
        loading={board.isPending}
        showAll={showAll}
        reportsHref={me.role?.kind === 'parent' ? undefined : '/lesson-reports?state=missing'}
        onToggleAll={() =>
          params.set({
            statuses: showAll ? null : '1',
            ...(showAll && tile && STATUS_TILES.includes(tile as never) ? { tile: null } : {}),
          })
        }
      />

      {isMobile ? (
        // Phones: the filters live in a sheet so the first class shows on the first screen.
        <div className="flex items-center gap-2">
          <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" className="h-10">
                <ListFilterIcon />
                {t('filters.open')}
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
              <div
                role="group"
                aria-label={t('filters.label')}
                className="flex flex-col gap-3 px-4 pb-4"
              >
                {filterControls}
              </div>
            </SheetContent>
          </Sheet>
          {filtered && rows.length > 0 && (
            <Button variant="ghost" className="h-10" onClick={clearAll}>
              {tl('clearAll')}
            </Button>
          )}
        </div>
      ) : (
        <div
          role="group"
          aria-label={t('filters.label')}
          className="flex flex-wrap items-center gap-2"
        >
          {filterControls}
          {/* With nothing matching, the empty state offers it instead (one button). */}
          {filtered && rows.length > 0 && (
            <Button variant="ghost" className="h-10" onClick={clearAll}>
              {tl('clearAll')}
            </Button>
          )}
        </div>
      )}

      <Card className="gap-0 py-0 shadow-none">
        {board.isError && !board.data ? (
          <div className="p-4">
            <ErrorState onRetry={() => void board.refetch()} />
          </div>
        ) : !board.isPending && all.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={CalendarXIcon}
              title={t('empty')}
              description={t('emptyHint')}
              action={
                can(me, 'schedule.view') ? (
                  <Button asChild>
                    <Link href="/schedule">{t('toSchedule')}</Link>
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : !board.isPending && rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={SearchXIcon}
              role="status"
              title={tl('noResults')}
              description={tl('noResultsHint')}
              action={
                filtered ? (
                  <Button variant="outline" onClick={clearAll}>
                    {tl('clearAll')}
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <ClassTable
            rows={rows}
            loading={board.isPending}
            now={now}
            nowIndex={nowIndex}
            onOpen={(s) => open(s.id)}
            label={t('title')}
            academyTz={ACADEMY_TZ}
            scrollToNow={date === today}
          />
        )}
      </Card>
      <p className="hidden text-sm text-muted-foreground md:block">{t('shortcuts')}</p>
      <SessionSheet />
      {syncing && <SyncDialog date={date} open onOpenChange={setSyncing} />}
    </>
  );
}
