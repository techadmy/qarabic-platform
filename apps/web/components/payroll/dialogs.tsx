'use client';

import {
  ADJUSTMENT_TYPE_LABELS,
  ATTENDANCE_STATUS_LABELS,
  ATTENDANCE_STATUSES,
  LEAVE_TYPE_LABELS,
  LEAVE_TYPES,
  PAYOUT_METHOD_LABELS,
  PAYOUT_METHODS,
  SALARY_TYPE_LABELS,
  SALARY_TYPES,
  type AdjustmentType,
  type AttendanceStatus,
  type LeaveType,
  type PayoutMethod,
  type PayProfileDto,
  type PayslipDto,
  type SalaryType,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Checkbox } from '@qarabic/ui/components/checkbox';
import { Input } from '@qarabic/ui/components/input';
import { Label } from '@qarabic/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Switch } from '@qarabic/ui/components/switch';
import { Textarea } from '@qarabic/ui/components/textarea';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import {
  createAdjustment,
  createLeave,
  markAttendance,
  payrollKeys,
  recordPayslipPayment,
  savePayProfile,
} from '@/lib/api/payroll';
import { can } from '@/lib/auth/use-me';
import { amountInput, formatMoney } from '@/lib/billing/money';
import {
  creatableTypes,
  finesNeedApproval,
  validateAdjustment,
  validateLeave,
  validateMark,
  validatePayment,
  validateProfile,
  type ProfileForm,
} from '@/lib/payroll/forms';
import { ACADEMY_TZ } from '@/lib/payroll/labels';
import { addDays, dateKeyIn } from '@/lib/schedule-time';
import { formatDate } from '@/lib/time';
import { FormDialog, FormRow, NUMBER_INPUT, PersonPicker, usePayrollError } from './payroll-bits';

/**
 * Payroll forms (docs/21 §5–§7, the current app's `AdjustmentDialog` and the dialogs of
 * `AttendancePage`, `PayslipPage`): request leave, mark a day, add a fine or another pay item,
 * record a payment, edit a salary profile. Each validates on submit with the rules in
 * `lib/payroll/forms`, keeps the input on a refusal and shows the API's reason in the UI language.
 */

const academyToday = () => dateKeyIn(ACADEMY_TZ);

function useSave<V, R>(fn: (v: V) => Promise<R>, done: (r: R) => string, onDone: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: payrollKeys.all });
      toast.success(done(r));
      onDone();
    },
  });
}

