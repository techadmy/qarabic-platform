'use client';

import { REPORT_FIELD_LABELS, type LessonReportDto } from '@qarabic/shared';
import { LockIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { ToneBadge } from '@/components/sessions/badges';
import { useNow, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { dayAndClock, relativeTime } from '@/lib/schedule-time';
import { HifzLine, RatingStars } from './report-bits';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="break-words whitespace-pre-wrap" dir="auto">
        {children}
      </dd>
    </div>
  );
}

/**
 * A lesson report, read-only (the current app's `ReportView`): who sent it and when, the summary
 * for the parent, the hifz rows in words, tajweed notes, homework and the rating; the internal note
 * only for staff and teachers (the API never sends it to parents, and a parent view never shows it).
 */
export function ReportView({ report }: { report: LessonReportDto }) {
  const t = useTranslations('reports');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const now = useNow(60_000);
  const me = useCurrentUser();
  const parent = me.role?.kind === 'parent';
  const L = (k: keyof typeof REPORT_FIELD_LABELS) => REPORT_FIELD_LABELS[k][locale];
  const edited = report.updatedAt !== report.submittedAt;

  return (
    <div className="flex flex-col gap-3">
      {!parent && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span title={dayAndClock(report.submittedAt, tz, locale)}>
            {t('sentBy', {
              name: report.submittedBy?.name ?? t('someone'),
              ago: relativeTime(report.submittedAt, now, locale),
            })}
          </span>
          {report.late && <ToneBadge tone="orange" label={t('lateBadge')} />}
          {edited && (
            <span title={dayAndClock(report.updatedAt, tz, locale)}>
              ·{' '}
              {t('editedBy', {
                name: report.updatedBy?.name ?? t('someone'),
                ago: relativeTime(report.updatedAt, now, locale),
              })}
            </span>
          )}
        </p>
      )}
      <dl className="flex flex-col gap-3">
        <Row label={L('summary')}>{report.summary}</Row>
        <div className="flex flex-col gap-0.5">
          <dt className="text-sm text-muted-foreground">{L('hifz')}</dt>
          <dd>
            {report.hifz.length ? (
              <ul className="flex list-disc flex-col gap-1 ps-5 text-sm">
                {report.hifz.map((h, i) => (
                  <li key={`${h.type}-${i}`}>
                    <HifzLine h={h} />
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-sm text-muted-foreground">{t('noHifz')}</span>
            )}
          </dd>
        </div>
        {report.tajweedNotes && <Row label={L('tajweedNotes')}>{report.tajweedNotes}</Row>}
        {report.homework && <Row label={L('homework')}>{report.homework}</Row>}
        {report.rating !== undefined && report.rating !== null && (
          <div className="flex flex-col gap-0.5">
            <dt className="text-sm text-muted-foreground">{L('rating')}</dt>
            <dd>
              <RatingStars value={report.rating} />
            </dd>
          </div>
        )}
      </dl>
      {!parent && report.teacherNotes && (
        <div className="flex flex-col gap-1 rounded-lg border border-dashed bg-subtle p-3 text-sm">
          <span className="flex items-center gap-1.5 font-semibold">
            <LockIcon aria-hidden className="size-3.5" />
            {L('teacherNotes')}
            <span className="font-normal text-muted-foreground">({t('internalHint')})</span>
          </span>
          <span className="whitespace-pre-wrap" dir="auto">
            {report.teacherNotes}
          </span>
        </div>
      )}
    </div>
  );
}
