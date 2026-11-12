'use client';

import type { ConflictResultDto, LeadDetailDto } from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { Checkbox } from '@qarabic/ui/components/checkbox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@qarabic/ui/components/dialog';
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@qarabic/ui/components/field';
import { Label } from '@qarabic/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Spinner } from '@qarabic/ui/components/spinner';
import { useMutation, useQuery } from '@tanstack/react-query';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Combobox } from '@/components/forms/fields';
import { DatePicker, TimeSelect } from '@/components/forms/date-time';
import { useLookups } from '@/components/people/person-sheet';
import { canSave, ConflictList } from '@/components/sessions/conflict-list';
import { useUiLocale } from '@/components/sessions/times';
import { convertLead } from '@/lib/api/crm';
import { fetchPerson } from '@/lib/api/people';
import { conflictsOf } from '@/lib/sessions/errors';
import { dateKeyIn, otherSideOf, STAFF_WEEK, wallTime, weekdayName } from '@/lib/schedule-time';
import { cityOf, isValidTimeZone } from '@/lib/time';
import { useCrmError } from './crm-bits';

type Slot = { weekday: string; time: string };
type Plan = {
  include: boolean;
  courseId: string;
  teacherId: string | null;
  startsOn: string;
  minutes: string;
  slots: Slot[];
};

/**
 * «حوّل إلى منتظم» (docs/26 §9.6, D110): per child the course, the teacher (from the trial), the
 * start date, the class length and the weekly times in the family's zone with the teacher's time
 * beside each; one transaction on the server — any clash keeps nothing. The welcome mail with the
 * set-password link is off unless ticked (D140).
 */
