'use client';

import {
  COURSE_CATEGORIES,
  createFamilySchema,
  createStaffSchema,
  createStudentSchema,
  createTeacherSchema,
  FAMILY_CREATE_STATUSES,
  FAMILY_STATUS_LABELS,
  GENDERS,
  GENDER_LABELS,
  STUDENT_LANGUAGES,
  STUDENT_LANGUAGE_LABELS,
  updateFamilySchema,
  updateStaffSchema,
  updateStudentSchema,
  updateTeacherSchema,
  type FamilyDetailDto,
  type PeopleLookups,
  type StaffDto,
  type StudentDetailDto,
  type TeacherDetailDto,
} from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@qarabic/ui/components/alert-dialog';
import { Button } from '@qarabic/ui/components/button';
import { FieldGroup, FieldLegend, FieldSet } from '@qarabic/ui/components/field';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@qarabic/ui/components/sheet';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Spinner } from '@qarabic/ui/components/spinner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon, InfoIcon, XIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, type ReactNode } from 'react';
import {
  useForm,
  useWatch,
  type Control,
  type FieldValues,
  type UseFormReturn,
} from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import {
  ComboboxField,
  DateField,
  MultiComboboxField,
  NumberField,
  SelectField,
  TextareaField,
  TextField,
  type Option,
} from '@/components/forms/fields';
import {
  CountryField,
  FamilyField,
  PhoneField,
  TimeZoneField,
} from '@/components/forms/people-fields';
import { useCurrentUser } from '@/components/shell/app-shell';
import { createPerson, fetchLookups, updatePerson, type PeopleKind } from '@/lib/api/people';
import { applyServerErrors } from '@/lib/forms/server-errors';
import { useBeforeUnload } from '@/lib/forms/use-unsaved-guard';
import { useSchemaResolver } from '@/lib/forms/validation-messages';
import { KINDS } from '@/lib/people/kinds';
import { peopleKeys, useRefusalMessage } from '@/lib/people/use-person-actions';
import { useDirection } from '@/lib/use-direction';
import { browserTimeZone } from '@/lib/time';

/**
 * Add / edit sheet (docs/28 §2): a shadcn `Sheet` from the inline-end side (left in Arabic, as in
 * the current app's drawer), 520 px on desktop and full screen on phones; sectioned forms with the
 * shared zod schemas; server 422 errors mapped to the fields and the first one focused; save shows
 * progress; closing with unsaved changes asks first.
 */

export type SheetTarget =
  | { kind: 'families'; record?: FamilyDetailDto }
  | { kind: 'students'; record?: StudentDetailDto; familyId?: number }
  | { kind: 'teachers'; record?: TeacherDetailDto }
  | { kind: 'staff'; record?: StaffDto };

const KIND_KEY = {
  families: 'family',
  students: 'student',
  teachers: 'teacher',
  staff: 'staff',
} as const;

export function useLookups(enabled = true) {
  return useQuery({
    queryKey: peopleKeys.lookups,
    queryFn: ({ signal }) => fetchLookups(signal),
    staleTime: 5 * 60_000,
    enabled,
  });
}

