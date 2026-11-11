'use client';

import {
  needsHifz,
  needsReading,
  overallScore,
  recordTestResultSchema,
  tajweedScore,
  TEST_MISTAKE_LABELS,
  TEST_SCORE_OPTIONS,
  TEST_SECTION_LABELS,
  TEST_SECTIONS,
  type RecordTestResultInput,
  type TestDto,
} from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { Checkbox } from '@qarabic/ui/components/checkbox';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@qarabic/ui/components/field';
import { Input } from '@qarabic/ui/components/input';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Textarea } from '@qarabic/ui/components/textarea';
import { ToggleGroup, ToggleGroupItem } from '@qarabic/ui/components/toggle-group';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { useUiLocale } from '@/components/sessions/times';
import { recordTestResult, teachingKeys } from '@/lib/api/teaching';
import { useBeforeUnload } from '@/lib/forms/use-unsaved-guard';
import { useTestError } from './test-bits';

/**
 * Record or correct a result (docs/27 §3, §8; the current app's `ResultForm`): one card per tested
 * section with its mistake checkboxes in words, reading / memorisation as five segmented buttons,
 * the live tajweed and overall percentages (D115, shared `tajweedScore` / `overallScore`), remarks
 * for the parent, internal notes; the examiner's rating for staff, and a reason for a staff
 * correction (D116).
 */
