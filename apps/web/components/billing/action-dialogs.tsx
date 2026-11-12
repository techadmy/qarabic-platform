'use client';

import {
  MANUAL_PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  type InvoiceDetailDto,
  type ManualPaymentMethod,
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
import { FieldGroup } from '@qarabic/ui/components/field';
import { Input } from '@qarabic/ui/components/input';
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
import { cn } from '@qarabic/ui/lib/utils';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useUiLocale } from '@/components/sessions/times';
import {
  addInvoiceLine,
  billingKeys,
  createInvoice,
  recordPayment,
  splitInvoice,
} from '@/lib/api/billing';
import {
  validateLine,
  validateManualInvoice,
  validatePayment,
  validateSplit,
  type LineForm,
  type SplitPart,
} from '@/lib/billing/forms';
import { ACADEMY_TZ } from '@/lib/billing/labels';
import { amountInput, evenParts, formatMinor, minorOf, toAmount } from '@/lib/billing/money';
import { addDays, dateKeyIn } from '@/lib/schedule-time';
import { FormRow, Money, NUMBER_INPUT, useBillingError } from './billing-bits';

/**
 * Billing action dialogs (docs/20 §12, the current app's `ActionDialogs`): record a manual
 * payment, an adjustment or a discount, split an invoice, a manual invoice. Each names its action
 * on the button, validates on submit (errors under the fields and an `aria-live` summary), keeps
 * the input on a refusal and shows the API's reason in the UI language (D31, docs/15 §5.6).
 */
function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  busy,
  error,
  summary,
  onSubmit,
  wide,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  /** Shown in the live region after a submit with errors. */
  summary: string | null;
  onSubmit: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const t = useTranslations('billing.form');
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        className={cn('max-h-[90svh] overflow-y-auto', wide ? 'sm:max-w-xl' : 'sm:max-w-md')}
        showCloseButton={false}
      >
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <FieldGroup className="gap-4">{children}</FieldGroup>
          <p aria-live="polite" className="sr-only">
            {summary}
          </p>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertCircleIcon />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                {t('cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy && <Spinner />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function useInvoiceMutation<V, R>(fn: (v: V) => Promise<R>, done: string, onDone: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: billingKeys.all });
      toast.success(done);
      onDone();
    },
  });
}

const academyToday = () => dateKeyIn(ACADEMY_TZ);

// ------------------------------------------------------------------ record a payment