function ChoiceSelect<T extends string>({
  id,
  value,
  onChange,
  options,
}: {
  id: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger id={id} className="h-10! w-full md:text-[0.9375rem]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ReasonField({
  id,
  label,
  value,
  onChange,
  error,
  required = true,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  required?: boolean;
  hint?: ReactNode;
}) {
  return (
    <FormRow id={id} label={label} required={required} error={error} hint={hint}>
      <Textarea
        id={id}
        dir="auto"
        rows={3}
        maxLength={1000}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        aria-required={required || undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className="md:text-[0.9375rem]"
      />
    </FormRow>
  );
}

// ------------------------------------------------------------------ leave request

/** Own leave, or (staff with `attendance.manage`, `forSomeone`) a leave for a staff member. */
export function LeaveRequestDialog({
  open,
  onOpenChange,
  forSomeone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  forSomeone?: boolean;
}) {
  const t = useTranslations('payroll');
  const locale = useUiLocale();
  const message = usePayrollError();
  const ids = { person: useId(), from: useId(), to: useId(), type: useId(), reason: useId() };
  const tomorrow = addDays(academyToday(), 1);
  const [userId, setUserId] = useState<number | null>(null);
  const [startsOn, setStartsOn] = useState(tomorrow);
  const [endsOn, setEndsOn] = useState(tomorrow);
  const [leaveType, setLeaveType] = useState<LeaveType>('paid');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const save = useSave(
    createLeave,
    () => t('leave.sent'),
    () => onOpenChange(false),
  );
  const check = validateLeave({ userId, startsOn, endsOn, leaveType, reason });
  const personMissing = forSomeone && !userId;
  const err = (k: 'startsOn' | 'endsOn' | 'reason') =>
    touched && check.errors[k] ? t(`form.${check.errors[k]}`) : null;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={forSomeone ? t('leave.requestFor') : t('leave.requestTitle')}
      description={t('leave.requestDescription')}
      submitLabel={t('leave.submit')}
      busy={save.isPending}
      error={save.isError ? message(save.error) : null}
      summary={touched && (!check.body || personMissing) ? t('form.fixErrors') : null}
      onSubmit={() => {
        setTouched(true);
        if (check.body && !personMissing) save.mutate(check.body);
      }}
    >
      {forSomeone && (
        <FormRow
          id={ids.person}
          label={t('person')}
          required
          error={touched && personMissing ? t('form.personRequired') : null}
        >
          <PersonPicker
            id={ids.person}
            value={userId}
            onChange={(p) => setUserId(p?.id ?? null)}
            invalid={touched && personMissing}
            placeholder={t('adjust.personPlaceholder')}
            searchPlaceholder={t('adjust.personSearch')}
          />
        </FormRow>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormRow id={ids.from} label={t('leave.from')} required error={err('startsOn')}>
          <Input
            id={ids.from}
            type="date"
            dir="ltr"
            value={startsOn}
            onChange={(e) => {
              setStartsOn(e.target.value);
              if (e.target.value > endsOn) setEndsOn(e.target.value);
            }}
            aria-invalid={!!err('startsOn')}
            className={NUMBER_INPUT}
          />
        </FormRow>
        <FormRow id={ids.to} label={t('leave.to')} required error={err('endsOn')}>
          <Input
            id={ids.to}
            type="date"
            dir="ltr"
            min={startsOn}
            value={endsOn}
            onChange={(e) => setEndsOn(e.target.value)}
            aria-invalid={!!err('endsOn')}
            aria-describedby={err('endsOn') ? `${ids.to}-error` : undefined}
            className={NUMBER_INPUT}
          />
        </FormRow>
      </div>
      <FormRow id={ids.type} label={t('leave.type')} required>
        <ChoiceSelect
          id={ids.type}
          value={leaveType}
          onChange={setLeaveType}
          options={LEAVE_TYPES.map((x) => ({ value: x, label: LEAVE_TYPE_LABELS[x][locale] }))}
        />
      </FormRow>
      <ReasonField
        id={ids.reason}
        label={t('reason')}
        value={reason}
        onChange={setReason}
        error={err('reason')}
      />
    </FormDialog>
  );
}

// ------------------------------------------------------------------ mark a day

export function MarkDayDialog({
  open,
  onOpenChange,
  person,
  date,
  current,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  person: { id: number; name: string };
  date: string;
  current?: { status: AttendanceStatus; paidLeave: boolean; note: string | null };
}) {
  const t = useTranslations('payroll');
  const locale = useUiLocale();
  const message = usePayrollError();
  const ids = { date: useId(), status: useId(), paid: useId(), note: useId(), reason: useId() };
  const [day, setDay] = useState(date);
  const [status, setStatus] = useState<AttendanceStatus>(current?.status ?? 'present');
  const [paidLeave, setPaidLeave] = useState(current?.paidLeave ?? true);
  const [note, setNote] = useState(current?.note ?? '');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const save = useSave(
    (body: Parameters<typeof markAttendance>[2]) => markAttendance(person.id, day, body),
    () => t('attendance.markSaved'),
    () => onOpenChange(false),
  );
  const check = validateMark({ status, paidLeave, note, reason });
  const reasonErr = touched && check.errors.reason ? t(`form.${check.errors.reason}`) : null;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('attendance.markDayFor', {
        date: formatDate(day, locale) ?? day,
        name: person.name,
      })}
      description={t('attendance.markDescription')}
      submitLabel={t('attendance.markSubmit')}
      busy={save.isPending}
      error={save.isError ? message(save.error) : null}
      summary={touched && !check.body ? t('form.fixErrors') : null}
      onSubmit={() => {
        setTouched(true);
        if (check.body) save.mutate(check.body);
      }}
    >
      <FormRow id={ids.date} label={t('attendance.markDate')} required>
        <Input
          id={ids.date}
          type="date"
          dir="ltr"
          max={academyToday()}
          value={day}
          onChange={(e) => e.target.value && setDay(e.target.value)}
          className={NUMBER_INPUT}
        />
      </FormRow>
      <FormRow id={ids.status} label={t('status')} required>
        <ChoiceSelect
          id={ids.status}
          value={status}
          onChange={setStatus}
          options={ATTENDANCE_STATUSES.map((x) => ({
            value: x,
            label: ATTENDANCE_STATUS_LABELS[x][locale],
          }))}
        />
      </FormRow>
      {status === 'leave' && (
        <div className="flex items-center gap-3">
          <Switch id={ids.paid} checked={paidLeave} onCheckedChange={setPaidLeave} />
          <Label htmlFor={ids.paid}>{t('attendance.paidLeave')}</Label>
        </div>
      )}
      <FormRow id={ids.note} label={t('note')}>
        <Input
          id={ids.note}
          dir="auto"
          maxLength={1000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="h-10 md:text-[0.9375rem]"
        />
      </FormRow>
      <ReasonField
        id={ids.reason}
        label={t('reason')}
        value={reason}
        onChange={setReason}
        error={reasonErr}
      />
    </FormDialog>
  );
}

// ------------------------------------------------------------------ fine / pay item

/**
 * A fine or another pay item (docs/21 §6): the viewer's permissions decide the types; a fine
 * from a monitor is «proposed» and waits for a manager. The amount is in the person's salary
 * currency; CSR conversions take a count instead. `person` fixes the person (from a payslip).
 */
export function AdjustmentDialog({
  open,
  onOpenChange,
  person,
  defaultDate,
  finesOnly,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  person?: { id: number; name: string; currency: string };
  defaultDate?: string;
  finesOnly?: boolean;
}) {
  const t = useTranslations('payroll');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const message = usePayrollError();
  const types = creatableTypes(me.permissions).filter((x) => !finesOnly || x === 'fine');
  const ids = {
    person: useId(),
    type: useId(),
    amount: useId(),
    quantity: useId(),
    date: useId(),
    session: useId(),
    reason: useId(),
  };
  const [who, setWho] = useState(person ?? null);
  const [type, setType] = useState<AdjustmentType>(types[0] ?? 'fine');
  const [amount, setAmount] = useState('');
  const [quantity, setQuantity] = useState('');
  const [effectiveOn, setEffectiveOn] = useState(defaultDate ?? academyToday());
  const [sessionId, setSessionId] = useState('');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const proposing =
    type === 'fine' && finesNeedApproval(me.permissions) && !can(me, 'payroll.manage');
  const save = useSave(
    createAdjustment,
    (r) => (r.status === 'proposed' ? t('adjust.proposed') : t('adjust.saved')),
    () => onOpenChange(false),
  );
  const check = validateAdjustment({
    userId: who?.id ?? null,
    type,
    amount,
    quantity,
    effectiveOn,
    sessionId,
    reason,
  });
  const err = (k: keyof typeof check.errors) =>
    touched && check.errors[k] ? t(`form.${check.errors[k]}`) : null;
  const isFine = types.length === 1 && types[0] === 'fine';
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isFine ? t('adjust.fineTitle') : t('adjust.title')}
      description={proposing ? t('adjust.proposeHint') : t('adjust.hint')}
      submitLabel={proposing ? t('adjust.submitPropose') : t('adjust.submit')}
      busy={save.isPending}
      error={save.isError ? message(save.error) : null}
      summary={touched && !check.body ? t('form.fixErrors') : null}
      onSubmit={() => {
        setTouched(true);
        if (check.body) save.mutate(check.body);
      }}
    >
      {person ? (
        <p className="text-sm">
          <span className="text-muted-foreground">{t('person')}: </span>
          <span className="font-semibold">{person.name}</span>
        </p>
      ) : (
        <FormRow id={ids.person} label={t('person')} required error={err('userId')}>
          <PersonPicker
            id={ids.person}
            value={who?.id ?? null}
            onChange={setWho}
            invalid={!!err('userId')}
            placeholder={t('adjust.personPlaceholder')}
            searchPlaceholder={t('adjust.personSearch')}
          />
        </FormRow>
      )}
      {types.length > 1 && (
        <FormRow id={ids.type} label={t('adjust.type')} required>
          <ChoiceSelect
            id={ids.type}
            value={type}
            onChange={setType}
            options={types.map((x) => ({ value: x, label: ADJUSTMENT_TYPE_LABELS[x][locale] }))}
          />
        </FormRow>
      )}
      {type === 'csr_conversions' ? (
        <FormRow
          id={ids.quantity}
          label={t('adjust.quantity')}
          required
          error={err('quantity')}
          hint={t('adjust.quantityHint')}
        >
          <Input
            id={ids.quantity}
            inputMode="numeric"
            dir="ltr"
            autoComplete="off"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            aria-invalid={!!err('quantity')}
            className={NUMBER_INPUT}
          />
        </FormRow>
      ) : (
        <FormRow
          id={ids.amount}
          label={
            who ? t('adjust.amount', { currency: who.currency }) : t('adjust.amountNoCurrency')
          }
          required
          error={err('amount')}
          hint={who ? t('adjust.currencyHint', { currency: who.currency }) : undefined}
        >
          <Input
            id={ids.amount}
            inputMode="decimal"
            dir="ltr"
            autoComplete="off"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={!!err('amount')}
            aria-describedby={err('amount') ? `${ids.amount}-error` : undefined}
            className={NUMBER_INPUT}
          />
        </FormRow>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormRow id={ids.date} label={t('adjust.effectiveOn')} required error={err('effectiveOn')}>
          <Input
            id={ids.date}
            type="date"
            dir="ltr"
            value={effectiveOn}
            onChange={(e) => setEffectiveOn(e.target.value)}
            aria-invalid={!!err('effectiveOn')}
            className={NUMBER_INPUT}
          />
        </FormRow>
        {type === 'fine' && (
          <FormRow id={ids.session} label={t('adjust.sessionId')} error={err('sessionId')}>
            <Input
              id={ids.session}
              inputMode="numeric"
              dir="ltr"
              autoComplete="off"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              aria-invalid={!!err('sessionId')}
              className={NUMBER_INPUT}
            />
          </FormRow>
        )}
      </div>
      <ReasonField
        id={ids.reason}
        label={t('reason')}
        value={reason}
        onChange={setReason}
        error={err('reason')}
      />
    </FormDialog>
  );
}

// ------------------------------------------------------------------ record a payment

/** «تسجيل الصرف» (D93, D140): records what Accounts paid outside the system; no money moves. */
export function PaymentDialog({
  slip,
  open,
  onOpenChange,
}: {
  slip: PayslipDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('payroll');
  const locale = useUiLocale();
  const message = usePayrollError();
  const ids = { method: useId(), ref: useId(), date: useId() };
  const today = academyToday();
  const [method, setMethod] = useState<PayoutMethod>('vodafone_cash');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(today);
  const [touched, setTouched] = useState(false);
  const save = useSave(
    (body: Parameters<typeof recordPayslipPayment>[1]) => recordPayslipPayment(slip.id, body),
    () => t('slip.paid'),
    () => onOpenChange(false),
  );
  const check = validatePayment({ method, reference, paidOn }, { today });
  const err = (k: 'reference' | 'paidOn') =>
    touched && check.errors[k] ? t(`form.${check.errors[k]}`) : null;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('slip.payTitle')}
      description={t('slip.payBody', {
        amount: formatMoney(slip.net, slip.currency, locale),
        name: slip.user.name,
      })}
      submitLabel={t('slip.pay')}
      busy={save.isPending}
      error={save.isError ? message(save.error) : null}
      summary={touched && !check.body ? t('form.fixErrors') : null}
      onSubmit={() => {
        setTouched(true);
        if (check.body) save.mutate(check.body);
      }}
    >
      <FormRow id={ids.method} label={t('slip.method')} required>
        <ChoiceSelect
          id={ids.method}
          value={method}
          onChange={setMethod}
          options={PAYOUT_METHODS.map((x) => ({
            value: x,
            label: PAYOUT_METHOD_LABELS[x][locale],
          }))}
        />
      </FormRow>
      <FormRow
        id={ids.ref}
        label={t('slip.reference')}
        required={method !== 'cash'}
        error={err('reference')}
        hint={t('slip.referenceHint')}
      >
        <Input
          id={ids.ref}
          dir="ltr"
          maxLength={120}
          autoComplete="off"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          aria-invalid={!!err('reference')}
          aria-describedby={err('reference') ? `${ids.ref}-error` : undefined}
          className={NUMBER_INPUT}
        />
      </FormRow>
      <FormRow id={ids.date} label={t('slip.paidOn')} required error={err('paidOn')}>
        <Input
          id={ids.date}
          type="date"
          dir="ltr"
          max={today}
          value={paidOn}
          onChange={(e) => setPaidOn(e.target.value)}
          aria-invalid={!!err('paidOn')}
          className={NUMBER_INPUT}
        />
      </FormRow>
    </FormDialog>
  );
}

