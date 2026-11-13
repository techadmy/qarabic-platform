'use client';

import {
  TRIAL_INELIGIBLE_LABELS,
  type TrialTeacherOptionDto,
  type TrialTeachersQuery,
} from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Badge } from '@qarabic/ui/components/badge';
import { Button } from '@qarabic/ui/components/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@qarabic/ui/components/collapsible';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@qarabic/ui/components/field';
import { RadioGroup, RadioGroupItem } from '@qarabic/ui/components/radio-group';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Textarea } from '@qarabic/ui/components/textarea';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDownIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';
import { useUiLocale } from '@/components/sessions/times';
import { crmKeys, fetchTrialTeachers } from '@/lib/api/crm';
import { dayAndClock } from '@/lib/schedule-time';
import { cityOf } from '@/lib/time';

/** Stable ids, so the dialog can move focus to the first problem on submit (§5.6). */
export const TRIAL_TEACHERS_ID = 'trial-teachers';
export const TRIAL_OVERRIDE_REASON_ID = 'trial-override-reason';

/**
 * «المعلم» in the trial booking (T2, docs/33 §4.2, mode A): once the child, course and time are
 * set, the eligible teachers ranked by the server, each with why it ranks there (work hours,
 * language, conversion, free hours, trials this week); «عرض غير المتاحين» lists the others with
 * their reasons. An ineligible teacher (not busy) can still be booked with a reason, which the
 * server keeps on the booking.
 */
