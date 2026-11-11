'use client';

import {
  needsHifz,
  needsReading,
  TEST_ERROR_MESSAGES,
  TEST_MISTAKE_LABELS,
  TEST_SECTION_LABELS,
  TEST_SECTIONS,
  TEST_STATUS_LABELS,
  type TestDto,
  type TestErrorCode,
  type TestStatus,
} from '@qarabic/shared';
import { Card } from '@qarabic/ui/components/card';
import { cn } from '@qarabic/ui/lib/utils';
import {
  CalendarClockIcon,
  CircleCheckIcon,
  CircleMinusIcon,
  CircleXIcon,
  LockIcon,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ToneBadge, type Tone } from '@/components/sessions/badges';
import { OtherTime, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { isApiError } from '@/lib/api/client';
import { useClassError } from '@/lib/sessions/errors';
import { dayAndClock } from '@/lib/schedule-time';
import { cityOf } from '@/lib/time';

const TONE: Record<TestStatus, { tone: Tone; icon: LucideIcon }> = {
  scheduled: { tone: 'lightBlue', icon: CalendarClockIcon },
  taken: { tone: 'green', icon: CircleCheckIcon },
  refused: { tone: 'red', icon: CircleXIcon },
  cancelled: { tone: 'grey', icon: CircleMinusIcon },
};

export function TestStatusBadge({ status }: { status: TestStatus }) {
  const locale = useUiLocale();
  const label = TEST_STATUS_LABELS[status];
  return (
    <ToneBadge
      tone={TONE[status].tone}
      icon={TONE[status].icon}
      label={label[locale]}
      title={label.en}
    />
  );
}

/**
 * D30: the test time in the viewer's zone first, then the other party's labelled time (the
 * student's for staff and teachers, the examiner's for parents).
 */
export function TestWhen({ test, other }: { test: TestDto; other?: 'student' | 'teacher' }) {
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const party = other ?? (me.role?.kind === 'parent' ? 'teacher' : 'student');
  const otherTz = party === 'student' ? test.student.timezone : test.teacher.timezone;
  return (
    <span className="flex flex-col">
      <span className="font-semibold">
        <bdi>{dayAndClock(test.scheduledAt, tz, locale)}</bdi>{' '}
        <span className="font-normal text-muted-foreground">({cityOf(tz, locale)})</span>
      </span>
      {otherTz !== tz && <OtherTime at={test.scheduledAt} tz={otherTz} party={party} />}
    </span>
  );
}

function Score({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <Card size="sm" className={cn('min-w-24 gap-0.5 px-4 shadow-none', strong && 'border-primary')}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={cn('font-bold tabular-nums', strong ? 'text-2xl' : 'text-lg')}>
        <bdi>{value}%</bdi>
      </span>
    </Card>
  );
}

/**
 * A recorded result, read-only: the scores, the mistakes in words by section, the remarks for the
 * parent, and (staff and teachers) the internal notes and the examiner's rating.
 */
export function ResultSummary({ test }: { test: TestDto }) {
  const t = useTranslations('tests.result');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const parent = me.role?.kind === 'parent';
  const r = test.result;
  if (!r) return null;
  const sections = TEST_SECTIONS.filter((s) => test.sections.includes(s.key));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2" aria-label={t('scores')} role="group">
        <Score label={t('overall')} value={r.overall} strong />
        <Score label={t('tajweed')} value={r.tajweed} />
        {needsReading(test.track) && r.reading !== null && (
          <Score label={t('reading')} value={r.reading} />
        )}
        {needsHifz(test.track) && r.hifz !== null && <Score label={t('hifz')} value={r.hifz} />}
      </div>
      <div className="flex flex-col gap-1">
        <h4 className="text-sm font-bold">{t('mistakes')}</h4>
        {r.mistakes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noMistakes')}</p>
        ) : (
          <ul className="flex list-disc flex-col gap-0.5 ps-5 text-sm">
            {sections.flatMap((s) =>
              s.mistakes
                .filter((m) => r.mistakes.includes(m))
                .map((m) => (
                  <li key={m}>
                    <span className="text-muted-foreground">
                      {TEST_SECTION_LABELS[s.key][locale]}:
                    </span>{' '}
                    {TEST_MISTAKE_LABELS[m]?.[locale]}
                  </li>
                )),
            )}
          </ul>
        )}
      </div>
      {r.remarks && (
        <div className="flex flex-col gap-1">
          <h4 className="text-sm font-bold">{t('remarks')}</h4>
          <p className="text-sm whitespace-pre-wrap" dir="auto">
            {r.remarks}
          </p>
        </div>
      )}
      {!parent && r.internalNotes && (
        <div className="flex flex-col gap-1 rounded-lg border border-dashed bg-subtle p-3 text-sm">
          <span className="flex items-center gap-1.5 font-semibold">
            <LockIcon aria-hidden className="size-3.5" />
            {t('internalNotes')}
          </span>
          <span className="whitespace-pre-wrap" dir="auto">
            {r.internalNotes}
          </span>
        </div>
      )}
      {r.teacherRating !== undefined && r.teacherRating !== null && (
        <p className="text-sm text-muted-foreground">
          {t('teacherRating')}:{' '}
          <bdi className="font-semibold text-foreground">{r.teacherRating}</bdi>
        </p>
      )}
    </div>
  );
}

/** Test refusals (`TEST_ERROR_MESSAGES`), else the class refusals' plain sentence. */
export function useTestError() {
  const locale = useUiLocale();
  const generic = useClassError();
  return (error: unknown): string => {
    if (isApiError(error) && error.code && error.code in TEST_ERROR_MESSAGES) {
      return TEST_ERROR_MESSAGES[error.code as TestErrorCode][locale];
    }
    return generic(error);
  };
}