export function PersonSheet({
  target,
  open,
  onOpenChange,
  section,
}: {
  target: SheetTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Scroll to this section when opened from a section's «تعديل». */
  section?: string;
}) {
  const t = useTranslations('people.form');
  const dir = useDirection();
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const formId = useId();
  const [pending, setPending] = useState(false);
  useBeforeUnload(open && dirty);

  const mode = target.record ? 'edit' : 'new';
  const key = KIND_KEY[target.kind];

  function requestClose(next: boolean) {
    if (next) return onOpenChange(true);
    if (dirty) return setConfirmClose(true);
    onOpenChange(false);
  }

  useEffect(() => {
    if (!open || !section) return;
    const timer = setTimeout(() => {
      const el = document.getElementById(`section-${section}`);
      el?.scrollIntoView({ block: 'start' });
      el?.querySelector<HTMLElement>('input,button[role="combobox"],textarea')?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [open, section]);

  const bodyProps = {
    formId,
    onDirty: setDirty,
    onPending: setPending,
    onDone: () => {
      setDirty(false);
      onOpenChange(false);
    },
  };

  return (
    <>
      <Sheet open={open} onOpenChange={requestClose}>
        <SheetContent
          side={dir === 'rtl' ? 'left' : 'right'}
          showCloseButton={false}
          className="w-full! gap-0 p-0 sm:max-w-[520px]!"
        >
          <SheetHeader className="flex-row items-start justify-between gap-2 border-b">
            <div className="flex flex-col gap-0.5">
              <SheetTitle className="text-lg font-bold">{t(`titles.${mode}.${key}`)}</SheetTitle>
              <SheetDescription>{t(`descriptions.${mode}`)}</SheetDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('close')}
              onClick={() => requestClose(false)}
            >
              <XIcon />
            </Button>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-4 py-5">
            {open && target.kind === 'families' && (
              <FamilyForm record={target.record} {...bodyProps} />
            )}
            {open && target.kind === 'students' && (
              <StudentForm record={target.record} familyId={target.familyId} {...bodyProps} />
            )}
            {open && target.kind === 'teachers' && (
              <TeacherForm record={target.record} {...bodyProps} />
            )}
            {open && target.kind === 'staff' && <StaffForm record={target.record} {...bodyProps} />}
          </div>
          <SheetFooter className="flex-row justify-start gap-2 border-t">
            <Button type="submit" form={formId} disabled={pending} className="h-10 px-5">
              {pending && <Spinner />}
              {pending ? t('saving') : mode === 'new' ? t('create') : t('save')}
            </Button>
            <SheetClose asChild>
              <Button
                type="button"
                variant="outline"
                className="h-10"
                onClick={(e) => {
                  e.preventDefault();
                  requestClose(false);
                }}
              >
                {t('cancel')}
              </Button>
            </SheetClose>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('discardTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('discardBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('keepEditing')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setDirty(false);
                setConfirmClose(false);
                onOpenChange(false);
              }}
            >
              {t('discard')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ------------------------------------------------------------------ shared form plumbing

type BodyProps = {
  formId: string;
  onDirty: (dirty: boolean) => void;
  onPending: (pending: boolean) => void;
  onDone: () => void;
};

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <FieldSet id={`section-${id}`} className="scroll-mt-4">
      <FieldLegend className="text-base font-bold">{title}</FieldLegend>
      <FieldGroup className="gap-4">{children}</FieldGroup>
    </FieldSet>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
}

/** Only the fields the user changed go in a PATCH (an untouched field keeps its server value). */
function dirtyOnly<T extends Record<string, unknown>>(
  values: T,
  dirty: Partial<Record<keyof T, unknown>>,
) {
  return Object.fromEntries(
    Object.entries(values).filter(([k]) => dirty[k as keyof T]),
  ) as Partial<T>;
}

function useSaveMutation<K extends PeopleKind>(kind: K, id: number | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      id ? updatePerson(kind, id, body as never) : createPerson(kind, body as never),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: peopleKeys.all }),
  });
}

/** Wires a form to the save mutation: dirty tracking, 422 → fields, refusals, toasts. */
function useFormBody<T extends FieldValues>({
  form,
  kind,
  id,
  fields,
  props,
}: {
  form: UseFormReturn<T, unknown, Record<string, unknown>>;
  kind: PeopleKind;
  id?: number;
  fields: readonly string[];
  props: BodyProps;
}) {
  const t = useTranslations('people.form');
  const tv = useTranslations('validation');
  const router = useRouter();
  const refusal = useRefusalMessage();
  const save = useSaveMutation(kind, id);
  const [banner, setBanner] = useState<string | null>(null);
  // Read during render so react-hook-form tracks them (formState is a subscription proxy).
  const isDirty = form.formState.isDirty;
  const dirtyFields = form.formState.dirtyFields;
  const { onDirty, onPending } = props;
  useEffect(() => onDirty(isDirty), [isDirty, onDirty]);
  useEffect(() => onPending(save.isPending), [save.isPending, onPending]);

  const onSubmit = form.handleSubmit(
    (values) => {
      setBanner(null);
      const body = id ? dirtyOnly(values, dirtyFields as never) : values;
      if (id && Object.keys(body).length === 0) return props.onDone();
      save.mutate(body, {
        onSuccess: (saved) => {
          props.onDone();
          toast.success(id ? t('saved') : t('created'));
          if (!id) router.push(`${KINDS[kind].href}/${(saved as { id: number }).id}`);
        },
        onError: (error) => {
          const mapped = applyServerErrors(form, error, (k) => tv(k), fields);
          setBanner(mapped ? t('fixErrors') : refusal(error));
        },
      });
    },
    () => setBanner(t('fixErrors')),
  );

  return { onSubmit, banner };
}

