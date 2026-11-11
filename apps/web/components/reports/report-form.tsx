'use client';

import {
  ayahCountOf,
  HIFZ_GRADE_LABELS,
  HIFZ_GRADES,
  HIFZ_TYPE_LABELS,
  QURAN_SURAHS,
  REPORT_FIELD_LABELS,
  type HifzGrade,
  type LastPositionDto,
  type LessonReportDto,
  type SessionDto,
} from '@qarabic/shared';
import { Alert, AlertDescription, AlertTitle } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@qarabic/ui/components/field';
import { Input } from '@qarabic/ui/components/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@qarabic/ui/components/input-group';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Textarea } from '@qarabic/ui/components/textarea';
import { ToggleGroup, ToggleGroupItem } from '@qarabic/ui/components/toggle-group';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon, ClockIcon, MinusIcon, PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import {
  Controller,
  useForm,
  useWatch,
  type Control,
  type FieldErrors,
  type Resolver,
  type UseFormSetValue,
} from 'react-hook-form';
import { toast } from 'sonner';
import { Combobox } from '@/components/forms/fields';
import { useNow, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { isApiError } from '@/lib/api/client';
import { fetchProgress, submitReport, teachingKeys } from '@/lib/api/teaching';
import { can } from '@/lib/auth/use-me';
import { useBeforeUnload } from '@/lib/forms/use-unsaved-guard';
import { serverMessageKey } from '@/lib/forms/server-errors';
import {
  continueFromLast,
  emptyRow,
  initialValues,
  sameAsLast,
  serverKeyToPath,
  toReportInput,
  validateReport,
  type HifzRowValues,
  type ReportFormValues,
} from '@/lib/reports/report-form';
import { upsertSession } from '@/lib/sessions/cache';
import { useClassError } from '@/lib/sessions/errors';
import { dayAndClock, relativeTime } from '@/lib/schedule-time';
import { RatingInput } from './report-bits';

/** Nested RHF errors from flat paths (`hifz.1.toAyah`). */
function toErrors(list: { path: string; message: string }[]): FieldErrors<ReportFormValues> {
  const out: Record<string, unknown> = {};
  for (const { path, message } of list) {
    const keys = path.split('.');
    let node = out;
    keys.forEach((k, i) => {
      if (i === keys.length - 1) node[k] ??= { type: 'validate', message };
      else node = (node[k] ??= /^\d+$/.test(keys[i + 1]!) ? [] : {}) as Record<string, unknown>;
    });
  }
  return out as FieldErrors<ReportFormValues>;
}

/**
 * The lesson report form (docs/14 §2.11; the current app's `ReportPanel`, target ≤ 30 s): the
 * summary for the parent, three hifz rows (surah + ayah pickers checked against the Quran, pages,
 * grade, mistakes, with «تابع من آخر موضع» / «مثل المرة السابقة»), tajweed notes, homework, the 1–5
 * rating and the internal note. The teacher sees until when they may still edit; a stale class or
 * a closed window is said plainly. `PUT /sessions/:id/report` with `expectedStage`.
 */
export function ReportForm({
  session,
  report,
  onDone,
  onCancel,
}: {
  session: SessionDto;
  report: LessonReportDto | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('reports.form');
  const tv = useTranslations('validation');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const now = useNow(60_000);
  const me = useCurrentUser();
  const staff = can(me, 'sessions.manage');
  const queryClient = useQueryClient();
  const classError = useClassError();
  const L = (k: keyof typeof REPORT_FIELD_LABELS) => REPORT_FIELD_LABELS[k][locale];
  const [banner, setBanner] = useState<{ title?: string; text: string } | null>(null);
  const progress = useQuery({
    queryKey: teachingKeys.progress(session.student.id),
    queryFn: ({ signal }) => fetchProgress(session.student.id, signal),
    retry: false,
  });

  const resolver = useMemo<Resolver<ReportFormValues>>(
    () => (values) => {
      const errors = validateReport(values);
      if (!errors.length) return { values, errors: {} };
      return {
        values: {},
        errors: toErrors(
          errors.map((e) => ({ path: e.path, message: t(`errors.${e.key}`, e.values ?? {}) })),
        ),
      };
    },
    [t],
  );
  const form = useForm<ReportFormValues>({
    defaultValues: initialValues(report),
    resolver,
    mode: 'onTouched',
  });
  useBeforeUnload(form.formState.isDirty);

  const save = useMutation({
    mutationFn: (v: ReportFormValues) => {
      const stage =
        session.stage === 'ended' || session.stage === 'taken' ? session.stage : undefined;
      const { input, rowIndex } = toReportInput(v, stage);
      return submitReport(session.id, input).catch((e: unknown) => {
        throw Object.assign(e as object, { rowIndex });
      });
    },
    onSuccess: (s) => {
      upsertSession(queryClient, s);
      void queryClient.invalidateQueries({ queryKey: teachingKeys.all });
      form.reset(form.getValues());
      toast.success(report ? t('updated') : t('saved', { name: session.student.name }));
      onDone();
    },
    onError: (e) => {
      if (isApiError(e, 409) && e.code === 'stale_session') {
        setBanner({ title: t('staleTitle'), text: t('stale') });
        void queryClient.invalidateQueries({ queryKey: ['sessions'] });
        return;
      }
      if (isApiError(e, 422) && e.code === 'outside_window') {
        setBanner({ title: t('lockedTitle'), text: L('editLocked') });
        return;
      }
      if (isApiError(e, 422) && e.error?.errors) {
        const rowIndex = (e as unknown as { rowIndex: number[] }).rowIndex ?? [];
        let first: string | null = null;
        for (const [key, messages] of Object.entries(e.error.errors)) {
          const path = serverKeyToPath(key, rowIndex);
          if (!path) continue;
          form.setError(path as never, {
            type: 'server',
            message: /ayah|surah/i.test(messages[0] ?? '')
              ? t('errors.invalid')
              : tv(serverMessageKey(messages[0])),
          });
          first ??= path;
        }
        if (first) {
          form.setFocus(first as never);
          return;
        }
      }
      setBanner({ text: classError(e) });
    },
  });

  const submit = form.handleSubmit(
    (v) => {
      setBanner(null);
      save.mutate(v);
    },
    () => setBanner(null),
  );

  const until = session.report.editableUntil;
  const ownTeacher = !staff && session.stage === 'taken' && until;
  const lastPositions = progress.data?.lastPositions;

  return (
    <form
      noValidate
      onSubmit={submit}
      className="flex flex-col gap-5"
      aria-labelledby="report-title"
    >
      <div className="flex flex-col gap-1">
        <h3 id="report-title" className="text-base font-bold">
          {report ? t('editTitle') : L('title')}
        </h3>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
      </div>
      {ownTeacher && (
        <Alert>
          <ClockIcon />
          <AlertTitle>{t('editableUntil', { time: dayAndClock(until, tz, locale) })}</AlertTitle>
          <AlertDescription>
            {t('editableLeft', { ago: relativeTime(until, now, locale) })}
          </AlertDescription>
        </Alert>
      )}
      {staff && session.stage === 'taken' && (
        <Alert>
          <AlertCircleIcon />
          <AlertDescription>{t('staffEdit')}</AlertDescription>
        </Alert>
      )}

      <Controller
        control={form.control}
        name="summary"
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor="report-summary">
              {L('summary')}
              <span className="text-destructive" aria-hidden>
                *
              </span>
            </FieldLabel>
            <Textarea
              dir="auto"
              {...field}
              id="report-summary"
              rows={3}
              aria-required
              aria-invalid={fieldState.invalid}
              className="md:text-[0.9375rem]"
            />
            <FieldDescription>{L('summaryHint')}</FieldDescription>
            {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
          </Field>
        )}
      />

      <FieldSet>
        <FieldLegend>{L('hifz')}</FieldLegend>
        <FieldDescription>{t('hifzHint')}</FieldDescription>
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <HifzRow
              key={i}
              index={i}
              control={form.control}
              setValue={form.setValue}
              lastPositions={lastPositions}
            />
          ))}
        </div>
      </FieldSet>

      <FieldGroup>
        <Controller
          control={form.control}
          name="tajweedNotes"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="report-tajweed">
                {L('tajweedNotes')}{' '}
                <span className="font-normal text-muted-foreground">({t('optional')})</span>
              </FieldLabel>
              <Textarea
                dir="auto"
                {...field}
                id="report-tajweed"
                rows={2}
                aria-invalid={fieldState.invalid}
              />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="homework"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="report-homework">
                {L('homework')}{' '}
                <span className="font-normal text-muted-foreground">({t('optional')})</span>
              </FieldLabel>
              <Textarea
                dir="auto"
                {...field}
                id="report-homework"
                rows={2}
                aria-invalid={fieldState.invalid}
              />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="rating"
          render={({ field }) => (
            <Field>
              <FieldLabel id="report-rating-label">
                {L('rating')}{' '}
                <span className="font-normal text-muted-foreground">({t('optional')})</span>
              </FieldLabel>
              <RatingInput
                value={field.value}
                onChange={field.onChange}
                labelledBy="report-rating-label"
              />
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="teacherNotes"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="report-internal">
                {L('teacherNotes')}{' '}
                <span className="font-normal text-muted-foreground">({t('optional')})</span>
              </FieldLabel>
              <Textarea
                dir="auto"
                {...field}
                id="report-internal"
                rows={2}
                aria-invalid={fieldState.invalid}
              />
              <FieldDescription>{L('teacherNotesHint')}</FieldDescription>
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
      </FieldGroup>

      {banner && (
        <Alert variant="destructive" role="alert">
          <AlertCircleIcon />
          {banner.title && <AlertTitle>{banner.title}</AlertTitle>}
          <AlertDescription>{banner.text}</AlertDescription>
        </Alert>
      )}
      <div className="sticky bottom-0 -mx-4 flex gap-2 border-t bg-background px-4 py-3">
        <Button type="submit" size="lg" className="flex-1 sm:flex-none" disabled={save.isPending}>
          {save.isPending && <Spinner />}
          {save.isPending ? t('saving') : L('submit')}
        </Button>
        <Button type="button" size="lg" variant="outline" onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  );
}

