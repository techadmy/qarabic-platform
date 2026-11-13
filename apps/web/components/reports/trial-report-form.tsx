'use client';

import {
  TRIAL_ATTENDANCE_LABELS,
  TRIAL_ATTENDANCES,
  TRIAL_ENGAGEMENT_LABELS,
  TRIAL_ENGAGEMENTS,
  TRIAL_LEVEL_LABELS,
  TRIAL_LEVELS,
  trialReportInputSchema,
  type SessionDto,
  type TrialReportDto,
  type TrialReportInput,
} from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@qarabic/ui/components/field';
import { RadioGroup, RadioGroupItem } from '@qarabic/ui/components/radio-group';
import { Spinner } from '@qarabic/ui/components/spinner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Controller, useForm, type Control, type FieldValues, type Path } from 'react-hook-form';
import { toast } from 'sonner';
import { ComboboxField, SelectField, TextareaField } from '@/components/forms/fields';
import { useLookups } from '@/components/people/person-sheet';
import { useUiLocale } from '@/components/sessions/times';
import { isApiError } from '@/lib/api/client';
import { saveTrialReport, sessionKeys } from '@/lib/api/sessions';
import { applyServerErrors } from '@/lib/forms/server-errors';
import { useBeforeUnload } from '@/lib/forms/use-unsaved-guard';
import { useSchemaResolver } from '@/lib/forms/validation-messages';
import { useClassError } from '@/lib/sessions/errors';

type Values = {
  attendance: TrialReportInput['attendance'] | null;
  level: TrialReportInput['level'] | null;
  recommendedCourseId: number | null;
  classesPerWeek: number | null;
  minutesPerClass: number | null;
  engagement: TrialReportInput['engagement'] | null;
  notes: string;
};

const MINUTES = [30, 45, 60] as const;

/**
 * «تقرير الحصة التجريبية» (T4, docs/33 §3.6, B85): what the teacher saw in the trial, in under a
 * minute: attendance, level, the course and plan they recommend, engagement, a note for the CSR.
 * On an ended trial class it closes the class (taken) and moves the lead; on a taken one it edits
 * the report inside the edit window. Never shown to the family.
 */