function FormShell({
  formId,
  onSubmit,
  banner,
  note,
  children,
}: {
  formId: string;
  onSubmit: () => void;
  banner: string | null;
  note?: string;
  children: ReactNode;
}) {
  return (
    <form id={formId} noValidate onSubmit={onSubmit} className="flex flex-col gap-7">
      {banner && (
        <Alert variant="destructive" role="alert">
          <AlertCircleIcon />
          <AlertDescription>{banner}</AlertDescription>
        </Alert>
      )}
      {note && (
        <Alert>
          <InfoIcon />
          <AlertDescription>{note}</AlertDescription>
        </Alert>
      )}
      {children}
    </form>
  );
}

function useUiLocale(): 'ar' | 'en' {
  return useLocale() === 'en' ? 'en' : 'ar';
}

function labelled<T extends string>(
  values: readonly T[],
  labels: Record<T, { ar: string; en: string }>,
  locale: 'ar' | 'en',
): Option[] {
  return values.map((v) => ({ value: v, label: labels[v][locale] }));
}

function courseOptions(
  lookups: PeopleLookups | undefined,
  locale: 'ar' | 'en',
  category?: (typeof COURSE_CATEGORIES)[number],
): Option[] {
  return (lookups?.courses ?? [])
    .filter((c) => c.isActive && (!category || c.category === category))
    .map((c) => ({
      value: String(c.id),
      label: locale === 'ar' ? c.nameAr : c.nameEn,
      keywords: [c.nameAr, c.nameEn],
    }));
}

function LookupsSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}

/**
 * The form's resolver: the shared schema, and on an edit of a record with no phone (a family
 * converted from a lead without one) an untouched blank phone counts as not given — the update
 * schemas allow it missing — so it cannot block every other change.
 */
function usePersonResolver(schema: z.ZodType, record?: { phone?: string | null }) {
  return useSchemaResolver(schema as z.ZodType<Record<string, unknown>, FieldValues>, {
    blankAsMissing: record && !record.phone ? ['phone'] : [],
  });
}

// ------------------------------------------------------------------ family

const FAMILY_FIELDS = [
  'parentName',
  'email',
  'phone',
  'countryCode',
  'timezone',
  'managerId',
  'startDate',
  'trialDate',
  'zoomId',
  'whatsappGroupId',
  'comment',
  'status',
] as const;

function FamilyForm({ record, ...props }: BodyProps & { record?: FamilyDetailDto }) {
  const t = useTranslations('people');
  const locale = useUiLocale();
  const lookups = useLookups();
  const schema = record ? updateFamilySchema : createFamilySchema;
  const resolver = usePersonResolver(schema, record);
  const form = useForm<FieldValues, unknown, Record<string, unknown>>({
    resolver,
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: {
      parentName: record?.parentName ?? '',
      email: record?.email ?? '',
      phone: record?.phone ?? '',
      countryCode: record?.countryCode ?? null,
      timezone: record?.timezone ?? '',
      managerId: record?.manager?.id ?? null,
      startDate: record?.startDate ?? null,
      trialDate: record?.trialDate ?? null,
      zoomId: record?.zoomId ?? '',
      whatsappGroupId: record?.whatsappGroupId ?? '',
      comment: record?.comment ?? '',
      ...(record ? {} : { status: 'regular' }),
    },
  });
  const { onSubmit, banner } = useFormBody({
    form,
    kind: 'families',
    id: record?.id,
    fields: FAMILY_FIELDS,
    props,
  });
  const country = useWatch({ control: form.control, name: 'countryCode' }) as string | null;
  const c = form.control as Control<FieldValues>;
  if (lookups.isPending) return <LookupsSkeleton />;
  return (
    <FormShell
      formId={props.formId}
      onSubmit={onSubmit}
      banner={banner}
      note={record ? undefined : t('form.passwordNote')}
    >
      <Section id="contact" title={t('sections.contact')}>
        <TextField
          control={c}
          name="parentName"
          label={t('fields.parentName')}
          required
          inputProps={{ autoComplete: 'off' }}
        />
        <TextField
          control={c}
          name="email"
          label={t('fields.email')}
          required
          inputProps={{ type: 'email', dir: 'ltr', autoComplete: 'off' }}
        />
        <PhoneField
          control={c}
          name="phone"
          label={t('fields.phone')}
          required
          defaultCountry={country}
        />
      </Section>
      <Section id="location" title={t('sections.location')}>
        <Row>
          <CountryField control={c} name="countryCode" label={t('fields.country')} />
          <TimeZoneField control={c} name="timezone" label={t('fields.timezone')} required />
        </Row>
      </Section>
      <Section id="account" title={t('sections.account')}>
        <Row>
          <ComboboxField
            control={c}
            name="managerId"
            label={t('fields.manager')}
            numeric
            clearable
            options={(lookups.data?.managers ?? []).map((m) => ({
              value: String(m.id),
              label: m.name,
            }))}
          />
          {!record && (
            <SelectField
              control={c}
              name="status"
              label={t('fields.initialStatus')}
              options={FAMILY_CREATE_STATUSES.map((s) => ({
                value: s,
                label: FAMILY_STATUS_LABELS[s][locale],
              }))}
            />
          )}
        </Row>
      </Section>
      <Section id="dates" title={t('sections.dates')}>
        <Row>
          <DateField control={c} name="startDate" label={t('fields.startDate')} />
          <DateField control={c} name="trialDate" label={t('fields.trialDate')} />
        </Row>
      </Section>
      <Section id="online" title={t('sections.online')}>
        <Row>
          <TextField
            control={c}
            name="zoomId"
            label={t('fields.zoomId')}
            inputProps={{ dir: 'ltr' }}
          />
          <TextField
            control={c}
            name="whatsappGroupId"
            label={t('fields.whatsappGroupId')}
            inputProps={{ dir: 'ltr' }}
          />
        </Row>
      </Section>
      <Section id="notes" title={t('sections.notes')}>
        <TextareaField control={c} name="comment" label={t('fields.comment')} />
      </Section>
    </FormShell>
  );
}