export function ConvertDialog({
  lead,
  onClose,
  onSaved,
}: {
  lead: LeadDetailDto;
  onClose: () => void;
  onSaved: (l: LeadDetailDto) => void;
}) {
  const t = useTranslations('crm.convert');
  const tc = useTranslations('crm');
  const locale = useUiLocale();
  const message = useCrmError();
  const familyTz = lead.family?.timezone ?? lead.timezone;
  const today = dateKeyIn(familyTz);
  const [plans, setPlans] = useState<Record<number, Plan>>(() =>
    Object.fromEntries(
      lead.students.map((s) => {
        const trial = lead.trials.find((x) => x.student.id === s.id) ?? lead.trials[0];
        return [
          s.id,
          {
            include: true,
            courseId: String(trial?.course?.id ?? s.courseId ?? ''),
            teacherId: trial ? String(trial.teacher.id) : null,
            startsOn: today,
            minutes: String(trial?.durationMinutes ?? 30),
            slots: [{ weekday: '', time: '' }],
          },
        ];
      }),
    ),
  );
  const [welcome, setWelcome] = useState(false);
  const [ack, setAck] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const [conflicts, setConflicts] = useState<ConflictResultDto | null>(null);
  const welcomeId = useId();
  const chosen = lead.students.filter((s) => plans[s.id]?.include);
  const complete = (p: Plan) =>
    !!p.courseId && !!p.teacherId && !!p.startsOn && p.slots.every((s) => s.weekday && s.time);
  const valid = chosen.length > 0 && chosen.every((s) => complete(plans[s.id]!));
  const update = (id: number, patch: Partial<Plan>) => {
    setConflicts(null);
    setPlans((ps) => ({ ...ps, [id]: { ...ps[id]!, ...patch } }));
  };
  const convert = useMutation({
    mutationFn: () =>
      convertLead(lead.id, {
        students: chosen.map((s) => {
          const p = plans[s.id]!;
          return {
            studentId: s.id,
            courseId: Number(p.courseId),
            teacherId: Number(p.teacherId),
            startsOn: p.startsOn,
            sessionMinutes: Number(p.minutes),
            slots: p.slots.map((x) => ({ weekday: Number(x.weekday), localStartTime: x.time })),
          };
        }),
        sendWelcome: welcome,
        acknowledgeWarnings: ack,
      }),
    onSuccess: (d) => {
      toast.success(t('done'));
      onSaved(d);
      onClose();
    },
    onError: (e) => {
      const c = conflictsOf(e);
      if (c) setConflicts(c);
    },
  });
  const blocked = !!conflicts && !canSave(conflicts, ack);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-3xl" showCloseButton={false}>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (!valid || blocked) return;
            convert.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('help', { city: cityOf(familyTz, locale) })}</DialogDescription>
          </DialogHeader>
          {!lead.family || lead.students.length === 0 ? (
            <Alert variant="destructive">
              <AlertDescription>{t('needAccount')}</AlertDescription>
            </Alert>
          ) : (
            lead.students.map((s) => (
              <StudentPlan
                key={s.id}
                name={s.name}
                plan={plans[s.id]!}
                familyTz={familyTz}
                today={today}
                touched={touched}
                onChange={(patch) => update(s.id, patch)}
              />
            ))
          )}
          <div className="flex items-center gap-2">
            <Checkbox
              id={welcomeId}
              checked={welcome}
              onCheckedChange={(v) => setWelcome(v === true)}
            />
            <Label htmlFor={welcomeId} className="font-normal">
              {t('sendWelcome')}
            </Label>
          </div>
          <ConflictList result={conflicts} acknowledged={ack} onAcknowledge={setAck} />
          {touched && !valid && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {chosen.length === 0 ? t('chooseOne') : t('slotRequired')}
            </p>
          )}
          {convert.isError && !conflictsOf(convert.error) && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{message(convert.error)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {tc('back')}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={convert.isPending || !lead.family}>
              {convert.isPending && <Spinner />}
              {t('confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function StudentPlan({
  name,
  plan,
  familyTz,
  today,
  touched,
  onChange,
}: {
  name: string;
  plan: Plan;
  familyTz: string;
  today: string;
  touched: boolean;
  onChange: (patch: Partial<Plan>) => void;
}) {
  const t = useTranslations('crm.convert');
  const tt = useTranslations('crm.trial');
  const locale = useUiLocale();
  const lookups = useLookups();
  const ids = {
    include: useId(),
    course: useId(),
    teacher: useId(),
    start: useId(),
    minutes: useId(),
  };
  const teacher = useQuery({
    queryKey: ['crm', 'teacher', plan.teacherId],
    queryFn: ({ signal }) => fetchPerson('teachers', Number(plan.teacherId), signal),
    enabled: !!plan.teacherId,
  });
  const teacherTz = teacher.data?.timezone;
  const missing = (v: string | null) => touched && plan.include && !v;
  return (
    <Card className="gap-3 shadow-none">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2 text-base font-bold">
          <Checkbox
            id={ids.include}
            checked={plan.include}
            onCheckedChange={(v) => onChange({ include: v === true })}
          />
          <Label htmlFor={ids.include} className="text-base font-bold">
            {name}
          </Label>
        </CardTitle>
      </CardHeader>
      {plan.include && (
        <CardContent>
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={missing(plan.courseId)}>
                <FieldLabel htmlFor={ids.course}>{tt('course')}</FieldLabel>
                <Select value={plan.courseId} onValueChange={(v) => onChange({ courseId: v })}>
                  <SelectTrigger
                    id={ids.course}
                    className="h-10! w-full"
                    aria-invalid={missing(plan.courseId)}
                  >
                    <SelectValue placeholder={tt('choose')} />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {(lookups.data?.courses ?? []).map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {locale === 'ar' ? c.nameAr : c.nameEn}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field data-invalid={missing(plan.teacherId)}>
                <FieldLabel htmlFor={ids.teacher}>{tt('teacher')}</FieldLabel>
                <Combobox
                  id={ids.teacher}
                  value={plan.teacherId}
                  onChange={(v) => onChange({ teacherId: v })}
                  options={(lookups.data?.teachers ?? []).map((x) => ({
                    value: String(x.id),
                    label: x.name,
                  }))}
                  placeholder={tt('chooseTeacher')}
                  searchPlaceholder={tt('searchTeacher')}
                  invalid={missing(plan.teacherId)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={ids.start}>{t('startsOn')}</FieldLabel>
                <DatePicker
                  id={ids.start}
                  value={plan.startsOn}
                  min={today}
                  onChange={(v) => onChange({ startsOn: v })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={ids.minutes}>{t('minutes')}</FieldLabel>
                <Select value={plan.minutes} onValueChange={(v) => onChange({ minutes: v })}>
                  <SelectTrigger id={ids.minutes} className="h-10! w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {[30, 45, 60, 90].map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {tt('minutes', { count: m })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <FieldSet>
              <FieldLegend variant="label">
                {t('slots', { city: cityOf(familyTz, locale) })}
              </FieldLegend>
              <ul className="flex flex-col gap-2">
                {plan.slots.map((slot, i) => {
                  const other =
                    slot.weekday && slot.time && teacherTz && isValidTimeZone(teacherTz)
                      ? otherSideOf(
                          {
                            weekday: Number(slot.weekday),
                            localStartTime: slot.time,
                            timezone: familyTz,
                          },
                          teacherTz,
                          plan.startsOn || today,
                        )
                      : null;
                  const setSlot = (patch: Partial<Slot>) =>
                    onChange({
                      slots: plan.slots.map((x, j) => (j === i ? { ...x, ...patch } : x)),
                    });
                  return (
                    <li key={i} className="flex flex-wrap items-center gap-2">
                      <Select value={slot.weekday} onValueChange={(v) => setSlot({ weekday: v })}>
                        <SelectTrigger
                          className="h-10! w-36"
                          aria-label={t('weekday', { n: i + 1 })}
                          aria-invalid={touched && plan.include && !slot.weekday}
                        >
                          <SelectValue placeholder={t('weekdayPlaceholder')} />
                        </SelectTrigger>
                        <SelectContent position="popper">
                          {STAFF_WEEK.map((d) => (
                            <SelectItem key={d} value={String(d)}>
                              {weekdayName(d, locale)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <div className="w-32" aria-label={t('time', { n: i + 1 })} role="group">
                        <TimeSelect
                          value={slot.time}
                          onChange={(v) => setSlot({ time: v })}
                          invalid={touched && plan.include && !slot.time}
                        />
                      </div>
                      {other && (
                        <span className="text-sm text-muted-foreground">
                          {t('teacherSees', {
                            day: weekdayName(other.weekday, locale),
                            time: wallTime(other.time, locale),
                          })}
                        </span>
                      )}
                      {plan.slots.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={t('removeSlot', { n: i + 1 })}
                          onClick={() => onChange({ slots: plan.slots.filter((_, j) => j !== i) })}
                        >
                          <Trash2Icon />
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {plan.slots.length < 7 && (
                <Button
                  type="button"
                  variant="outline"
                  className="self-start"
                  onClick={() => onChange({ slots: [...plan.slots, { weekday: '', time: '' }] })}
                >
                  <PlusIcon />
                  {t('addSlot')}
                </Button>
              )}
            </FieldSet>
          </FieldGroup>
        </CardContent>
      )}
    </Card>
  );
}
