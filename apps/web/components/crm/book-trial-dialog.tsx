'use client';

import {
  createLeadAccountSchema,
  type ConflictResultDto,
  type CreateLeadAccountInput,
  type LeadDetailDto,
  type TrialTeacherOptionDto,
  type TrialTeachersQuery,
} from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@qarabic/ui/components/dialog';
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
import { RadioGroup, RadioGroupItem } from '@qarabic/ui/components/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Spinner } from '@qarabic/ui/components/spinner';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { ComboboxField, NumberField, SelectField, TextField } from '@/components/forms/fields';
import { DatePicker, TimeSelect } from '@/components/forms/date-time';
import { PhoneField, TimeZoneField } from '@/components/forms/people-fields';
import { useLookups } from '@/components/people/person-sheet';
import { canSave, ConflictList } from '@/components/sessions/conflict-list';
import { useNow, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { isApiError } from '@/lib/api/client';
import {
  bookTrial,
  createLeadAccount,
  createTrialOffer,
  crmKeys,
  fetchTrialTeachers,
} from '@/lib/api/crm';
import { fetchPerson } from '@/lib/api/people';
import { checkSchedule } from '@/lib/api/schedule';
import { applyServerErrors } from '@/lib/forms/server-errors';
import { useSchemaResolver } from '@/lib/forms/validation-messages';
import { conflictsOf } from '@/lib/sessions/errors';
import { clock, dateKeyIn, isoWeekday, zonedInstant } from '@/lib/schedule-time';
import { cityOf, isValidTimeZone } from '@/lib/time';
import { useCrmError } from './crm-bits';
import { EMPTY_OFFER, offerProblem, TrialOfferFields, type OfferDraft } from './trial-offer-fields';
import {
  TRIAL_OVERRIDE_REASON_ID,
  TRIAL_TEACHERS_ID,
  TrialTeacherPicker,
} from './trial-teacher-picker';

const DURATIONS = [30, 45, 60] as const;

/**
 * «احجز حصة تجريبية» (docs/26 §9.4): step 1 only when the lead has no family yet — the trial
 * family, the parent login (no password sent) and the children; step 2 the trial: child, course,
 * date and time in the family's zone, then the teacher from the server's ranked list (T2: eligible
 * first, the others with reasons and an override with a reason), with the teacher's and the
 * viewer's time shown live and the N2 schedule check (hard conflicts block, warnings need a tick).
 * A rebooking moves the earlier trial out.
 */
export function BookTrialDialog({
  lead: initial,
  onClose,
  onSaved,
}: {
  lead: LeadDetailDto;
  onClose: () => void;
  onSaved: (lead: LeadDetailDto) => void;
}) {
  const t = useTranslations('crm.trial');
  const [lead, setLead] = useState(initial);
  const step = lead.family ? 'trial' : 'account';
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {step === 'account' ? t('stepAccount') : t('stepTrial')}
          </DialogDescription>
        </DialogHeader>
        <ol className="flex gap-2 text-sm" aria-label={t('steps')}>
          {(['account', 'trial'] as const).map((s, i) => (
            <li
              key={s}
              aria-current={s === step ? 'step' : undefined}
              className={
                s === step
                  ? 'rounded-md bg-accent px-2 py-1 font-semibold text-accent-foreground'
                  : 'px-2 py-1 text-muted-foreground'
              }
            >
              {i + 1}. {t(s === 'account' ? 'accountStep' : 'trialStep')}
            </li>
          ))}
        </ol>
        {step === 'account' ? (
          <AccountStep
            lead={lead}
            onDone={(next) => {
              setLead(next);
              onSaved(next);
            }}
          />
        ) : (
          <TrialStep
            lead={lead}
            onDone={(next) => {
              onSaved(next);
              onClose();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

type AccountValues = {
  parentName: string | null;
  email: string | null;
  phone: string | null;
  countryCode: string | null;
  timezone: string | null;
  children: {
    name: string;
    age: number | null;
    gender: 'male' | 'female' | null;
    courseId: number | null;
  }[];
};

function AccountStep({
  lead,
  onDone,
}: {
  lead: LeadDetailDto;
  onDone: (l: LeadDetailDto) => void;
}) {
  const t = useTranslations('crm.trial');
  const tf = useTranslations('crm.form');
  const tv = useTranslations('validation');
  const locale = useUiLocale();
  const message = useCrmError();
  const lookups = useLookups();
  const [error, setError] = useState<string | null>(null);
  const [existingFamily, setExistingFamily] = useState<number | null>(null);
  const resolver = useSchemaResolver(createLeadAccountSchema);
  const form = useForm<AccountValues>({
    resolver: resolver as never,
    mode: 'onTouched',
    defaultValues: {
      parentName: lead.parentName,
      email: lead.email,
      phone:
        lead.phone && /^\+[1-9]\d{6,14}$/.test(lead.phone.replace(/[\s\-().]/g, ''))
          ? lead.phone.replace(/[\s\-().]/g, '')
          : null,
      countryCode: lead.countryCode,
      timezone: lead.timezone,
      children: lead.children.length
        ? lead.children.map((c) => ({
            name: c.name ?? '',
            age: c.age ?? null,
            gender: c.gender ?? null,
            courseId: c.courseId ?? null,
          }))
        : [{ name: '', age: null, gender: null, courseId: null }],
    },
  });
  const children = useFieldArray({ control: form.control, name: 'children' });
  const create = useMutation({
    mutationFn: (body: CreateLeadAccountInput) => createLeadAccount(lead.id, body),
    onSuccess: (next) => {
      toast.success(t('accountCreated'));
      onDone(next);
    },
    onError: (e) => {
      if (isApiError(e) && e.code === 'email_taken') {
        const id = Number(e.error?.data?.familyId);
        if (id) setExistingFamily(id);
        setError(message(e));
        return;
      }
      if (
        !applyServerErrors(form, e, (k) => tv(k), [
          'parentName',
          'email',
          'phone',
          'timezone',
          'children',
        ])
      )
        setError(message(e));
    },
  });
  const courses = (lookups.data?.courses ?? []).map((c) => ({
    value: String(c.id),
    label: locale === 'ar' ? c.nameAr : c.nameEn,
  }));
  const submit = (familyId?: number) =>
    form.handleSubmit((v) => {
      setError(null);
      create.mutate({
        ...(v as unknown as CreateLeadAccountInput),
        ...(familyId ? { familyId } : {}),
      });
    });
  return (
    <form noValidate onSubmit={(e) => void submit()(e)} className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t('accountHelp')}</p>
      <FieldGroup>
        <TextField control={form.control} name="parentName" label={tf('parentName')} required />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            control={form.control}
            name="email"
            label={tf('email')}
            required
            inputProps={{ type: 'email', dir: 'ltr' }}
          />
          <PhoneField
            control={form.control}
            name="phone"
            label={tf('phone')}
            defaultCountry={lead.countryCode}
          />
        </div>
        <TimeZoneField control={form.control} name="timezone" label={tf('timezone')} required />
        <FieldSet>
          <FieldLegend variant="label">{tf('children')}</FieldLegend>
          {children.fields.map((f, i) => (
            <div
              key={f.id}
              className="grid items-end gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_5rem_7rem]"
            >
              <TextField
                control={form.control}
                name={`children.${i}.name`}
                label={tf('childName')}
                required
              />
              <NumberField
                control={form.control}
                name={`children.${i}.age`}
                label={tf('age')}
                min={2}
                max={99}
              />
              <SelectField
                control={form.control}
                name={`children.${i}.gender`}
                label={tf('gender')}
                clearable
                options={[
                  { value: 'male', label: tf('male') },
                  { value: 'female', label: tf('female') },
                ]}
              />
              <div className="flex items-end gap-2 sm:col-span-3">
                <ComboboxField
                  control={form.control}
                  name={`children.${i}.courseId`}
                  label={t('course')}
                  required
                  numeric
                  className="flex-1"
                  options={courses}
                />
                {children.fields.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={tf('removeChild', { n: i + 1 })}
                    onClick={() => children.remove(i)}
                  >
                    <Trash2Icon />
                  </Button>
                )}
              </div>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={() => children.append({ name: '', age: null, gender: null, courseId: null })}
          >
            <PlusIcon />
            {tf('addChild')}
          </Button>
        </FieldSet>
      </FieldGroup>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="flex flex-col gap-2">
            {error}
            {existingFamily && (
              <Button
                type="button"
                variant="outline"
                className="self-start"
                onClick={() => void submit(existingFamily)()}
              >
                {t('linkFamily')}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      {/* Sticky: on a phone the form runs several screens; «احجز الحصة» stays in reach. */}
      <DialogFooter className="sticky -bottom-4 z-10 bg-muted">
        <DialogClose asChild>
          <Button type="button" variant="outline">
            {t('cancel')}
          </Button>
        </DialogClose>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending && <Spinner />}
          {t('createAccount')}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The selected course's id kept as a string in the Select (form values are numbers). */
function TrialStep({ lead, onDone }: { lead: LeadDetailDto; onDone: (l: LeadDetailDto) => void }) {
  const t = useTranslations('crm.trial');
  const locale = useUiLocale();
  const viewerTz = useViewerTz();
  const message = useCrmError();
  const queryClient = useQueryClient();
  const lookups = useLookups();
  const familyTz = lead.family?.timezone ?? lead.timezone;
  const ids = {
    student: useId(),
    course: useId(),
    date: useId(),
    time: useId(),
    duration: useId(),
    url: useId(),
  };
  const firstStudent = lead.students[0];
  const [studentId, setStudentId] = useState(firstStudent ? String(firstStudent.id) : '');
  const student = lead.students.find((s) => String(s.id) === studentId);
  const [courseId, setCourseId] = useState(student?.courseId ? String(student.courseId) : '');
  const [teacherId, setTeacherId] = useState<string | null>(
    lead.trials[0] ? String(lead.trials[0].teacher.id) : null,
  );
  const [option, setOption] = useState<TrialTeacherOptionDto | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  // T3: choose the teacher now (mode A) or offer the trial to the teachers (mode B).
  const [mode, setMode] = useState<'direct' | 'offer'>('direct');
  const [offer, setOffer] = useState<OfferDraft>(EMPTY_OFFER);
  const [teacherRefusal, setTeacherRefusal] = useState('');
  const [date, setDate] = useState(dateKeyIn(familyTz));
  const [time, setTime] = useState('');
  const [duration, setDuration] = useState('30');
  const [meetingUrl, setMeetingUrl] = useState('');
  const [ack, setAck] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const [server, setServer] = useState<{ key: string; result: ConflictResultDto } | null>(null);
  const now = useNow(30_000);

  const teacher = useQuery({
    queryKey: ['crm', 'teacher', teacherId],
    queryFn: ({ signal }) => fetchPerson('teachers', Number(teacherId), signal),
    enabled: !!teacherId,
  });
  const teacherTz = option?.teacher.timezone ?? teacher.data?.timezone;
  // T2: the ranked teachers for this child, course and time (docs/33 §4.2).
  const teachersQuery: TrialTeachersQuery | null =
    studentId && courseId && date && time
      ? {
          studentId: Number(studentId),
          courseId: Number(courseId),
          localDate: date,
          localTime: time,
          timezone: familyTz,
          durationMinutes: Number(duration),
        }
      : null;
  const ready = !!studentId && !!teacherId && !!date && !!time;
  const checkInput = ready
    ? {
        studentId: Number(studentId),
        teacherId: Number(teacherId),
        weekday: isoWeekday(date),
        localStartTime: time,
        durationMinutes: Number(duration),
        timezone: familyTz,
        validFrom: date,
      }
    : null;
  const check = useQuery({
    queryKey: ['crm', 'trial-check', checkInput],
    queryFn: ({ signal }) => checkSchedule(checkInput!, signal),
    enabled: !!checkInput,
    placeholderData: keepPreviousData,
  });
  const inputKey = JSON.stringify(checkInput);
  const serverConflicts = server?.key === inputKey ? server.result : null;
  const result = serverConflicts ?? (checkInput ? check.data : null);
  const at = date && time ? zonedInstant(date, time, familyTz) : null;
  const past = !!at && Date.parse(at) < now.getTime();

  const book = useMutation({
    mutationFn: () =>
      bookTrial(lead.id, {
        studentId: Number(studentId),
        courseId: Number(courseId),
        teacherId: Number(teacherId),
        localDate: date,
        localTime: time,
        timezone: familyTz,
        durationMinutes: Number(duration),
        meetingUrl: meetingUrl.trim() || null,
        acknowledgeWarnings: ack,
        // Only for a teacher the server lists as not eligible (T2 override).
        overrideReason: option && !option.eligible ? overrideReason.trim() : null,
      }),
    onSuccess: ({ lead: next }) => {
      toast.success(t('booked'));
      void queryClient.invalidateQueries({ queryKey: ['crm', 'leads'] });
      onDone(next);
    },
    onError: (e) => {
      const c = conflictsOf(e);
      if (c) setServer({ key: inputKey, result: c });
      if (isApiError(e) && e.code === 'teacher_not_eligible') {
        // The list was out of date: reload it (the teacher now shows why, with the reason field).
        setTeacherRefusal(t('notEligible'));
        void queryClient.invalidateQueries({ queryKey: ['crm', 'trial-teachers', lead.id] });
      }
    },
  });
  const errors = {
    student: !studentId ? t('studentRequired') : '',
    course: !courseId ? t('courseRequired') : '',
    teacher: !teacherId
      ? t('teacherRequired')
      : option?.reasons.includes('busy')
        ? t('teacherBusy')
        : teacherRefusal,
    override:
      option && !option.eligible && overrideReason.trim().length < 3
        ? t('teachers.reasonRequired')
        : '',
    date: !date ? t('dateRequired') : '',
    time: !time ? t('timeRequired') : past ? t('pastTime') : '',
    url: meetingUrl.trim() && !/^https:\/\/\S+\.\S+/.test(meetingUrl.trim()) ? t('urlInvalid') : '',
  };
  const blocked = !!result && !canSave(result, ack);
  const offerList = useQuery({
    queryKey: crmKeys.trialTeachers(lead.id, teachersQuery),
    queryFn: ({ signal }) => fetchTrialTeachers(lead.id, teachersQuery!, signal),
    enabled: mode === 'offer' && !!teachersQuery,
  });
  const send = useMutation({
    mutationFn: () =>
      createTrialOffer(lead.id, {
        studentId: Number(studentId),
        courseId: Number(courseId),
        localDate: date,
        localTime: time,
        timezone: familyTz,
        durationMinutes: Number(duration),
        policy: offer.policy,
        audience: offer.audience,
        ...(offer.audience === 'shortlist' ? { teacherIds: offer.teacherIds } : {}),
        meetingUrl: meetingUrl.trim() || null,
        note: offer.note.trim() || null,
      }),
    onSuccess: (o) => {
      toast.success(t('offer.sent', { count: o.teachers.length }));
      void queryClient.invalidateQueries({ queryKey: crmKeys.trialOffers(lead.id) });
      onDone(lead);
    },
  });
  const submitOffer = () => {
    setTouched(true);
    const fieldErrors = [errors.student, errors.course, errors.date, errors.time, errors.url];
    if (fieldErrors.some(Boolean)) return;
    const count = offerList.data ? offerList.data.data.eligible.length : null;
    if (offerProblem(offer, count)) return;
    send.mutate();
  };
  const submit = () => {
    if (mode === 'offer') {
      submitOffer();
      return;
    }
    setTouched(true);
    // The teacher step is the usual miss: take the user there (first radio, or the reason field)
    // once the fields above it are fine.
    const above = errors.student || errors.course || errors.date || errors.time;
    if (!above && errors.teacher) {
      document
        .querySelector<HTMLElement>(`#${TRIAL_TEACHERS_ID} [role="radio"]:not([disabled])`)
        ?.focus();
      return;
    }
    if (!above && errors.override) {
      document.getElementById(TRIAL_OVERRIDE_REASON_ID)?.focus();
      return;
    }
    if (Object.values(errors).some(Boolean)) return;
    if (blocked) return;
    book.mutate();
  };
  const courses = (lookups.data?.courses ?? []).filter((c) => c.isActive);
  const invalid = (k: keyof typeof errors) => touched && !!errors[k];

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {lead.trials.some((x) => x.stage === 'scheduled') && (
        <Alert>
          <AlertDescription>{t('rebookHint')}</AlertDescription>
        </Alert>
      )}
      <FieldGroup>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={invalid('student')}>
            <FieldLabel htmlFor={ids.student}>{t('student')}</FieldLabel>
            <Select
              value={studentId}
              onValueChange={(v) => {
                setStudentId(v);
                const s = lead.students.find((x) => String(x.id) === v);
                if (s?.courseId) setCourseId(String(s.courseId));
              }}
            >
              <SelectTrigger
                id={ids.student}
                className="h-10! w-full"
                aria-invalid={invalid('student')}
              >
                <SelectValue placeholder={t('choose')} />
              </SelectTrigger>
              <SelectContent position="popper">
                {lead.students.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {invalid('student') && <FieldError>{errors.student}</FieldError>}
          </Field>
          <Field data-invalid={invalid('course')}>
            <FieldLabel htmlFor={ids.course}>{t('course')}</FieldLabel>
            <Select value={courseId} onValueChange={setCourseId}>
              <SelectTrigger
                id={ids.course}
                className="h-10! w-full"
                aria-invalid={invalid('course')}
              >
                <SelectValue placeholder={t('choose')} />
              </SelectTrigger>
              <SelectContent position="popper">
                {courses.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {locale === 'ar' ? c.nameAr : c.nameEn}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {invalid('course') && <FieldError>{errors.course}</FieldError>}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-[1fr_9rem_8rem]">
          <Field data-invalid={invalid('date')}>
            <FieldLabel htmlFor={ids.date}>{t('date')}</FieldLabel>
            <DatePicker
              id={ids.date}
              value={date}
              onChange={setDate}
              min={dateKeyIn(familyTz)}
              invalid={invalid('date')}
            />
          </Field>
          <Field data-invalid={invalid('time')}>
            <FieldLabel htmlFor={ids.time}>{t('time')}</FieldLabel>
            <TimeSelect id={ids.time} value={time} onChange={setTime} invalid={invalid('time')} />
          </Field>
          <Field>
            <FieldLabel htmlFor={ids.duration}>{t('duration')}</FieldLabel>
            <Select value={duration} onValueChange={setDuration}>
              <SelectTrigger id={ids.duration} className="h-10! w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {DURATIONS.map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {t('minutes', { count: d })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <FieldDescription>
          {t('timeHelp', { city: cityOf(familyTz, locale) })}
          {invalid('time') && (
            <span className="block font-medium text-destructive" role="alert">
              {errors.time}
            </span>
          )}
        </FieldDescription>
        {at && (
          <div
            className="flex flex-col gap-0.5 rounded-lg border bg-subtle p-3 text-sm"
            aria-live="polite"
          >
            {teacherTz && isValidTimeZone(teacherTz) && (
              <span>
                {t('teacherTime', {
                  time: clock(at, teacherTz, locale),
                  city: cityOf(teacherTz, locale),
                })}
              </span>
            )}
            {viewerTz !== familyTz && (
              <span className="text-muted-foreground">
                {t('viewerTime', {
                  time: clock(at, viewerTz, locale),
                  city: cityOf(viewerTz, locale),
                })}
              </span>
            )}
          </div>
        )}
        <FieldSet>
          <FieldLegend variant="label">{t('offer.mode')}</FieldLegend>
          <RadioGroup
            value={mode}
            onValueChange={(v) => setMode(v as 'direct' | 'offer')}
            className="flex flex-wrap gap-x-6 gap-y-3"
            aria-label={t('offer.mode')}
          >
            {(['direct', 'offer'] as const).map((m) => (
              <Field key={m} orientation="horizontal" className="w-auto">
                <RadioGroupItem id={`trial-mode-${m}`} value={m} />
                <FieldLabel htmlFor={`trial-mode-${m}`} className="font-normal">
                  {t(`offer.modes.${m}`)}
                </FieldLabel>
              </Field>
            ))}
          </RadioGroup>
        </FieldSet>
        {mode === 'offer' ? (
          <TrialOfferFields
            leadId={lead.id}
            query={teachersQuery}
            value={offer}
            onChange={setOffer}
            showErrors={touched}
          />
        ) : (
          <TrialTeacherPicker
            leadId={lead.id}
            query={teachersQuery}
            value={teacherId}
            onChange={(id) => {
              setTeacherId(id);
              setTeacherRefusal('');
            }}
            onSelected={(o) => setOption(o ?? null)}
            overrideReason={overrideReason}
            onOverrideReason={(r) => {
              setOverrideReason(r);
              setTeacherRefusal('');
            }}
            showErrors={touched}
            error={errors.teacher}
          />
        )}
        <Field data-invalid={invalid('url')}>
          <FieldLabel htmlFor={ids.url}>
            {t('meetingUrl')}{' '}
            <span className="font-normal text-muted-foreground">({t('optional')})</span>
          </FieldLabel>
          <Input
            id={ids.url}
            dir="ltr"
            type="url"
            value={meetingUrl}
            onChange={(e) => setMeetingUrl(e.target.value)}
            className="h-10"
            aria-invalid={invalid('url')}
          />
          <FieldDescription>{t('meetingUrlHelp')}</FieldDescription>
          {invalid('url') && <FieldError>{errors.url}</FieldError>}
        </Field>
      </FieldGroup>
      {mode === 'direct' && (
        <ConflictList
          result={result}
          checking={check.isFetching && !result}
          acknowledged={ack}
          onAcknowledge={setAck}
        />
      )}
      {mode === 'direct' && touched && blocked && (
        <p className="text-sm font-medium text-destructive">{t('resolveConflicts')}</p>
      )}
      {mode === 'direct' && book.isError && !conflictsOf(book.error) && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{message(book.error)}</AlertDescription>
        </Alert>
      )}
      {mode === 'offer' && send.isError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{message(send.error)}</AlertDescription>
        </Alert>
      )}
      {/* Sticky: on a phone the form runs several screens; «احجز الحصة» stays in reach. */}
      <DialogFooter className="sticky -bottom-4 z-10 bg-muted">
        <DialogClose asChild>
          <Button type="button" variant="outline">
            {t('cancel')}
          </Button>
        </DialogClose>
        <Button type="submit" disabled={book.isPending || send.isPending}>
          {(book.isPending || send.isPending) && <Spinner />}
          {mode === 'offer' ? t('offer.send') : t('book')}
        </Button>
      </DialogFooter>
    </form>
  );
}