// ------------------------------------------------------------------ student

const STUDENT_FIELDS = [
  'familyId',
  'name',
  'email',
  'gender',
  'age',
  'language',
  'regularCourseId',
  'additionalCourseId',
  'teacherId',
  'startDate',
  'zoomId',
  'remarkParent',
  'remarkTeacher',
] as const;

function StudentForm({
  record,
  familyId,
  ...props
}: BodyProps & { record?: StudentDetailDto; familyId?: number }) {
  const t = useTranslations('people');
  const locale = useUiLocale();
  const lookups = useLookups();
  const schema = record ? updateStudentSchema : createStudentSchema;
  const resolver = useSchemaResolver(schema as z.ZodType<Record<string, unknown>, FieldValues>);
  const form = useForm<FieldValues, unknown, Record<string, unknown>>({
    resolver,
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: {
      familyId: record?.familyId ?? familyId ?? null,
      name: record?.name ?? '',
      email: record?.email ?? '',
      gender: record?.gender ?? null,
      age: record?.age ?? null,
      language: record?.language ?? null,
      regularCourseId: record?.regularCourse?.id ?? null,
      additionalCourseId: record?.additionalCourse?.id ?? null,
      teacherId: record?.teacher?.id ?? null,
      startDate: record?.startDate ?? null,
      zoomId: record?.zoomId ?? '',
      remarkParent: record?.remarkParent ?? '',
      remarkTeacher: record?.remarkTeacher ?? '',
    },
  });
  const { onSubmit, banner } = useFormBody({
    form,
    kind: 'students',
    id: record?.id,
    fields: STUDENT_FIELDS,
    props,
  });
  const c = form.control as Control<FieldValues>;
  if (lookups.isPending) return <LookupsSkeleton />;
  return (
    <FormShell formId={props.formId} onSubmit={onSubmit} banner={banner}>
      <Section id="profile" title={t('sections.student')}>
        <FamilyField control={c} name="familyId" label={t('fields.family')} required />
        <TextField
          control={c}
          name="name"
          label={t('fields.name')}
          required
          inputProps={{ autoComplete: 'off' }}
        />
        <Row>
          <SelectField
            control={c}
            name="gender"
            label={t('fields.gender')}
            clearable
            options={labelled(GENDERS, GENDER_LABELS, locale)}
          />
          <NumberField control={c} name="age" label={t('fields.age')} min={3} max={99} />
        </Row>
        <Row>
          <SelectField
            control={c}
            name="language"
            label={t('fields.language')}
            clearable
            options={labelled(STUDENT_LANGUAGES, STUDENT_LANGUAGE_LABELS, locale)}
          />
          <TextField
            control={c}
            name="email"
            label={t('fields.email')}
            inputProps={{ type: 'email', dir: 'ltr', autoComplete: 'off' }}
          />
        </Row>
      </Section>
      <Section id="study" title={t('sections.study')}>
        <Row>
          <ComboboxField
            control={c}
            name="regularCourseId"
            label={t('fields.course')}
            numeric
            clearable
            options={courseOptions(lookups.data, locale, 'regular')}
          />
          <ComboboxField
            control={c}
            name="additionalCourseId"
            label={t('fields.additionalCourse')}
            numeric
            clearable
            options={courseOptions(lookups.data, locale, 'additional')}
          />
        </Row>
        <Row>
          <ComboboxField
            control={c}
            name="teacherId"
            label={t('fields.teacher')}
            numeric
            clearable
            options={(lookups.data?.teachers ?? []).map((m) => ({
              value: String(m.id),
              label: m.name,
            }))}
          />
          <DateField control={c} name="startDate" label={t('fields.startDate')} />
        </Row>
        <TextField
          control={c}
          name="zoomId"
          label={t('fields.zoomId')}
          inputProps={{ dir: 'ltr' }}
        />
      </Section>
      <Section id="remarks" title={t('sections.remarks')}>
        <TextareaField control={c} name="remarkParent" label={t('fields.remarkParent')} />
        <TextareaField control={c} name="remarkTeacher" label={t('fields.remarkTeacher')} />
      </Section>
    </FormShell>
  );
}