export function TrialTeacherPicker({
  leadId,
  query,
  value,
  onChange,
  onSelected,
  overrideReason,
  onOverrideReason,
  showErrors,
  error,
}: {
  leadId: number;
  /** Null until the child, course, date and time are chosen. */
  query: TrialTeachersQuery | null;
  value: string | null;
  onChange: (teacherId: string) => void;
  /** The chosen teacher's row in the current list (undefined while loading or not listed). */
  onSelected: (option: TrialTeacherOptionDto | undefined) => void;
  overrideReason: string;
  onOverrideReason: (reason: string) => void;
  showErrors: boolean;
  /** The teacher field's error (none chosen, or a server refusal). */
  error?: string;
}) {
  const t = useTranslations('crm.trial.teachers');
  const locale = useUiLocale();
  const ids = { legend: useId(), reason: TRIAL_OVERRIDE_REASON_ID, hint: useId(), error: useId() };
  const [showOthers, setShowOthers] = useState(false);
  const list = useQuery({
    queryKey: crmKeys.trialTeachers(leadId, query),
    queryFn: ({ signal }) => fetchTrialTeachers(leadId, query!, signal),
    enabled: !!query,
    placeholderData: keepPreviousData,
  });
  const data = list.data?.data;
  const selected = selectedOption(data, value);
  // The row changes with the time (eligibility, reasons): keep the dialog's copy current.
  useEffect(() => {
    onSelected(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `onSelected` is a fresh closure each render; the row is what matters.
  }, [selected]);
  const needsReason = !!selected && !selected.eligible;
  const reasonError =
    showErrors && needsReason && overrideReason.trim().length < 3 ? t('reasonRequired') : '';

  // The trial in the teacher's zone, with the day (it can be another day there; D30).
  const teacherTime = (o: TrialTeacherOptionDto) =>
    list.data
      ? t.rich('teacherTime', {
          time: dayAndClock(list.data.meta.startsAt, o.teacher.timezone, locale),
          city: cityOf(o.teacher.timezone, locale),
          bdi: (c) => <bdi>{c}</bdi>,
        })
      : null;

  const card = (o: TrialTeacherOptionDto) => {
    const id = `trial-teacher-${o.teacher.id}`;
    const busy = o.reasons.includes('busy');
    return (
      <FieldLabel key={o.teacher.id} htmlFor={id} className={busy ? 'opacity-60' : undefined}>
        <Field orientation="horizontal" data-disabled={busy || undefined}>
          <FieldContent>
            <FieldTitle className="flex flex-wrap items-center gap-2">
              {o.rank != null && (
                <Badge variant="secondary" className="tabular-nums">
                  {t('rank', { rank: o.rank })}
                </Badge>
              )}
              <bdi>{o.teacher.name}</bdi>
            </FieldTitle>
            {o.eligible ? (
              <ul
                id={`${id}-desc`}
                className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground"
              >
                <li>{teacherTime(o)}</li>
                <li className={o.inWorkHours ? undefined : 'font-medium text-foreground'}>
                  {t(o.inWorkHours ? 'inHours' : 'outsideHours')}
                </li>
                {o.languageMatch != null && (
                  <li>{t(o.languageMatch ? 'languageMatch' : 'languageOther')}</li>
                )}
                <li>
                  {o.conversion.rate == null
                    ? t('noTrialsYet')
                    : t('conversion', {
                        rate: o.conversion.rate,
                        converted: o.conversion.converted,
                        trials: o.conversion.trials,
                      })}
                </li>
                <li>
                  {o.weeklyFreeHours == null
                    ? t('noWorkHours')
                    : t('freeHours', { hours: Math.round(o.weeklyFreeHours) })}
                </li>
                <li>
                  {o.maxTrialsPerWeek == null
                    ? t('trialsWeek', { count: o.trialsThisWeek })
                    : t('trialsWeekOf', { count: o.trialsThisWeek, max: o.maxTrialsPerWeek })}
                </li>
              </ul>
            ) : (
              <span id={`${id}-desc`} className="flex flex-col gap-1">
                <span className="text-sm text-muted-foreground">{teacherTime(o)}</span>
                <span className="flex flex-wrap gap-1">
                  {o.reasons.map((r) => (
                    <Badge key={r} variant="outline">
                      {TRIAL_INELIGIBLE_LABELS[r][locale]}
                    </Badge>
                  ))}
                </span>
              </span>
            )}
          </FieldContent>
          <RadioGroupItem
            id={id}
            value={String(o.teacher.id)}
            disabled={busy}
            // Named by the teacher, described by their factors or reasons (and why a busy one is off).
            aria-label={o.teacher.name}
            aria-describedby={busy ? `${id}-desc ${ids.hint}` : `${id}-desc`}
          />
        </Field>
      </FieldLabel>
    );
  };

  return (
    <FieldSet data-invalid={showErrors && !!error}>
      <FieldLegend id={ids.legend} variant="label">
        {t('legend')}
      </FieldLegend>
      {!query ? (
        <FieldDescription>{t('chooseTimeFirst')}</FieldDescription>
      ) : list.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            {t('loadError')}
            <Button type="button" variant="outline" onClick={() => void list.refetch()}>
              {t('retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : !data ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : (
        <>
          <FieldDescription>{t('rankingHelp')}</FieldDescription>
          <RadioGroup
            id={TRIAL_TEACHERS_ID}
            aria-labelledby={ids.legend}
            aria-invalid={(showErrors && !!error) || undefined}
            aria-describedby={showErrors && error ? ids.error : undefined}
            value={value ?? ''}
            onValueChange={(v) => {
              if (selectedOption(data, v)) onChange(v);
            }}
            aria-busy={list.isFetching || undefined}
          >
            {data.eligible.length ? (
              data.eligible.map(card)
            ) : (
              <p className="rounded-lg border p-3 text-sm text-muted-foreground">
                {t('noneEligible')}
              </p>
            )}
            {data.ineligible.length > 0 && (
              <Collapsible
                open={showOthers || (!!selected && !selected.eligible)}
                onOpenChange={setShowOthers}
              >
                <CollapsibleTrigger asChild>
                  <Button type="button" variant="ghost" className="h-10 px-2">
                    {t('showOthers', { count: data.ineligible.length })}
                    <ChevronDownIcon className="transition-transform in-data-[state=open]:rotate-180" />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="flex flex-col gap-3 pt-2">
                  <p id={ids.hint} className="text-sm text-muted-foreground">
                    {t('othersHelp')}
                  </p>
                  {data.ineligible.map(card)}
                </CollapsibleContent>
              </Collapsible>
            )}
          </RadioGroup>
        </>
      )}
      {showErrors && error && <FieldError id={ids.error}>{error}</FieldError>}
      {needsReason && (
        <>
          {/* The warning stays an Alert; the field sits below it, so its validation is not
              announced assertively. */}
          <Alert variant="warning">
            <AlertDescription>
              {t('overrideIntro', {
                name: selected.teacher.name,
                reasons: new Intl.ListFormat(locale, { type: 'conjunction' }).format(
                  selected.reasons.map((r) => TRIAL_INELIGIBLE_LABELS[r][locale]),
                ),
              })}
            </AlertDescription>
          </Alert>
          <Field data-invalid={!!reasonError}>
            <FieldLabel htmlFor={ids.reason}>{t('overrideReason')}</FieldLabel>
            <Textarea
              id={ids.reason}
              value={overrideReason}
              onChange={(e) => onOverrideReason(e.target.value)}
              maxLength={500}
              aria-invalid={!!reasonError}
              aria-describedby={`${ids.reason}-msg`}
              className="min-h-20"
            />
            {reasonError ? (
              <FieldError id={`${ids.reason}-msg`}>{reasonError}</FieldError>
            ) : (
              <FieldDescription id={`${ids.reason}-msg`}>{t('overrideHelp')}</FieldDescription>
            )}
          </Field>
        </>
      )}
    </FieldSet>
  );
}

function selectedOption(
  data: { eligible: TrialTeacherOptionDto[]; ineligible: TrialTeacherOptionDto[] } | undefined,
  value: string | null,
) {
  if (!data || !value) return undefined;
  return [...data.eligible, ...data.ineligible].find((o) => String(o.teacher.id) === value);
}