// ------------------------------------------------------------------ salary profile

type RateField = 'monthlySalary' | 'classRate' | 'hourlyRate' | 'allowance' | 'tax' | 'csrRate';

function profileForm(p: PayProfileDto | null): ProfileForm {
  return {
    salaryType: p?.salaryType ?? 'hourly',
    currency: p?.currency ?? 'EGP',
    monthlySalary: amountInput(p?.monthlySalary),
    classRate: amountInput(p?.classRate),
    hourlyRate: amountInput(p?.hourlyRate),
    csrRate: amountInput(p?.csrRate),
    allowance: amountInput(p?.allowance),
    tax: amountInput(p?.tax),
    slotTiers: (p?.slotTiers ?? []).map((x) => ({
      minSlots: String(x.minSlots),
      amount: amountInput(x.amount),
    })),
    active: p?.active ?? true,
    notes: p?.notes ?? '',
    reason: '',
  };
}

/** Which rate fields each salary type shows first (the others stay available, default 0). */
const SHOWN: Record<SalaryType, readonly RateField[]> = {
  monthly: ['monthlySalary', 'allowance', 'tax', 'csrRate'],
  per_class: ['classRate', 'monthlySalary', 'allowance', 'tax'],
  hourly: ['hourlyRate', 'monthlySalary', 'allowance', 'tax'],
  slot: ['monthlySalary', 'allowance', 'tax'],
};