// ------------------------------------------------------------------ teacher

const TEACHER_FIELDS = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'altPhone',
  'gender',
  'nationality',
  'countryCode',
  'timezone',
  'age',
  'hourlyRate',
  'courseIds',
  'qualification',
  'experience',
  'address',
  'skypeId',
  'description',
] as const;

function TeacherForm({ record, ...props }: BodyProps & { record?: TeacherDetailDto }) {
  const t = useTranslations('people');
  const locale = useUiLocale();
  const lookups = useLookups();
  const schema = record ? updateTeacherSchema : createTeacherSchema;
  const resolver = usePersonResolver(schema, record);
  const form = useForm<FieldValues, unknown, Record<string, unknown>>({
    resolver,
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: {
      firstName: record?.firstName ?? '',
      lastName: record?.lastName ?? '',
      email: record?.email ?? '',
      phone: record?.phone ?? '',
      altPhone: record?.altPhone ?? null,
      gender: record?.gender ?? null,
      nationality: record?.nationality ?? '',
      countryCode: record?.countryCode ?? null,
      timezone: record?.timezone ?? 'Africa/Cairo',
      age: record?.age ?? null,
      hourlyRate: record?.hourlyRate ?? '',
      courseIds: record?.courses.map((x) => x.id) ?? [],
      qualification: record?.qualification ?? '',
      experience: record?.experience ?? '',
      address: record?.address ?? '',
      skypeId: record?.skypeId ?? '',
      description: record?.description ?? '',
    },
  });
  const { onSubmit, banner } = useFormBody({
    form,
    kind: 'teachers',
    id: record?.id,
    fields: TEACHER_FIELDS,
    props,
  });
  const country = useWatch({ control: form.control, name: 'countryCode' }) as string | null;
  const c = form.control as Control<FieldValues>;
  if (lookups.isPending) return <LookupsSkeleton />;
  const currency = record?.hourlyRateCurrency ?? lookups.data?.defaultPayCurrency ?? 'EGP';
  return (
    <FormShell
      formId={props.formId}
      onSubmit={onSubmit}
      banner={banner}
      note={record ? undefined : t('form.passwordNote')}
    >
      <Section id="contact" title={t('sections.contact')}>
        <Row>
          <TextField control={c} name="firstName" label={t('fields.firstName')} required />
          <TextField control={c} name="lastName" label={t('fields.lastName')} />
        </Row>
        <TextField
          control={c}
          name="email"
          label={t('fields.email')}
          required
          inputProps={{ type: 'email', dir: 'ltr', autoComplete: 'off' }}
        />
        <PhoneField
          control={c}
          name="phone"
          label={t('fields.phone')}
          required
          defaultCountry={country ?? 'EG'}
        />
        <PhoneField
          control={c}
          name="altPhone"
          label={t('fields.altPhone')}
          defaultCountry={country ?? 'EG'}
        />
      </Section>
      <Section id="location" title={t('sections.location')}>
        <Row>
          <CountryField control={c} name="countryCode" label={t('fields.country')} />
          <TimeZoneField control={c} name="timezone" label={t('fields.timezone')} required />
        </Row>
      </Section>
      <Section id="personal" title={t('sections.personal')}>
        <Row>
          <SelectField
            control={c}
            name="gender"
            label={t('fields.gender')}
            clearable
            options={labelled(GENDERS, GENDER_LABELS, locale)}
          />
          <NumberField control={c} name="age" label={t('fields.age')} min={18} max={90} />
        </Row>
        <TextField control={c} name="nationality" label={t('fields.nationality')} />
      </Section>
      <Section id="work" title={t('sections.work')}>
        <TextField
          control={c}
          name="hourlyRate"
          label={t('fields.hourlyRate')}
          description={t('form.rateHelp', { currency })}
          inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
        />
        <MultiComboboxField
          control={c}
          name="courseIds"
          label={t('fields.courses')}
          options={courseOptions(lookups.data, locale)}
        />
      </Section>
      <Section id="background" title={t('sections.background')}>
        <TextareaField control={c} name="qualification" label={t('fields.qualification')} />
        <TextareaField control={c} name="experience" label={t('fields.experience')} />
        <TextareaField control={c} name="description" label={t('fields.description')} />
        <Row>
          <TextField control={c} name="address" label={t('fields.address')} />
          <TextField
            control={c}
            name="skypeId"
            label={t('fields.skypeId')}
            inputProps={{ dir: 'ltr' }}
          />
        </Row>
      </Section>
    </FormShell>
  );
}