const SURAH_OPTIONS = (locale: 'ar' | 'en', ayahs: (n: number) => string) =>
  QURAN_SURAHS.map((s) => ({
    value: String(s.number),
    label: `${s.number}. ${locale === 'ar' ? s.nameAr : s.nameEn}`,
    keywords: [s.nameAr, s.nameEn, String(s.number)],
    hint: ayahs(s.ayahCount),
  }));

function HifzRow({
  index,
  control,
  setValue,
  lastPositions,
}: {
  index: number;
  control: Control<ReportFormValues>;
  setValue: UseFormSetValue<ReportFormValues>;
  lastPositions: LastPositionDto[] | undefined;
}) {
  const t = useTranslations('reports.form');
  const tr = useTranslations('reports');
  const locale = useUiLocale();
  const L = (k: keyof typeof REPORT_FIELD_LABELS) => REPORT_FIELD_LABELS[k][locale];
  const row = useWatch({ control, name: `hifz.${index}` }) as HifzRowValues;
  const options = useMemo(
    () => SURAH_OPTIONS(locale, (n) => tr('ayahsCount', { count: n })),
    [locale, tr],
  );
  const heading = HIFZ_TYPE_LABELS[row.type][locale];
  const fill = (v: HifzRowValues | null) => {
    if (v) setValue(`hifz.${index}`, v, { shouldDirty: true, shouldValidate: false });
  };
  const last = sameAsLast(row.type, lastPositions);
  const cont = row.type === 'sabaq' ? continueFromLast(row.type, lastPositions) : null;
  const base = `hifz-${index}`;

  const side = (end: 'from' | 'to') => {
    const surahName = `hifz.${index}.${end}Surah` as const;
    const ayahName = `hifz.${index}.${end}Ayah` as const;
    const surah = end === 'from' ? row.fromSurah : row.toSurah;
    const max = surah ? ayahCountOf(surah) : null;
    return (
      <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] items-start gap-2">
        <Controller
          control={control}
          name={surahName}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={`${base}-${end}-surah`}>
                {L(end)}: {L('surah')}
              </FieldLabel>
              <Combobox
                id={`${base}-${end}-surah`}
                value={field.value ? String(field.value) : null}
                onChange={(v) => field.onChange(v ? Number(v) : null)}
                onBlur={field.onBlur}
                buttonRef={field.ref}
                options={options}
                placeholder={t('chooseSurah')}
                searchPlaceholder={t('searchSurah')}
                invalid={fieldState.invalid}
              />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={control}
          name={ayahName}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={`${base}-${end}-ayah`}>{L('ayah')}</FieldLabel>
              <Input
                ref={field.ref}
                name={field.name}
                onBlur={field.onBlur}
                id={`${base}-${end}-ayah`}
                type="number"
                inputMode="numeric"
                dir="ltr"
                min={1}
                max={max ?? undefined}
                value={field.value ?? ''}
                onChange={(e) =>
                  field.onChange(e.target.value === '' ? null : Number(e.target.value))
                }
                aria-invalid={fieldState.invalid}
                aria-describedby={max ? `${base}-${end}-range` : undefined}
                className="h-10 text-start"
              />
              {max && !fieldState.invalid && (
                <FieldDescription id={`${base}-${end}-range`}>
                  {t('ayahRangeHint', { max })}
                </FieldDescription>
              )}
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
      </div>
    );
  };

  return (
    <fieldset aria-label={heading} className="flex min-w-0 flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <legend className="float-start font-semibold">{heading}</legend>
        <div className="flex flex-wrap gap-1">
          {cont && (
            <Button type="button" size="sm" variant="ghost" onClick={() => fill(cont)}>
              {t('continueFromLast')}
              <span className="sr-only">: {heading}</span>
            </Button>
          )}
          {last && (
            <Button type="button" size="sm" variant="ghost" onClick={() => fill(last)}>
              {t('sameAsLast')}
              <span className="sr-only">: {heading}</span>
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => fill(emptyRow(row.type))}
          >
            {t('clearRow')}
            <span className="sr-only">: {heading}</span>
          </Button>
        </div>
      </div>
      {side('from')}
      {side('to')}
      <Controller
        control={control}
        name={`hifz.${index}.grade`}
        render={({ field }) => (
          <Field>
            <FieldLabel id={`${base}-grade`}>{L('grade')}</FieldLabel>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              spacing={0}
              value={field.value ?? ''}
              onValueChange={(v) => field.onChange((v || null) as HifzGrade | null)}
              aria-labelledby={`${base}-grade`}
              className="flex-wrap bg-card"
            >
              {HIFZ_GRADES.map((g) => (
                <ToggleGroupItem
                  key={g}
                  value={g}
                  className="h-9 px-2.5 data-[state=on]:bg-accent data-[state=on]:font-semibold"
                >
                  {HIFZ_GRADE_LABELS[g][locale]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
        )}
      />
      <div className="grid grid-cols-2 items-start gap-2">
        <Controller
          control={control}
          name={`hifz.${index}.mistakes`}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={`${base}-mistakes`}>{L('mistakes')}</FieldLabel>
              <InputGroup className="h-10">
                <InputGroupAddon>
                  <InputGroupButton
                    size="icon-xs"
                    aria-label={t('lessMistakes')}
                    disabled={!field.value}
                    onClick={() => field.onChange(Math.max(0, (field.value ?? 0) - 1))}
                  >
                    <MinusIcon />
                  </InputGroupButton>
                </InputGroupAddon>
                <InputGroupInput
                  ref={field.ref}
                  id={`${base}-mistakes`}
                  type="number"
                  inputMode="numeric"
                  dir="ltr"
                  min={0}
                  max={999}
                  value={field.value ?? ''}
                  onChange={(e) =>
                    field.onChange(e.target.value === '' ? null : Number(e.target.value))
                  }
                  onBlur={field.onBlur}
                  aria-invalid={fieldState.invalid}
                  className="text-center tabular-nums"
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    size="icon-xs"
                    aria-label={t('moreMistakes')}
                    onClick={() => field.onChange(Math.min(999, (field.value ?? 0) + 1))}
                  >
                    <PlusIcon />
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={control}
          name={`hifz.${index}.pages`}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={`${base}-pages`}>{L('pages')}</FieldLabel>
              <Input
                ref={field.ref}
                name={field.name}
                onBlur={field.onBlur}
                id={`${base}-pages`}
                type="number"
                inputMode="decimal"
                dir="ltr"
                min={0}
                max={604}
                step={0.25}
                value={field.value ?? ''}
                onChange={(e) =>
                  field.onChange(e.target.value === '' ? null : Number(e.target.value))
                }
                aria-invalid={fieldState.invalid}
                className="h-10 text-start"
              />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
      </div>
    </fieldset>
  );
}
