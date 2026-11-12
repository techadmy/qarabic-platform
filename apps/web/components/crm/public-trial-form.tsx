'use client';

import {
  HEARD_FROM,
  HEARD_FROM_LABELS,
  PREFERRED_PERIOD_LABELS,
  PREFERRED_PERIODS,
  publicTrialRequestSchema,
  TEACHER_GENDER_PREF_LABELS,
  TEACHER_GENDER_PREFS,
  type PublicTrialRequestInput,
} from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@qarabic/ui/components/card';
import { Checkbox } from '@qarabic/ui/components/checkbox';
import {
  FieldError,
  FieldGroup,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from '@qarabic/ui/components/field';
import { Label } from '@qarabic/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@qarabic/ui/components/radio-group';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Spinner } from '@qarabic/ui/components/spinner';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CircleCheckIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import { BrandLogo } from '@/components/brand-logo';
import {
  ComboboxField,
  NumberField,
  SelectField,
  TextareaField,
  TextField,
} from '@/components/forms/fields';
import { CountryField, PhoneField, TimeZoneField } from '@/components/forms/people-fields';
import { LanguageSwitch } from '@/components/language-switch';
import { useUiLocale } from '@/components/sessions/times';
import { isApiError } from '@/lib/api/client';
import { crmKeys, fetchPublicCourses, sendTrialRequest } from '@/lib/api/crm';
import { applyServerErrors } from '@/lib/forms/server-errors';
import { useSchemaResolver } from '@/lib/forms/validation-messages';
import { STAFF_WEEK, weekdayName } from '@/lib/schedule-time';
import { browserTimeZone } from '@/lib/time';
import { useDirection } from '@/lib/use-direction';

type Child = {
  name: string;
  age: number | null;
  gender: 'male' | 'female' | null;
  courseId: number | null;
};
type Values = {
  parentName: string;
  phone: string;
  email: string;
  countryCode: string | null;
  timezone: string;
  children: Child[];
  preferredDays: number[];
  preferredPeriods: (typeof PREFERRED_PERIODS)[number][];
  preferredNote: string | null;
  teacherGenderPref: (typeof TEACHER_GENDER_PREFS)[number];
  heardFrom: (typeof HEARD_FROM)[number] | null;
  message: string | null;
};
const FIELDS = [
  'parentName',
  'phone',
  'email',
  'countryCode',
  'timezone',
  'children',
  'preferredDays',
  'preferredPeriods',
];
const UTM = ['source', 'medium', 'campaign', 'term', 'content'] as const;

/**
 * The public free-trial form at `/trial` (docs/33 §3.1; the current app's `TrialFormPage`): no
 * login, Arabic or English, the courses from `/public/courses`, a hidden honeypot field, then a
 * thank-you state. The answer is the same for a new, merged or bot submission.
 */
export function PublicTrialForm() {
  const t = useTranslations('trialForm');
  const [sentName, setSentName] = useState<string | null>(null);
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-3">
        <BrandLogo className="w-36" priority />
        <LanguageSwitch />
      </header>
      <main id="main" className="mx-auto w-full max-w-3xl px-4 pb-12">
        <Card className="shadow-none">
          {sentName !== null ? (
            <CardContent
              className="flex flex-col items-center gap-3 py-10 text-center"
              role="status"
            >
              <CircleCheckIcon className="size-14 text-status-green-emphasis" aria-hidden />
              <h1 className="text-2xl font-bold">
                {sentName ? t('thanks.titleNamed', { name: sentName }) : t('thanks.title')}
              </h1>
              <p>{t('thanks.body')}</p>
              <p className="text-muted-foreground">{t('thanks.next')}</p>
            </CardContent>
          ) : (
            <>
              <CardHeader>
                <CardTitle className="text-2xl font-bold">
                  <h1>{t('title')}</h1>
                </CardTitle>
                <CardDescription className="text-body">{t('intro')}</CardDescription>
              </CardHeader>
              <CardContent>
                <TrialForm onSent={setSentName} />
              </CardContent>
            </>
          )}
        </Card>
      </main>
    </div>
  );
}