/** Cash, bank transfer, cheque or other; partial allowed; date received ≤ today (docs/20 §7.4). */
export function RecordPaymentDialog({
  invoice,
  open,
  onOpenChange,
}: {
  invoice: InvoiceDetailDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('billing.form');
  const tp = useTranslations('billing.payment');
  const locale = useUiLocale();
  const message = useBillingError();
  const ids = { method: useId(), amount: useId(), date: useId(), ref: useId(), note: useId() };
  const today = academyToday();
  const [method, setMethod] = useState<ManualPaymentMethod>('bank_transfer');
  // The full balance by default: most payments settle the invoice (one field less to type).
  const [amount, setAmount] = useState(() => amountInput(invoice.balance));
  const [receivedOn, setReceivedOn] = useState(today);
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const save = useInvoiceMutation(
    (body: Parameters<typeof recordPayment>[1]) => recordPayment(invoice.id, body),
    tp('saved'),
    () => onOpenChange(false),
  );
  const balance = minorOf(invoice.balance);
  const check = validatePayment(
    { method, amount, receivedOn, reference, note },
    { balanceMinor: balance, today },
  );
  const err = (k: 'amount' | 'receivedOn') =>
    touched && check.errors[k]
      ? t(check.errors[k], { balance: formatMinor(balance, invoice.currency, locale) })
      : null;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={tp('title', { number: invoice.number ?? '' })}
      description={
        <>
          {tp('balance')}: <Money amount={invoice.balance} currency={invoice.currency} strong />
        </>
      }
      submitLabel={tp('submit')}
      busy={save.isPending}
      error={save.isError ? message(save.error) : null}
      summary={touched && !check.body ? t('fixErrors') : null}
      onSubmit={() => {
        setTouched(true);
        if (check.body) save.mutate(check.body);
      }}
    >
      <FormRow id={ids.method} label={tp('method')} required>
        <Select value={method} onValueChange={(v) => setMethod(v as ManualPaymentMethod)}>
          <SelectTrigger id={ids.method} className="h-10! w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {MANUAL_PAYMENT_METHODS.map((m) => (
              <SelectItem key={m} value={m}>
                {PAYMENT_METHOD_LABELS[m][locale]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormRow>
      <FormRow
        id={ids.amount}
        label={tp('amount', { currency: invoice.currency })}
        required
        error={err('amount')}
        hint={tp('partialHint')}
      >
        <Input
          id={ids.amount}
          inputMode="decimal"
          dir="ltr"
          autoComplete="off"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-invalid={!!err('amount')}
          aria-required
          className={NUMBER_INPUT}
        />
      </FormRow>
      <FormRow id={ids.date} label={tp('receivedOn')} required error={err('receivedOn')}>
        <Input
          id={ids.date}
          type="date"
          dir="ltr"
          max={today}
          value={receivedOn}
          onChange={(e) => setReceivedOn(e.target.value)}
          aria-invalid={!!err('receivedOn')}
          aria-required
          className={NUMBER_INPUT}
        />
      </FormRow>
      <FormRow id={ids.ref} label={tp('reference')}>
        <Input
          id={ids.ref}
          dir="auto"
          maxLength={191}
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          className="h-10 md:text-[0.9375rem]"
        />
      </FormRow>
      <FormRow id={ids.note} label={tp('note')}>
        <Textarea
          id={ids.note}
          dir="auto"
          rows={2}
          maxLength={1000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="md:text-[0.9375rem]"
        />
      </FormRow>
    </FormDialog>
  );
}

// ------------------------------------------------------------------ adjustment / discount

/** A new line with a required reason (D83): adjustment ±, discount by amount or percent. */
export function LineDialog({
  invoice,
  kind,
  open,
  onOpenChange,
}: {
  invoice: InvoiceDetailDto;
  kind: 'adjustment' | 'discount';
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('billing.form');
  const ta = useTranslations('billing.adjust');
  const message = useBillingError();
  const ids = { value: useId(), reason: useId() };
  const [v, setV] = useState<LineForm>({ mode: 'amount', sign: 'add', value: '', reason: '' });
  const [touched, setTouched] = useState(false);
  const save = useInvoiceMutation(
    (body: Parameters<typeof addInvoiceLine>[1]) => addInvoiceLine(invoice.id, body),
    ta('saved'),
    () => onOpenChange(false),
  );
  const check = validateLine(kind, v);
  const err = (k: 'value' | 'reason') => (touched && check.errors[k] ? t(check.errors[k]) : null);
  const percent = kind === 'discount' && v.mode === 'percent';
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={ta(kind === 'discount' ? 'discountTitle' : 'adjustTitle')}
      description={ta('hint')}
      submitLabel={ta(kind === 'discount' ? 'discountSubmit' : 'adjustSubmit')}
      busy={save.isPending}
      error={save.isError ? message(save.error) : null}
      summary={touched && !check.body ? t('fixErrors') : null}
      onSubmit={() => {
        setTouched(true);
        if (check.body) save.mutate(check.body);
      }}
    >
      <ToggleGroup
        type="single"
        variant="outline"
        spacing={0}
        aria-label={ta(kind === 'discount' ? 'mode' : 'direction')}
        value={kind === 'discount' ? v.mode : v.sign}
        onValueChange={(x) => {
          if (!x) return;
          setV((s) =>
            kind === 'discount'
              ? { ...s, mode: x as LineForm['mode'] }
              : { ...s, sign: x as LineForm['sign'] },
          );
        }}
        className="self-start"
      >
        {(kind === 'discount'
          ? (['amount', 'percent'] as const)
          : (['add', 'subtract'] as const)
        ).map((x) => (
          <ToggleGroupItem
            key={x}
            value={x}
            className="h-9 px-4 data-[state=on]:bg-accent data-[state=on]:font-semibold data-[state=on]:text-accent-foreground"
          >
            {ta(`toggle.${x}`)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <FormRow
        id={ids.value}
        label={percent ? ta('percentLabel') : ta('amountLabel', { currency: invoice.currency })}
        required
        error={err('value')}
      >
        <Input
          id={ids.value}
          inputMode="decimal"
          dir="ltr"
          autoComplete="off"
          value={v.value}
          onChange={(e) => setV((s) => ({ ...s, value: e.target.value }))}
          aria-invalid={!!err('value')}
          aria-required
          className={NUMBER_INPUT}
        />
      </FormRow>
      <FormRow
        id={ids.reason}
        label={t('reason')}
        required
        error={err('reason')}
        hint={t('reasonHint')}
      >
        <Textarea
          id={ids.reason}
          dir="auto"
          rows={2}
          maxLength={500}
          value={v.reason}
          onChange={(e) => setV((s) => ({ ...s, reason: e.target.value }))}
          aria-invalid={!!err('reason')}
          aria-required
          className="md:text-[0.9375rem]"
        />
      </FormRow>
    </FormDialog>
  );
}

// ------------------------------------------------------------------ split

/** An issued invoice with nothing paid → 2–6 instalments that add up to its total (docs/20 §4.5). */
export function SplitDialog({
  invoice,
  open,
  onOpenChange,
}: {
  invoice: InvoiceDetailDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('billing.form');
  const ts = useTranslations('billing.split');
  const locale = useUiLocale();
  const message = useBillingError();
  const reasonId = useId();
  const baseId = useId();
  const today = academyToday();
  const total = minorOf(invoice.total);
  const firstDue =
    invoice.dueDate && invoice.dueDate >= today ? invoice.dueDate : addDays(today, 7);
  const [parts, setParts] = useState<SplitPart[]>(() =>
    evenParts(total, 2).map((m, i) => ({
      amount: toAmount(m),
      dueDate: addDays(firstDue, i * 30),
    })),
  );
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const save = useInvoiceMutation(
    (body: Parameters<typeof splitInvoice>[1]) => splitInvoice(invoice.id, body),
    ts('saved'),
    () => onOpenChange(false),
  );
  const check = validateSplit(parts, reason, { totalMinor: total, today });
  const set = (i: number, patch: Partial<SplitPart>) =>
    setParts((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const sumText = ts('sum', {
    sum: formatMinor(check.sumMinor, invoice.currency, locale),
    total: formatMinor(total, invoice.currency, locale),
  });
  return (
    <FormDialog
      wide
      open={open}
      onOpenChange={onOpenChange}
      title={ts('title', { number: invoice.number ?? '' })}
      description={ts('hint')}
      submitLabel={ts('submit', { count: parts.length })}
      busy={save.isPending}
      error={save.isError ? message(save.error) : null}
      summary={touched && !check.body ? t('fixErrors') : null}
      onSubmit={() => {
        setTouched(true);
        if (check.body) save.mutate(check.body);
      }}
    >
      <ol className="flex flex-col gap-3">
        {parts.map((p, i) => {
          const pe = touched ? check.partErrors[i] : undefined;
          return (
            <li key={i} className="grid grid-cols-1 items-start gap-3 sm:grid-cols-[1fr_1fr_auto]">
              <FormRow
                id={`${baseId}-a${i}`}
                label={ts('part', { n: i + 1 })}
                required
                error={pe?.amount ? t(pe.amount) : null}
              >
                <Input
                  id={`${baseId}-a${i}`}
                  inputMode="decimal"
                  dir="ltr"
                  autoComplete="off"
                  value={p.amount}
                  onChange={(e) => set(i, { amount: e.target.value })}
                  aria-invalid={!!pe?.amount}
                  className={NUMBER_INPUT}
                />
              </FormRow>
              <FormRow
                id={`${baseId}-d${i}`}
                label={ts('dueDate', { n: i + 1 })}
                required
                error={pe?.dueDate ? t(pe.dueDate) : null}
              >
                <Input
                  id={`${baseId}-d${i}`}
                  type="date"
                  dir="ltr"
                  min={today}
                  value={p.dueDate}
                  onChange={(e) => set(i, { dueDate: e.target.value })}
                  aria-invalid={!!pe?.dueDate}
                  className={NUMBER_INPUT}
                />
              </FormRow>
              {parts.length > 2 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-10 sm:mt-6"
                  aria-label={ts('remove', { n: i + 1 })}
                  onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))}
                >
                  <Trash2Icon />
                </Button>
              ) : (
                <span className="hidden sm:block sm:w-10" aria-hidden />
              )}
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {parts.length < 6 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setParts((ps) => [
                ...ps,
                { amount: '', dueDate: addDays(ps[ps.length - 1]?.dueDate || today, 30) },
              ])
            }
          >
            <PlusIcon />
            {ts('add')}
          </Button>
        ) : (
          <span />
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() =>
            setParts((ps) =>
              evenParts(total, ps.length).map((m, i) => ({ ...ps[i]!, amount: toAmount(m) })),
            )
          }
        >
          {ts('even')}
        </Button>
      </div>
      <p
        className={cn(
          'text-sm',
          touched && check.errors.parts === 'splitSum'
            ? 'font-semibold text-destructive'
            : 'text-muted-foreground',
        )}
        role={touched && check.errors.parts ? 'alert' : undefined}
      >
        {touched && check.errors.parts === 'splitSum'
          ? t('splitSum', { total: formatMinor(total, invoice.currency, locale) })
          : sumText}
      </p>
      <FormRow
        id={reasonId}
        label={t('reason')}
        required
        error={touched && check.errors.reason ? t(check.errors.reason) : null}
        hint={t('reasonHint')}
      >
        <Textarea
          id={reasonId}
          dir="auto"
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-invalid={touched && !!check.errors.reason}
          aria-required
          className="md:text-[0.9375rem]"
        />
      </FormRow>
    </FormDialog>
  );
}

// ------------------------------------------------------------------ manual invoice

/** One manual invoice for a family: billing issues it at once, customer service saves a draft (D87). */
export function ManualInvoiceDialog({
  familyId,
  currency,
  canIssue,
  open,
  onOpenChange,
}: {
  familyId: number;
  currency: string;
  canIssue: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('billing.form');
  const tm = useTranslations('billing.manual');
  const message = useBillingError();
  const ids = { desc: useId(), amount: useId(), due: useId() };
  const today = academyToday();
  const [v, setV] = useState({ description: '', amount: '', dueDate: addDays(today, 7) });
  const [touched, setTouched] = useState(false);
  const save = useInvoiceMutation(
    (body: Parameters<typeof createInvoice>[0]) => createInvoice(body),
    tm(canIssue ? 'issued' : 'drafted'),
    () => onOpenChange(false),
  );
  const check = validateManualInvoice(familyId, v, { today, issue: canIssue });
  const err = (k: 'description' | 'amount' | 'dueDate') =>
    touched && check.errors[k] ? t(check.errors[k]) : null;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={tm('title')}
      description={canIssue ? tm('issueHint') : tm('draftHint')}
      submitLabel={tm(canIssue ? 'issue' : 'draft')}
      busy={save.isPending}
      error={save.isError ? message(save.error) : null}
      summary={touched && !check.body ? t('fixErrors') : null}
      onSubmit={() => {
        setTouched(true);
        if (check.body) save.mutate(check.body);
      }}
    >
      <FormRow id={ids.desc} label={tm('description')} required error={err('description')}>
        <Input
          id={ids.desc}
          dir="auto"
          maxLength={500}
          value={v.description}
          onChange={(e) => setV((s) => ({ ...s, description: e.target.value }))}
          aria-invalid={!!err('description')}
          aria-required
          className="h-10 md:text-[0.9375rem]"
        />
      </FormRow>
      <FormRow id={ids.amount} label={tm('amount', { currency })} required error={err('amount')}>
        <Input
          id={ids.amount}
          inputMode="decimal"
          dir="ltr"
          autoComplete="off"
          value={v.amount}
          onChange={(e) => setV((s) => ({ ...s, amount: e.target.value }))}
          aria-invalid={!!err('amount')}
          aria-required
          className={NUMBER_INPUT}
        />
      </FormRow>
      <FormRow id={ids.due} label={tm('dueDate')} required error={err('dueDate')}>
        <Input
          id={ids.due}
          type="date"
          dir="ltr"
          min={today}
          value={v.dueDate}
          onChange={(e) => setV((s) => ({ ...s, dueDate: e.target.value }))}
          aria-invalid={!!err('dueDate')}
          aria-required
          className={NUMBER_INPUT}
        />
      </FormRow>
    </FormDialog>
  );
}
