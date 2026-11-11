'use client';

import {
  TEST_DURATIONS,
  TEST_SECTION_KEYS,
  TEST_SECTION_LABELS,
  TEST_TRACK_LABELS,
  TEST_TRACKS,
  type TestSection,
  type TestTrack,
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
} from '@qarabic/ui/components/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Textarea } from '@qarabic/ui/components/textarea';
import { ToggleGroup, ToggleGroupItem } from '@qarabic/ui/components/toggle-group';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Combobox } from '@/components/forms/fields';
import { DatePicker, TimeSelect } from '@/components/forms/date-time';
import { OtherTime, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { fetchPeopleList } from '@/lib/api/people';
import { createTest, teachingKeys } from '@/lib/api/teaching';
import { dateKeyIn, zonedInstant } from '@/lib/schedule-time';
import { cityOf } from '@/lib/time';
import { useTestError } from './test-bits';

/**
 * «جدولة اختبار» (docs/27 §8; the current app's `ScheduleTestDialog`): student, track, the tajweed
 * sections (all on by default), date and time in the viewer's zone with the student's time shown
 * live (D30), duration, and the examiner — staff only, defaulting to the student's current teacher
 * (D114); a teacher examines their own students' tests.
 */
export function ScheduleTestDialog({
  open,
  onOpenChange,
  canPickExaminer,
  student: preset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canPickExaminer: boolean;
  /** Opened from a student's profile: that student is chosen. */
  student?: { id: number; name: string };
}) {
  const t = useTranslations('tests.schedule');
  const tt = useTranslations('tests');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const router = useRouter();
  const queryClient = useQueryClient();
  const message = useTestError();
  const [studentSearch, setStudentSearch] = useState('');
  const [teacherSearch, setTeacherSearch] = useState('');
  const [studentId, setStudentId] = useState<number | null>(preset?.id ?? null);
  const [teacherId, setTeacherId] = useState<number | null>(null);
  const [track, setTrack] = useState<TestTrack>('hifz');
  const [sections, setSections] = useState<TestSection[]>([...TEST_SECTION_KEYS]);
  const [date, setDate] = useState(dateKeyIn(tz));
  const [time, setTime] = useState('');
  const [duration, setDuration] = useState(30);
  const [notes, setNotes] = useState('');
  const [touched, setTouched] = useState(false);
  const students = useQuery({
    queryKey: ['people', 'students', 'options', studentSearch],
    queryFn: ({ signal }) =>
      fetchPeopleList('students', { q: studentSearch, perPage: 25, status: 'active' }, signal),
    enabled: open,
  });
  const teachers = useQuery({
    queryKey: ['people', 'teachers', 'options', teacherSearch],
    queryFn: ({ signal }) =>
      fetchPeopleList('teachers', { q: teacherSearch, perPage: 25, status: 'active' }, signal),
    enabled: open && canPickExaminer,
  });
  const student = students.data?.data.find((s) => s.id === studentId);
  const iso = date && time ? zonedInstant(date, time, tz) : null;
  const errors = {
    student: !studentId ? t('pickStudent') : null,
    sections: sections.length === 0 ? t('pickSections') : null,
    when: !iso ? t('pickTime') : null,
  };
  const save = useMutation({
    mutationFn: createTest,
    onSuccess: (test) => {
      void queryClient.invalidateQueries({ queryKey: teachingKeys.all });
      toast.success(t('done', { name: test.student.name }));
      onOpenChange(false);
      router.push(`/tests/${test.id}`);
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (errors.student || errors.sections || errors.when || !studentId || !iso) return;
    save.mutate({
      studentId,
      track,
      sections,
      scheduledAt: iso,
      durationMinutes: duration,
      ...(canPickExaminer && teacherId ? { teacherId } : {}),
      notes: notes.trim() || null,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        <form noValidate onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>
              {canPickExaminer ? t('descriptionStaff') : t('descriptionTeacher')}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={touched && !!errors.student}>
              <FieldLabel htmlFor="test-student">
                {t('student')}
                <span className="text-destructive" aria-hidden>
                  *
                </span>
              </FieldLabel>
              <Combobox
                id="test-student"
                value={studentId ? String(studentId) : null}
                onChange={(v) => setStudentId(v ? Number(v) : null)}
                options={[
                  ...(preset && !students.data?.data.some((s) => s.id === preset.id)
                    ? [{ value: String(preset.id), label: preset.name }]
                    : []),
                  ...(students.data?.data ?? []).map((s) => ({
                    value: String(s.id),
                    label: s.name,
                    hint: s.teacher?.name,
                  })),
                ]}
                placeholder={t('chooseStudent')}
                searchPlaceholder={t('searchStudent')}
                shouldFilter={false}
                onSearch={setStudentSearch}
                loading={students.isFetching}
                invalid={touched && !!errors.student}
              />
              {student && (
                <FieldDescription>
                  {t('studentZone', { city: cityOf(student.family.timezone, locale) })}
                  {student.teacher && <> · {t('currentTeacher', { name: student.teacher.name })}</>}
                </FieldDescription>
              )}
              {touched && errors.student && <FieldError>{errors.student}</FieldError>}
            </Field>
            <Field>
              <FieldLabel id="test-track-label">{t('track')}</FieldLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                spacing={0}
                value={track}
                onValueChange={(v) => v && setTrack(v as TestTrack)}
                aria-labelledby="test-track-label"
                className="flex-wrap bg-card"
              >
                {TEST_TRACKS.map((x) => (
                  <ToggleGroupItem
                    key={x}
                    value={x}
                    className="h-10 px-3 data-[state=on]:bg-accent data-[state=on]:font-semibold"
                  >
                    {TEST_TRACK_LABELS[x][locale]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <FieldDescription>{tt(`trackHint.${track}`)}</FieldDescription>
            </Field>
            <Field data-invalid={touched && !!errors.sections}>
              <FieldLabel id="test-sections-label">{t('sections')}</FieldLabel>
              <ToggleGroup
                type="multiple"
                variant="outline"
                spacing={2}
                value={sections}
                onValueChange={(v) => setSections(v as TestSection[])}
                aria-labelledby="test-sections-label"
                className="flex-wrap justify-start"
              >
                {TEST_SECTION_KEYS.map((k) => (
                  <ToggleGroupItem
                    key={k}
                    value={k}
                    className="h-9 px-3 data-[state=on]:border-primary data-[state=on]:bg-accent data-[state=on]:font-semibold"
                  >
                    {TEST_SECTION_LABELS[k][locale]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              {touched && errors.sections && <FieldError>{errors.sections}</FieldError>}
            </Field>
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_8rem]">
              <Field>
                <FieldLabel htmlFor="test-date">{t('date')}</FieldLabel>
                <DatePicker id="test-date" value={date} onChange={setDate} className="w-full" />
              </Field>
              <Field data-invalid={touched && !!errors.when}>
                <FieldLabel htmlFor="test-time">
                  {t('time')}
                  <span className="text-destructive" aria-hidden>
                    *
                  </span>
                </FieldLabel>
                <TimeSelect
                  id="test-time"
                  value={time}
                  onChange={setTime}
                  invalid={touched && !!errors.when}
                />
                {touched && errors.when && <FieldError>{errors.when}</FieldError>}
              </Field>
              <Field>
                <FieldLabel htmlFor="test-duration">{t('duration')}</FieldLabel>
                <Select value={String(duration)} onValueChange={(v) => setDuration(Number(v))}>
                  <SelectTrigger id="test-duration" className="h-10! w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {TEST_DURATIONS.map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {tt('minutes', { count: d })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            {iso && (
              <p className="-mt-2 text-sm text-muted-foreground" aria-live="polite">
                {t('yourTime', { city: cityOf(tz, locale) })}
                {student && student.family.timezone !== tz && (
                  <>
                    {' · '}
                    <OtherTime at={iso} tz={student.family.timezone} party="student" />
                  </>
                )}
              </p>
            )}
            {canPickExaminer && (
              <Field>
                <FieldLabel htmlFor="test-examiner">{t('examiner')}</FieldLabel>
                <Combobox
                  id="test-examiner"
                  value={teacherId ? String(teacherId) : null}
                  onChange={(v) => setTeacherId(v ? Number(v) : null)}
                  options={(teachers.data?.data ?? []).map((x) => ({
                    value: String(x.id),
                    label: x.name,
                  }))}
                  placeholder={t('examinerDefault')}
                  searchPlaceholder={t('searchTeacher')}
                  shouldFilter={false}
                  onSearch={setTeacherSearch}
                  loading={teachers.isFetching}
                  clearable
                />
                <FieldDescription>{t('examinerHint')}</FieldDescription>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="test-notes">
                {t('notes')}{' '}
                <span className="font-normal text-muted-foreground">({t('optional')})</span>
              </FieldLabel>
              <Textarea
                id="test-notes"
                rows={2}
                maxLength={2000}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>
            {save.isError && (
              <Alert variant="destructive" role="alert">
                <AlertCircleIcon />
                <AlertDescription>{message(save.error)}</AlertDescription>
              </Alert>
            )}
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t('back')}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Spinner />}
              {t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