function TrialForm({ onSent }: { onSent: (name: string) => void }) {
  const t = useTranslations('trialForm');
  const tv = useTranslations('validation');
  const locale = useUiLocale();
  const dir = useDirection();
  const search = useSearchParams();
  const [honeypot, setHoneypot] = useState('');
  const [error, setError] = useState<string | null>(null);
  const courses = useQuery({
    queryKey: crmKeys.publicCourses,
    queryFn: ({ signal }) => fetchPublicCourses(signal),
  });
  const resolver = useSchemaResolver(publicTrialRequestSchema);
  const form = useForm<Values>({
    resolver: resolver as never,
    mode: 'onTouched',
    defaultValues: {
      parentName: '',
      phone: '',
      email: '',
      countryCode: null,
      timezone: browserTimeZone(),
      children: [{ name: '', age: null, gender: null, courseId: null }],
      preferredDays: [],
      preferredPeriods: [],
      preferredNote: null,
      teacherGenderPref: 'any',
      heardFrom: null,
      message: null,
    },
  });
  const children = useFieldArray({ control: form.control, name: 'children' });
  const country = useWatch({ control: form.control, name: 'countryCode' });
  const send = useMutation({
    mutationFn: (body: PublicTrialRequestInput & { website?: string }) => sendTrialRequest(body),
    onSuccess: (_d, body) => onSent(body.parentName),
    onError: (e) => {
      if (isApiError(e, 429)) return setError(t('errors.tooMany'));
      if (isApiError(e) && e.code === 'captcha_failed') return setError(t('errors.captcha'));
      if (applyServerErrors(form, e, (k) => tv(k), FIELDS)) return setError(t('errors.fixFields'));
      setError(t('errors.generic'));
    },
  });
  const courseOptions = (courses.data ?? []).map((c) => ({
    value: String(c.id),
    label: locale === 'ar' ? c.nameAr : c.nameEn,
  }));
  const utm = Object.fromEntries(
    UTM.map((k) => [k, search.get(`utm_${k}`)]).filter(([, v]) => v),
  ) as Record<string, string>;

  const submit = form.handleSubmit(
    (v) => {
      setError(null);
      send.mutate({
        ...(v as unknown as PublicTrialRequestInput),
        locale,
        utm: Object.keys(utm).length ? utm : null,
        website: honeypot,
      });
    },
    () => setError(t('errors.fixFields')),
  );

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="relative flex flex-col gap-6">
      {/* Honeypot: hidden from people and screen readers; bots fill it. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-0 size-0 overflow-hidden opacity-0"
      >
        <label htmlFor="trial-website">Website</label>
        <input
          id="trial-website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
        />
      </div>

      <FieldSet>
        <FieldLegend>{t('sections.parent')}</FieldLegend>
        <FieldGroup>
          <TextField
            control={form.control}
            name="parentName"
            label={t('fields.parentName')}
            required
            inputProps={{ autoComplete: 'name' }}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <CountryField
              control={form.control}
              name="countryCode"
              label={t('fields.country')}
              required
            />
            <TimeZoneField
              control={form.control}
              name="timezone"
              label={t('fields.timezone')}
              required
            />
          </div>
          <PhoneField
            key={country ?? 'none'}
            control={form.control}
            name="phone"
            label={t('fields.whatsapp')}
            required
            defaultCountry={country}
          />
          <TextField
            control={form.control}
            name="email"
            label={t('fields.email')}
            required
            inputProps={{ type: 'email', dir: 'ltr', autoComplete: 'email' }}
          />
        </FieldGroup>
      </FieldSet>

      <FieldSeparator />
      <FieldSet>
        <FieldLegend>{t('sections.children')}</FieldLegend>
        {courses.isError && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{t('errors.courses')}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col gap-3">
          {children.fields.map((f, i) => (
            <fieldset key={f.id} className="flex flex-col gap-3 rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <legend className="font-semibold">{t('child', { n: i + 1 })}</legend>
                {children.fields.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t('removeChild', { n: i + 1 })}
                    onClick={() => children.remove(i)}
                  >
                    <Trash2Icon />
                  </Button>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-[1fr_6rem_8rem]">
                <TextField
                  control={form.control}
                  name={`children.${i}.name`}
                  label={t('fields.childName')}
                  required
                />
                <NumberField
                  control={form.control}
                  name={`children.${i}.age`}
                  label={t('fields.age')}
                  required
                  min={3}
                  max={99}
                />
                <SelectField
                  control={form.control}
                  name={`children.${i}.gender`}
                  label={t('fields.gender')}
                  required
                  options={[
                    { value: 'male', label: t('gender.male') },
                    { value: 'female', label: t('gender.female') },
                  ]}
                />
              </div>
              {courses.isPending ? (
                <Skeleton className="h-16" />
              ) : (
                <ComboboxField
                  control={form.control}
                  name={`children.${i}.courseId`}
                  label={t('fields.course')}
                  required
                  numeric
                  options={courseOptions}
                />
              )}
            </fieldset>
          ))}
          {children.fields.length < 10 && (
            <Button
              type="button"
              variant="outline"
              className="self-start"
              onClick={() => children.append({ name: '', age: null, gender: null, courseId: null })}
            >
              <PlusIcon />
              {t('addChild')}
            </Button>
          )}
        </div>
      </FieldSet>

      <FieldSeparator />
      <FieldSet>
        <FieldLegend>{t('sections.times')}</FieldLegend>
        <FieldGroup>
          <Controller
            control={form.control}
            name="preferredDays"
            render={({ field, fieldState }) => (
              <FieldSet data-invalid={fieldState.invalid}>
                <FieldLegend variant="label">
                  {t('fields.days')}
                  <span className="text-destructive" aria-hidden>
                    *
                  </span>
                </FieldLegend>
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {STAFF_WEEK.map((d) => {
                    const id = `day-${d}`;
                    return (
                      <div key={d} className="flex items-center gap-2">
                        <Checkbox
                          id={id}
                          checked={field.value.includes(d)}
                          onCheckedChange={(on) =>
                            field.onChange(
                              on ? [...field.value, d] : field.value.filter((x) => x !== d),
                            )
                          }
                        />
                        <Label htmlFor={id} className="font-normal">
                          {weekdayName(d, locale)}
                        </Label>
                      </div>
                    );
                  })}
                </div>
                {fieldState.invalid && <FieldError>{t('errors.days')}</FieldError>}
              </FieldSet>
            )}
          />
          <Controller
            control={form.control}
            name="preferredPeriods"
            render={({ field, fieldState }) => (
              <FieldSet data-invalid={fieldState.invalid}>
                <FieldLegend variant="label">
                  {t('fields.periods')}
                  <span className="text-destructive" aria-hidden>
                    *
                  </span>
                </FieldLegend>
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {PREFERRED_PERIODS.map((p) => {
                    const id = `period-${p}`;
                    return (
                      <div key={p} className="flex items-center gap-2">
                        <Checkbox
                          id={id}
                          checked={field.value.includes(p)}
                          onCheckedChange={(on) =>
                            field.onChange(
                              on ? [...field.value, p] : field.value.filter((x) => x !== p),
                            )
                          }
                        />
                        <Label htmlFor={id} className="font-normal">
                          {PREFERRED_PERIOD_LABELS[p][locale]}
                        </Label>
                      </div>
                    );
                  })}
                </div>
                {fieldState.invalid && <FieldError>{t('errors.periods')}</FieldError>}
              </FieldSet>
            )}
          />
          <TextField
            control={form.control}
            name="preferredNote"
            label={t('fields.timesNote')}
            description={t('fields.timesNoteHelp')}
          />
        </FieldGroup>
      </FieldSet>

      <FieldSeparator />
      <FieldSet>
        <FieldLegend>{t('sections.more')}</FieldLegend>
        <FieldGroup>
          <Controller
            control={form.control}
            name="teacherGenderPref"
            render={({ field }) => (
              <FieldSet>
                <FieldLegend variant="label">{t('fields.teacherGender')}</FieldLegend>
                <RadioGroup
                  dir={dir}
                  value={field.value}
                  onValueChange={field.onChange}
                  className="flex flex-wrap gap-5"
                >
                  {TEACHER_GENDER_PREFS.map((g) => (
                    <div key={g} className="flex items-center gap-2">
                      <RadioGroupItem value={g} id={`teacher-${g}`} />
                      <Label htmlFor={`teacher-${g}`} className="font-normal">
                        {TEACHER_GENDER_PREF_LABELS[g][locale]}
                      </Label>
                    </div>
                  ))}
                </RadioGroup>
              </FieldSet>
            )}
          />
          <SelectField
            control={form.control}
            name="heardFrom"
            label={t('fields.heardFrom')}
            clearable
            options={HEARD_FROM.map((h) => ({ value: h, label: HEARD_FROM_LABELS[h][locale] }))}
          />
          <TextareaField control={form.control} name="message" label={t('fields.notes')} />
        </FieldGroup>
      </FieldSet>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-2">
        <Button type="submit" size="lg" className="sm:self-start" disabled={send.isPending}>
          {send.isPending && <Spinner />}
          {t('submit')}
        </Button>
        <p className="text-sm text-muted-foreground">{t('privacy')}</p>
      </div>
    </form>
  );
}