/**
 * How a person is paid (D89): salary type, currency, rates, slot tiers, allowance and tax. The
 * payout method is chosen per payment, not stored on the profile (the API has no such field).
 */
export function ProfileDialog({
  open,
  onOpenChange,
  person,
  profile,
  pickPerson,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  person: { id: number; name: string } | null;
  profile: PayProfileDto | null;
  /** New profile: a person picker (teachers and staff). */
  pickPerson?: ReactNode;
}) {
  const t = useTranslations('payroll');
  const locale = useUiLocale();
  const message = usePayrollError();
  const base = useId();
  const id = (k: string) => `${base}-${k}`;
  const [v, setV] = useState<ProfileForm>(() => profileForm(profile));
  const [touched, setTouched] = useState(false);
  const set = <K extends keyof ProfileForm>(k: K, value: ProfileForm[K]) =>
    setV((old) => ({ ...old, [k]: value }));
  const save = useSave(
    (body: Parameters<typeof savePayProfile>[1]) => savePayProfile(person!.id, body),
    () => t('profile.saved'),
    () => onOpenChange(false),
  );
  const check = validateProfile(v);
  const personMissing = !person;
  const err = (k: keyof typeof check.errors) =>
    touched && check.errors[k] ? t(`form.${check.errors[k]}`) : null;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={person && profile ? t('profile.title', { name: person.name }) : t('profile.newTitle')}
      description={t('profile.description')}
      submitLabel={t('profile.submit')}
      busy={save.isPending}
      error={save.isError ? message(save.error) : null}
      summary={touched && (!check.body || personMissing) ? t('form.fixErrors') : null}
      onSubmit={() => {
        setTouched(true);
        if (check.body && !personMissing) save.mutate(check.body);
      }}
    >
      {pickPerson}
      {!pickPerson && person && !profile && <p className="text-sm font-semibold">{person.name}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormRow id={id('type')} label={t('profile.salaryType')} required>
          <ChoiceSelect
            id={id('type')}
            value={v.salaryType}
            onChange={(x) => set('salaryType', x)}
            options={SALARY_TYPES.map((x) => ({ value: x, label: SALARY_TYPE_LABELS[x][locale] }))}
          />
        </FormRow>
        <FormRow id={id('currency')} label={t('profile.currency')} required error={err('currency')}>
          <Input
            id={id('currency')}
            dir="ltr"
            maxLength={3}
            autoComplete="off"
            value={v.currency}
            onChange={(e) => set('currency', e.target.value.toUpperCase())}
            aria-invalid={!!err('currency')}
            className={NUMBER_INPUT}
          />
        </FormRow>
        {SHOWN[v.salaryType].map((k) => (
          <FormRow
            key={k}
            id={id(k)}
            label={`${t(`profile.${k}`)} (${v.currency || '—'})`}
            required={SHOWN[v.salaryType][0] === k && v.salaryType !== 'slot'}
            error={err(k)}
          >
            <Input
              id={id(k)}
              inputMode="decimal"
              dir="ltr"
              autoComplete="off"
              value={v[k]}
              onChange={(e) => set(k, e.target.value)}
              aria-invalid={!!err(k)}
              aria-describedby={err(k) ? `${id(k)}-error` : undefined}
              className={NUMBER_INPUT}
            />
          </FormRow>
        ))}
      </div>
      {v.salaryType === 'slot' && (
        <fieldset className="flex min-w-0 flex-col gap-3">
          <legend className="mb-2 text-sm font-medium">{t('profile.tiers')}</legend>
          {v.slotTiers.map((tier, i) => (
            <div key={i} className="flex items-end gap-2">
              <FormRow id={id(`min${i}`)} label={t('profile.tierMin')} className="min-w-0 flex-1">
                <Input
                  id={id(`min${i}`)}
                  inputMode="decimal"
                  dir="ltr"
                  value={tier.minSlots}
                  onChange={(e) =>
                    set(
                      'slotTiers',
                      v.slotTiers.map((x, j) => (j === i ? { ...x, minSlots: e.target.value } : x)),
                    )
                  }
                  className={NUMBER_INPUT}
                />
              </FormRow>
              <FormRow
                id={id(`amt${i}`)}
                label={t('profile.tierAmount')}
                className="min-w-0 flex-1"
              >
                <Input
                  id={id(`amt${i}`)}
                  inputMode="decimal"
                  dir="ltr"
                  value={tier.amount}
                  onChange={(e) =>
                    set(
                      'slotTiers',
                      v.slotTiers.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)),
                    )
                  }
                  className={NUMBER_INPUT}
                />
              </FormRow>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-10"
                aria-label={t('profile.removeTier', { n: i + 1 })}
                onClick={() =>
                  set(
                    'slotTiers',
                    v.slotTiers.filter((_, j) => j !== i),
                  )
                }
              >
                <Trash2Icon />
              </Button>
            </div>
          ))}
          {err('slotTiers') && (
            <p role="alert" className="text-sm text-destructive">
              {err('slotTiers')}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={() => set('slotTiers', [...v.slotTiers, { minSlots: '', amount: '' }])}
          >
            <PlusIcon />
            {t('profile.addTier')}
          </Button>
        </fieldset>
      )}
      <div className="flex items-center gap-3">
        <Checkbox
          id={id('active')}
          checked={v.active}
          onCheckedChange={(c) => set('active', c === true)}
        />
        <Label htmlFor={id('active')}>{t('profile.active')}</Label>
      </div>
      <FormRow id={id('notes')} label={t('profile.notes')} error={err('notes')}>
        <Input
          id={id('notes')}
          dir="auto"
          maxLength={500}
          value={v.notes}
          onChange={(e) => set('notes', e.target.value)}
          className="h-10 md:text-[0.9375rem]"
        />
      </FormRow>
      {profile && (
        <FormRow id={id('reason')} label={t('profile.reason')} hint={t('profile.payoutHint')}>
          <Input
            id={id('reason')}
            dir="auto"
            maxLength={500}
            value={v.reason}
            onChange={(e) => set('reason', e.target.value)}
            className="h-10 md:text-[0.9375rem]"
          />
        </FormRow>
      )}
    </FormDialog>
  );
}