// ------------------------------------------------------------------ staff

const STAFF_FIELDS = ['name', 'email', 'phone', 'role', 'timezone'] as const;

function StaffForm({ record, ...props }: BodyProps & { record?: StaffDto }) {
  const t = useTranslations('people');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const lookups = useLookups();
  const schema = record ? updateStaffSchema : createStaffSchema;
  const resolver = usePersonResolver(schema, record);
  const form = useForm<FieldValues, unknown, Record<string, unknown>>({
    resolver,
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: {
      name: record?.name ?? '',
      email: record?.email ?? '',
      phone: record?.phone ?? '',
      role: record?.role.name ?? '',
      timezone: record?.timezone ?? browserTimeZone(),
    },
  });
  const { onSubmit, banner } = useFormBody({
    form,
    kind: 'staff',
    id: record?.id,
    fields: STAFF_FIELDS,
    props,
  });
  const c = form.control as Control<FieldValues>;
  if (lookups.isPending) return <LookupsSkeleton />;
  const ownRecord = record?.id === me.id;
  const roles = lookups.data?.staffRoles ?? [];
  const roleOptions = roles.map((r) => ({
    value: r.name,
    label: locale === 'ar' ? r.labelAr : (r.labelEn ?? r.labelAr),
  }));
  if (record && !roleOptions.some((o) => o.value === record.role.name)) {
    roleOptions.unshift({
      value: record.role.name,
      label: locale === 'ar' ? record.role.labelAr : (record.role.labelEn ?? record.role.labelAr),
    });
  }
  return (
    <FormShell
      formId={props.formId}
      onSubmit={onSubmit}
      banner={banner}
      note={record ? undefined : t('form.passwordNote')}
    >
      <Section id="contact" title={t('sections.contact')}>
        <TextField control={c} name="name" label={t('fields.name')} required />
        <TextField
          control={c}
          name="email"
          label={t('fields.email')}
          required
          inputProps={{ type: 'email', dir: 'ltr', autoComplete: 'off' }}
        />
        <PhoneField
          control={c}
          name="phone"
          label={t('fields.phone')}
          required
          defaultCountry="EG"
        />
      </Section>
      <Section id="account" title={t('sections.account')}>
        {ownRecord ? (
          <Alert>
            <InfoIcon />
            <AlertDescription>{t('form.ownRole')}</AlertDescription>
          </Alert>
        ) : (
          <SelectField
            control={c}
            name="role"
            label={t('fields.role')}
            required
            options={roleOptions}
          />
        )}
        <TimeZoneField control={c} name="timezone" label={t('fields.timezone')} />
      </Section>
    </FormShell>
  );
}
