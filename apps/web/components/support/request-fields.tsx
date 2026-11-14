'use client';

import {
  INVOICE_TOPIC_LABELS,
  INVOICE_TOPICS,
  REQUEST_PAYLOAD_SCHEMAS,
  SUBSCRIPTION_REASON_LABELS,
  SUBSCRIPTION_REASONS,
  TEACHER_CHANGE_REASON_LABELS,
  TEACHER_CHANGE_REASONS,
  type TypedRequest,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import {
  Field,
  FieldDescription,
  FieldError,
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
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import { DatePicker, TimeSelect } from '@/components/forms/date-time';
import { useUiLocale } from '@/components/sessions/times';
import { STAFF_WEEK, weekdayName } from '@/lib/schedule-time';
import { cityOf } from '@/lib/time';

/** The form's draft of a typed request (strings while editing). */
export interface RequestDraft {
  slots: { weekday: string; time: string }[];
  startsOn: string;
  reason: string;
  preferredGender: string;
  preferredTimes: string;
  action: 'pause' | 'stop';
  from: string;
  to: string;
  topic: string;
}

export const emptyRequest = (today: string): RequestDraft => ({
  slots: [{ weekday: '', time: '' }],
  startsOn: today,
  reason: '',
  preferredGender: 'any',
  preferredTimes: '',
  action: 'pause',
  from: today,
  to: '',
  topic: '',
});

/**
 * The payload a typed request sends (docs/32 §3 #4–#7, S3), checked with the shared schema: the
 * errors come back by field path. `studentId` is the child the request is about (picked in the
 * form, or from the class it came from); a pause or stop with none covers the whole family.
 */
export function requestPayload(
  kind: TypedRequest,
  d: RequestDraft,
  studentId: number | null,
  timezone: string,
) {
  const raw =
    kind === 'schedule_change'
      ? {
          studentId,
          slots: d.slots
            .filter((s) => s.weekday || s.time)
            .map((s) => ({ weekday: Number(s.weekday), localTime: s.time })),
          startsOn: d.startsOn,
          timezone,
        }
      : kind === 'teacher_change'
        ? {
            studentId,
            reason: d.reason || undefined,
            preferredGender: d.preferredGender === 'any' ? null : d.preferredGender,
            preferredTimes: d.preferredTimes,
          }
        : kind === 'subscription_change'
          ? {
              action: d.action,
              studentIds: studentId ? [studentId] : [],
              from: d.from,
              to: d.action === 'pause' ? d.to || null : null,
              reason: d.reason || undefined,
            }
          : { topic: d.topic || undefined };
  const parsed = REQUEST_PAYLOAD_SCHEMAS[kind].safeParse(raw);
  const errors: Record<string, true> = {};
  if (!parsed.success) for (const i of parsed.error.issues) errors[i.path.join('.')] = true;
  // The schema's cross-field rules run only once the rest passes: say both at once.
  if (kind === 'subscription_change' && d.action === 'pause' && !d.to) errors.to = true;
  return { payload: parsed.success && !errors.to ? parsed.data : null, errors };
}

/** The structured fields of a typed request, above the free-text details. */
export function RequestFields({
  kind,
  value,
  onChange,
  errors,
  showErrors,
  timezone,
}: {
  kind: TypedRequest;
  value: RequestDraft;
  onChange: (next: RequestDraft) => void;
  errors: Record<string, true>;
  showErrors: boolean;
  /** The zone the times are in (the sender's), said with the times (D30). */
  timezone: string;
}) {
  const t = useTranslations('support.request');
  const locale = useUiLocale();
  const ids = {
    reason: useId(),
    gender: useId(),
    times: useId(),
    from: useId(),
    to: useId(),
    startsOn: useId(),
    topic: useId(),
    action: useId(),
  };
  const set = (patch: Partial<RequestDraft>) => onChange({ ...value, ...patch });
  const bad = (path: string) => showErrors && !!errors[path];
  const pick = (
    id: string,
    label: string,
    v: string,
    on: (v: string) => void,
    options: { value: string; label: string }[],
    path: string,
  ) => (
    <Field data-invalid={bad(path)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select value={v} onValueChange={on}>
        <SelectTrigger id={id} className="h-10! w-full" aria-invalid={bad(path)}>
          <SelectValue placeholder={t('choose')} />
        </SelectTrigger>
        <SelectContent position="popper">
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {bad(path) && <FieldError>{t('required')}</FieldError>}
    </Field>
  );

  if (kind === 'schedule_change') {
    return (
      <>
        <FieldSet data-invalid={bad('slots')}>
          <FieldLegend variant="label">{t('newTimes')}</FieldLegend>
          <FieldDescription>{t('timesZone', { city: cityOf(timezone, locale) })}</FieldDescription>
          {value.slots.map((slot, i) => (
            <div key={i} className="flex items-end gap-2">
              <Select
                value={slot.weekday}
                onValueChange={(v) =>
                  set({ slots: value.slots.map((s, j) => (j === i ? { ...s, weekday: v } : s)) })
                }
              >
                <SelectTrigger
                  className="h-10! flex-1"
                  aria-label={t('day', { n: i + 1 })}
                  aria-invalid={bad(`slots.${i}.weekday`) || (bad('slots') && !slot.weekday)}
                >
                  <SelectValue placeholder={t('day', { n: i + 1 })} />
                </SelectTrigger>
                <SelectContent position="popper">
                  {STAFF_WEEK.map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {weekdayName(d, locale)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <TimeSelect
                label={t('time', { n: i + 1 })}
                value={slot.time}
                onChange={(v) =>
                  set({ slots: value.slots.map((s, j) => (j === i ? { ...s, time: v } : s)) })
                }
                invalid={bad(`slots.${i}.localTime`) || (bad('slots') && !slot.time)}
                className="w-32"
              />
              {value.slots.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('removeTime', { n: i + 1 })}
                  onClick={() => set({ slots: value.slots.filter((_, j) => j !== i) })}
                >
                  <Trash2Icon />
                </Button>
              )}
            </div>
          ))}
          {value.slots.length < 7 && (
            <Button
              type="button"
              variant="outline"
              className="self-start"
              onClick={() => set({ slots: [...value.slots, { weekday: '', time: '' }] })}
            >
              <PlusIcon />
              {t('addTime')}
            </Button>
          )}
          {(bad('slots') ||
            (Object.keys(errors).some((k) => k.startsWith('slots')) && showErrors)) && (
            <FieldError>{t('timesRequired')}</FieldError>
          )}
        </FieldSet>
        <Field data-invalid={bad('startsOn')}>
          <FieldLabel htmlFor={ids.startsOn}>{t('startsOn')}</FieldLabel>
          <DatePicker
            id={ids.startsOn}
            invalid={bad('startsOn')}
            value={value.startsOn}
            onChange={(v) => set({ startsOn: v })}
          />
        </Field>
      </>
    );
  }
  if (kind === 'teacher_change') {
    return (
      <>
        {pick(
          ids.reason,
          t('teacherReason'),
          value.reason,
          (v) => set({ reason: v }),
          TEACHER_CHANGE_REASONS.map((r) => ({
            value: r,
            label: TEACHER_CHANGE_REASON_LABELS[r][locale],
          })),
          'reason',
        )}
        {pick(
          ids.gender,
          t('preferredGender'),
          value.preferredGender,
          (v) => set({ preferredGender: v }),
          [
            { value: 'any', label: t('genderAny') },
            { value: 'male', label: t('genderMale') },
            { value: 'female', label: t('genderFemale') },
          ],
          'preferredGender',
        )}
        <Field>
          <FieldLabel htmlFor={ids.times}>{t('preferredTimes')}</FieldLabel>
          <Input
            id={ids.times}
            value={value.preferredTimes}
            maxLength={300}
            className="h-10"
            onChange={(e) => set({ preferredTimes: e.target.value })}
          />
        </Field>
      </>
    );
  }
  if (kind === 'subscription_change') {
    return (
      <>
        <FieldSet>
          <FieldLegend id={ids.action} variant="label">
            {t('subscriptionAction')}
          </FieldLegend>
          <RadioGroup
            aria-labelledby={ids.action}
            value={value.action}
            onValueChange={(v) => set({ action: v as 'pause' | 'stop' })}
            className="flex flex-wrap gap-x-6 gap-y-3"
          >
            {(['pause', 'stop'] as const).map((a) => (
              <Field key={a} orientation="horizontal" className="w-auto">
                <RadioGroupItem id={`${ids.action}-${a}`} value={a} />
                <FieldLabel htmlFor={`${ids.action}-${a}`} className="font-normal">
                  {t(`actions.${a}`)}
                </FieldLabel>
              </Field>
            ))}
          </RadioGroup>
          <FieldDescription>{t(`actions.${value.action}Effect`)}</FieldDescription>
        </FieldSet>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={bad('from')}>
            <FieldLabel htmlFor={ids.from}>{t('from')}</FieldLabel>
            <DatePicker
              id={ids.from}
              invalid={bad('from')}
              value={value.from}
              onChange={(v) => set({ from: v })}
            />
          </Field>
          {value.action === 'pause' && (
            <Field data-invalid={bad('to')}>
              <FieldLabel htmlFor={ids.to}>{t('to')}</FieldLabel>
              <DatePicker
                id={ids.to}
                value={value.to}
                min={value.from}
                invalid={bad('to')}
                onChange={(v) => set({ to: v })}
              />
              {bad('to') && <FieldError>{t('toRequired')}</FieldError>}
            </Field>
          )}
        </div>
        {pick(
          ids.reason,
          t('subscriptionReason'),
          value.reason,
          (v) => set({ reason: v }),
          SUBSCRIPTION_REASONS.map((r) => ({
            value: r,
            label: SUBSCRIPTION_REASON_LABELS[r][locale],
          })),
          'reason',
        )}
      </>
    );
  }
  return pick(
    ids.topic,
    t('topic'),
    value.topic,
    (v) => set({ topic: v }),
    INVOICE_TOPICS.map((x) => ({ value: x, label: INVOICE_TOPIC_LABELS[x][locale] })),
    'topic',
  );
}