export function ResultForm({
  test,
  staff,
  onDone,
  onCancel,
}: {
  test: TestDto;
  staff: boolean;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const t = useTranslations('tests.result');
  const locale = useUiLocale();
  const queryClient = useQueryClient();
  const message = useTestError();
  const r = test.result;
  const correction = test.status === 'taken';
  const [mistakes, setMistakes] = useState<number[]>(r?.mistakes ?? []);
  const [reading, setReading] = useState<number | null>(r?.reading ?? null);
  const [hifz, setHifz] = useState<number | null>(r?.hifz ?? null);
  const [remarks, setRemarks] = useState(r?.remarks ?? '');
  const [internal, setInternal] = useState(r?.internalNotes ?? '');
  const [rating, setRating] = useState(
    r?.teacherRating !== undefined && r?.teacherRating !== null ? String(r.teacherRating) : '',
  );
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [dirty, setDirty] = useState(false);
  useBeforeUnload(dirty);
  const save = useMutation({
    mutationFn: (body: RecordTestResultInput) => recordTestResult(test.id, body),
    onSuccess: (next) => {
      queryClient.setQueryData(teachingKeys.test(test.id), next);
      void queryClient.invalidateQueries({ queryKey: teachingKeys.all });
      setDirty(false);
      toast.success(correction ? t('corrected') : t('saved'));
      onDone();
    },
  });

  const sections = TEST_SECTIONS.filter((s) => test.sections.includes(s.key));
  const tajweed = tajweedScore(test.sections, mistakes);
  const overall = overallScore(test.track, tajweed, reading, hifz);
  const needReason = staff && correction;
  const ratingNumber = rating === '' ? null : Number(rating);
  const missing = {
    reading: needsReading(test.track) && reading === null,
    hifz: needsHifz(test.track) && hifz === null,
    reason: needReason && reason.trim().length < 3,
    rating:
      ratingNumber !== null &&
      (!Number.isInteger(ratingNumber) || ratingNumber < 0 || ratingNumber > 100),
  };
  const change =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setDirty(true);
    };
  const toggle = (m: number) => {
    setDirty(true);
    setMistakes((x) =>
      x.includes(m) ? x.filter((y) => y !== m) : [...x, m].sort((a, b) => a - b),
    );
  };

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (Object.values(missing).some(Boolean)) {
      const first = missing.reading
        ? 'score-reading'
        : missing.hifz
          ? 'score-hifz'
          : missing.rating
            ? 'result-rating'
            : 'result-reason';
      document.getElementById(first)?.querySelector<HTMLElement>('button')?.focus();
      document.getElementById(first)?.focus();
      return;
    }
    const body: RecordTestResultInput = {
      mistakes,
      ...(needsReading(test.track) ? { readingScore: reading } : {}),
      ...(needsHifz(test.track) ? { hifzScore: hifz } : {}),
      remarks: remarks.trim() || null,
      internalNotes: internal.trim() || null,
      ...(staff && ratingNumber !== null ? { teacherRating: ratingNumber } : {}),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    };
    const parsed = recordTestResultSchema.safeParse(body);
    if (!parsed.success) return;
    save.mutate(body);
  }

  const scorePicker = (
    id: string,
    label: string,
    value: number | null,
    onChange: (v: number) => void,
    error: boolean,
  ) => (
    <Field data-invalid={error}>
      <FieldLabel id={`${id}-label`}>
        {label}
        <span className="text-destructive" aria-hidden>
          *
        </span>
      </FieldLabel>
      <ToggleGroup
        id={id}
        type="single"
        variant="outline"
        spacing={0}
        value={value === null ? '' : String(value)}
        onValueChange={(v) => v && onChange(Number(v))}
        aria-labelledby={`${id}-label`}
        aria-invalid={error}
        className="flex-wrap bg-card"
      >
        {TEST_SCORE_OPTIONS.map((o) => (
          <ToggleGroupItem
            key={o}
            value={String(o)}
            className="h-11 min-w-14 data-[state=on]:bg-accent data-[state=on]:font-bold"
          >
            <bdi>{o}%</bdi>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {error && <FieldError>{t('pickScore')}</FieldError>}
    </Field>
  );

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      <div
        aria-live="polite"
        className="sticky top-16 z-[5] -mx-4 flex flex-wrap gap-x-6 gap-y-1 border-b bg-card px-4 py-2"
      >
        <span>
          {t('tajweed')}: <bdi className="font-bold tabular-nums">{tajweed}%</bdi>
        </span>
        <span>
          {t('overall')}: <bdi className="font-bold tabular-nums">{overall}%</bdi>
        </span>
        <span className="text-muted-foreground">
          {t('mistakesCount', { count: mistakes.length })}
        </span>
      </div>
      {sections.map((s) => (
        <Card key={s.key} className="gap-2 py-4 shadow-none">
          <CardHeader className="px-4">
            <CardTitle className="text-base font-bold">
              {TEST_SECTION_LABELS[s.key][locale]}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4">
            <FieldGroup
              className="gap-1"
              role="group"
              aria-label={TEST_SECTION_LABELS[s.key][locale]}
            >
              {s.mistakes.map((m) => (
                <Field key={m} orientation="horizontal" className="min-h-11 items-center">
                  <Checkbox
                    id={`mistake-${m}`}
                    checked={mistakes.includes(m)}
                    onCheckedChange={() => toggle(m)}
                  />
                  <FieldLabel htmlFor={`mistake-${m}`} className="font-normal">
                    {TEST_MISTAKE_LABELS[m]?.[locale]}
                  </FieldLabel>
                </Field>
              ))}
            </FieldGroup>
          </CardContent>
        </Card>
      ))}
      <FieldGroup>
        {needsReading(test.track) &&
          scorePicker(
            'score-reading',
            t('reading'),
            reading,
            change(setReading),
            touched && missing.reading,
          )}
        {needsHifz(test.track) &&
          scorePicker('score-hifz', t('hifz'), hifz, change(setHifz), touched && missing.hifz)}
        <Field>
          <FieldLabel htmlFor="result-remarks">{t('remarks')}</FieldLabel>
          <Textarea
            id="result-remarks"
            rows={2}
            maxLength={2000}
            value={remarks}
            onChange={(e) => change(setRemarks)(e.target.value)}
          />
          <FieldDescription>{t('remarksHelp')}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="result-internal">{t('internalNotes')}</FieldLabel>
          <Textarea
            id="result-internal"
            rows={2}
            maxLength={2000}
            value={internal}
            onChange={(e) => change(setInternal)(e.target.value)}
          />
          <FieldDescription>{t('internalHelp')}</FieldDescription>
        </Field>
        {staff && (
          <Field data-invalid={touched && missing.rating} className="max-w-xs">
            <FieldLabel htmlFor="result-rating">{t('teacherRating')}</FieldLabel>
            <Input
              id="result-rating"
              type="number"
              inputMode="numeric"
              dir="ltr"
              min={0}
              max={100}
              value={rating}
              onChange={(e) => change(setRating)(e.target.value)}
              aria-invalid={touched && missing.rating}
              className="h-10 text-start"
            />
            <FieldDescription>{t('teacherRatingHelp')}</FieldDescription>
            {touched && missing.rating && <FieldError>{t('ratingRange')}</FieldError>}
          </Field>
        )}
        {needReason && (
          <Field data-invalid={touched && missing.reason}>
            <FieldLabel htmlFor="result-reason">
              {t('reason')}
              <span className="text-destructive" aria-hidden>
                *
              </span>
            </FieldLabel>
            <Textarea
              id="result-reason"
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => change(setReason)(e.target.value)}
              aria-required
              aria-invalid={touched && missing.reason}
            />
            <FieldDescription>{t('reasonHelp')}</FieldDescription>
            {touched && missing.reason && <FieldError>{t('reasonRequired')}</FieldError>}
          </Field>
        )}
      </FieldGroup>
      {save.isError && (
        <Alert variant="destructive" role="alert">
          <AlertCircleIcon />
          <AlertDescription>{message(save.error)}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="lg" disabled={save.isPending}>
          {save.isPending && <Spinner />}
          {correction ? t('saveCorrection') : t('save')}
        </Button>
        {onCancel && (
          <Button type="button" size="lg" variant="outline" onClick={onCancel}>
            {t('cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}