export function TrialReportForm({
  session,
  report,
  onDone,
  onCancel,
}: {
  session: SessionDto;
  report: TrialReportDto | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('reports.trial');
  const tv = useTranslations('validation');
  const locale = useUiLocale();
  const lookups = useLookups();
  const queryClient = useQueryClient();
  const classError = useClassError();
  const [banner, setBanner] = useState<string | null>(null);
  const resolver = useSchemaResolver(trialReportInputSchema);
  const form = useForm<Values>({
    resolver: resolver as never,
    mode: 'onTouched',
    defaultValues: {
      attendance: report?.attendance ?? null,
      level: report?.level ?? null,
      recommendedCourseId: report?.recommendedCourse?.id ?? session.course.id,
      classesPerWeek: report?.classesPerWeek ?? 2,
      minutesPerClass: report?.minutesPerClass ?? session.durationMinutes,
      engagement: report?.engagement ?? null,
      notes: report?.notes ?? '',
    },
  });
  useBeforeUnload(form.formState.isDirty);
  const save = useMutation({
    mutationFn: (v: Values) => saveTrialReport(session.id, v as unknown as TrialReportInput),
    onSuccess: (saved) => {
      queryClient.setQueryData(sessionKeys.trialReport(session.id), saved);
      // The class is taken now (and the lead moved): refresh what shows it.
      void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
      form.reset(form.getValues());
      toast.success(report ? t('updated') : t('saved', { name: session.student.name }));
      onDone();
    },
    onError: (e) => {
      if (isApiError(e, 422) && e.code === 'trial_report_locked') {
        setBanner(t('locked'));
        return;
      }
      if (
        !applyServerErrors(form, e, (k) => tv(k), [
          'attendance',
          'level',
          'recommendedCourseId',
          'classesPerWeek',
          'minutesPerClass',
          'engagement',
          'notes',
        ])
      )
        setBanner(classError(e));
    },
  });
  const c = form.control;
  const courses = (lookups.data?.courses ?? [])
    .filter((x) => x.isActive)
    .map((x) => ({ value: String(x.id), label: locale === 'ar' ? x.nameAr : x.nameEn }));

  return (
    <form
      noValidate
      aria-labelledby="trial-report-title"
      className="flex flex-col gap-4"
      onSubmit={(e) =>
        void form.handleSubmit((v) => {
          setBanner(null);
          save.mutate(v);
        })(e)
      }
    >
      <div className="flex flex-col gap-1">
        <h3 id="trial-report-title" className="text-lg font-bold">
          {report ? t('editTitle') : t('title')}
        </h3>
        <p className="text-sm text-muted-foreground">{t('help', { name: session.student.name })}</p>
      </div>
      <FieldGroup>
        <ChoiceField
          control={c}
          name="attendance"
          label={t('attendance')}
          options={TRIAL_ATTENDANCES.map((v) => ({
            value: v,
            label: TRIAL_ATTENDANCE_LABELS[v][locale],
          }))}
        />
        <ChoiceField
          control={c}
          name="level"
          label={t('level')}
          options={TRIAL_LEVELS.map((v) => ({ value: v, label: TRIAL_LEVEL_LABELS[v][locale] }))}
        />
        <ComboboxField
          control={c}
          name="recommendedCourseId"
          label={t('course')}
          numeric
          options={courses}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            control={c}
            name="classesPerWeek"
            label={t('classesPerWeek')}
            numeric
            options={[1, 2, 3, 4, 5, 6, 7].map((n) => ({
              value: String(n),
              label: t('perWeek', { count: n }),
            }))}
          />
          <SelectField
            control={c}
            name="minutesPerClass"
            label={t('minutesPerClass')}
            numeric
            options={MINUTES.map((n) => ({ value: String(n), label: t('minutes', { count: n }) }))}
          />
        </div>
        <ChoiceField
          control={c}
          name="engagement"
          label={t('engagement')}
          options={TRIAL_ENGAGEMENTS.map((v) => ({
            value: v,
            label: TRIAL_ENGAGEMENT_LABELS[v][locale],
          }))}
        />
        <TextareaField control={c} name="notes" label={t('notes')} description={t('notesHelp')} />
      </FieldGroup>
      {banner && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{banner}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={save.isPending}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Spinner />}
          {report ? t('update') : t('submit')}
        </Button>
      </div>
    </form>
  );
}

/** One choice of a few (shadcn `RadioGroup` in a `fieldset`), laid out in a row. */
function ChoiceField<T extends FieldValues>({
  control,
  name,
  label,
  options,
}: {
  control: Control<T>;
  name: Path<T>;
  label: string;
  options: { value: string; label: string }[];
}) {
  const id = `trial-${String(name)}`;
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <FieldSet data-invalid={fieldState.invalid}>
          <FieldLegend variant="label">
            {label}
            <span className="text-destructive" aria-hidden>
              *
            </span>
          </FieldLegend>
          <RadioGroup
            value={(field.value as string | null) ?? ''}
            onValueChange={field.onChange}
            aria-invalid={fieldState.invalid || undefined}
            aria-describedby={fieldState.invalid ? `${id}-error` : undefined}
            className="flex flex-wrap gap-x-6 gap-y-3"
          >
            {options.map((o) => (
              <Field key={o.value} orientation="horizontal" className="w-auto">
                <RadioGroupItem id={`${id}-${o.value}`} value={o.value} />
                <FieldLabel htmlFor={`${id}-${o.value}`} className="font-normal">
                  {o.label}
                </FieldLabel>
              </Field>
            ))}
          </RadioGroup>
          {fieldState.invalid && <FieldError id={`${id}-error`} errors={[fieldState.error]} />}
        </FieldSet>
      )}
    />
  );
}

/** The trial report as the teacher, the CSR and staff read it (never the family). */
export function TrialReportView({ report }: { report: TrialReportDto }) {
  const t = useTranslations('reports.trial');
  const locale = useUiLocale();
  const rows: [string, string][] = [
    [t('attendance'), TRIAL_ATTENDANCE_LABELS[report.attendance][locale]],
    [t('level'), TRIAL_LEVEL_LABELS[report.level][locale]],
    [
      t('course'),
      report.recommendedCourse
        ? locale === 'ar'
          ? report.recommendedCourse.nameAr
          : report.recommendedCourse.nameEn
        : '—',
    ],
    [
      t('plan'),
      t('planValue', {
        perWeek: t('perWeek', { count: report.classesPerWeek }),
        minutes: t('minutes', { count: report.minutesPerClass }),
      }),
    ],
    [t('engagement'), TRIAL_ENGAGEMENT_LABELS[report.engagement][locale]],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
      {report.notes && (
        <div className="contents">
          <dt className="text-muted-foreground">{t('notes')}</dt>
          <dd className="whitespace-pre-line">{report.notes}</dd>
        </div>
      )}
    </dl>
  );
}
