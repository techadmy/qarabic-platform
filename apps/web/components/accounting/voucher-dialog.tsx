'use client';

import { VOUCHER_TYPE_LABELS, type VoucherType } from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Input } from '@qarabic/ui/components/input';
import { ToggleGroup, ToggleGroupItem } from '@qarabic/ui/components/toggle-group';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { DatePicker } from '@/components/forms/date-time';
import { toast } from 'sonner';
import { FormDialog } from '@/components/payroll/payroll-bits';
import { useUiLocale } from '@/components/sessions/times';
import { accountingKeys, createVoucher } from '@/lib/api/accounting';
import {
  academyToday,
  checkVoucher,
  emptyVoucherLine,
  type VoucherForm,
  serverFieldErrors,
  type PlacedErrors,
  type VoucherLineForm,
} from '@/lib/accounting/forms';
import { formatMinor } from '@/lib/billing/money';
import { useDirection } from '@/lib/use-direction';
import {
  AccountPicker,
  CurrencySelect,
  FormRow,
  NUMBER_INPUT,
  useAccountingError,
  useFormMessage,
} from './accounting-bits';

function VoucherLine({
  line,
  index,
  currency,
  type,
  errors,
  onChange,
  onRemove,
}: {
  line: VoucherLineForm;
  index: number;
  currency: string;
  type: VoucherType;
  errors: { accountId?: string; amount?: string } | undefined;
  onChange: (patch: Partial<VoucherLineForm>) => void;
  onRemove: () => void;
}) {
  const t = useTranslations('accounting');
  const msg = useFormMessage();
  const n = index + 1;
  const ids = { account: useId(), amount: useId(), desc: useId() };
  return (
    <li className="flex flex-col gap-3 rounded-lg border p-3" aria-label={t('entry.lineN', { n })}>
      <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
        <FormRow
          id={ids.account}
          label={type === 'payment' ? t('voucher.expenseAccount') : t('voucher.incomeAccount')}
          required
          error={errors?.accountId ? msg(errors.accountId) : null}
        >
          <AccountPicker
            id={ids.account}
            value={line.accountId}
            onChange={(accountId) => onChange({ accountId })}
            currency={currency}
            filter={(a) => !a.isCash}
            invalid={!!errors?.accountId}
          />
        </FormRow>
        <FormRow
          id={ids.amount}
          label={t('fields.amount')}
          required
          error={errors?.amount ? msg(errors.amount) : null}
        >
          <Input
            id={ids.amount}
            inputMode="decimal"
            dir="ltr"
            autoComplete="off"
            value={line.amount}
            onChange={(e) => onChange({ amount: e.target.value })}
            aria-invalid={!!errors?.amount}
            aria-describedby={errors?.amount ? `${ids.amount}-error` : undefined}
            className={NUMBER_INPUT}
          />
        </FormRow>
      </div>
      <div className="flex items-end gap-2">
        <FormRow id={ids.desc} label={t('fields.description')} className="flex-1">
          <Input
            id={ids.desc}
            dir="auto"
            maxLength={500}
            value={line.description}
            onChange={(e) => onChange({ description: e.target.value })}
            className="h-10 md:text-[0.9375rem]"
          />
        </FormRow>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          onClick={onRemove}
          aria-label={t('entry.removeLine', { n })}
        >
          <Trash2Icon />
        </Button>
      </div>
    </li>
  );
}

/**
 * «سند قبض» / «سند صرف» (M7, docs/07 §أ.3; the old Receipts & Payments): who paid or was paid, from
 * or into which cash / bank / wallet account, against one or more accounts. Posting writes the
 * journal entry; a voucher is never edited, it is voided with a reason.
 */
export function VoucherDialog({
  open,
  onOpenChange,
  defaultType = 'payment',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultType?: VoucherType;
}) {
  const t = useTranslations('accounting');
  const locale = useUiLocale();
  const dir = useDirection();
  const router = useRouter();
  const queryClient = useQueryClient();
  const message = useAccountingError();
  const ids = {
    type: useId(),
    date: useId(),
    currency: useId(),
    cash: useId(),
    party: useId(),
    description: useId(),
    reference: useId(),
    cheque: useId(),
  };
  const [form, setForm] = useState<VoucherForm>(() => ({
    type: defaultType,
    date: academyToday(),
    currency: 'USD',
    cashAccountId: null,
    party: '',
    description: '',
    reference: '',
    chequeNumber: '',
    lines: [emptyVoucherLine()],
  }));
  const [touched, setTouched] = useState(false);
  const [server, setServer] = useState<PlacedErrors | null>(null);
  const msg = useFormMessage();
  const check = checkVoucher(form);
  const save = useMutation({
    mutationFn: createVoucher,
    onSuccess: (v) => {
      void queryClient.invalidateQueries({ queryKey: accountingKeys.all });
      toast.success(t('voucher.posted', { number: v.number }));
      onOpenChange(false);
      router.push(`/accounting/vouchers/${v.id}`);
    },
    onError: (e) => setServer(serverFieldErrors(e, check.lineKeys)),
  });
  const err = (k: string) => {
    const key = (touched ? check.errors[k] : undefined) ?? server?.errors[k];
    return key ? msg(key) : null;
  };
  const set = (patch: Partial<VoucherForm>) => {
    setServer(null);
    setForm((f) => ({ ...f, ...patch }));
  };
  const setLine = (key: string, patch: Partial<VoucherLineForm>) => {
    setServer(null);
    setForm((f) => ({ ...f, lines: f.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  };
  const receipt = form.type === 'receipt';

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={receipt ? t('voucher.newReceipt') : t('voucher.newPayment')}
      description={receipt ? t('voucher.receiptHint') : t('voucher.paymentHint')}
      submitLabel={t('voucher.post', { amount: formatMinor(check.total, form.currency, locale) })}
      busy={save.isPending}
      error={save.isError && !server ? message(save.error) : null}
      summary={touched && !check.body ? t('form.fixErrors') : null}
      onSubmit={() => {
        setTouched(true);
        if (check.body) save.mutate(check.body);
      }}
    >
      <fieldset className="flex flex-col gap-2">
        <legend id={ids.type} className="mb-1 font-semibold">
          {t('voucher.type')}
        </legend>
        <ToggleGroup
          type="single"
          variant="outline"
          dir={dir}
          aria-labelledby={ids.type}
          value={form.type}
          onValueChange={(v) => v && set({ type: v as VoucherType })}
          className="w-full"
        >
          {(['payment', 'receipt'] as const).map((v) => (
            <ToggleGroupItem key={v} value={v} className="h-10 flex-1">
              {VOUCHER_TYPE_LABELS[v][locale]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormRow id={ids.date} label={t('fields.date')} required error={err('date')}>
          <DatePicker
            id={ids.date}
            value={form.date}
            onChange={(date) => set({ date })}
            invalid={!!err('date')}
          />
        </FormRow>
        <FormRow id={ids.currency} label={t('fields.currency')} required error={err('currency')}>
          <CurrencySelect
            id={ids.currency}
            value={form.currency}
            onChange={(currency) => set({ currency })}
          />
        </FormRow>
      </div>
      <FormRow
        id={ids.cash}
        label={receipt ? t('voucher.cashIn') : t('voucher.cashOut')}
        required
        error={err('cashAccountId')}
      >
        <AccountPicker
          id={ids.cash}
          value={form.cashAccountId}
          onChange={(cashAccountId) => set({ cashAccountId })}
          currency={form.currency}
          filter={(a) => a.isCash}
          invalid={!!err('cashAccountId')}
        />
      </FormRow>
      <FormRow
        id={ids.party}
        label={receipt ? t('voucher.payer') : t('voucher.payee')}
        required
        error={err('party')}
      >
        <Input
          id={ids.party}
          dir="auto"
          maxLength={160}
          value={form.party}
          onChange={(e) => set({ party: e.target.value })}
          aria-invalid={!!err('party')}
          aria-describedby={err('party') ? `${ids.party}-error` : undefined}
          className="h-10 md:text-[0.9375rem]"
        />
      </FormRow>
      <FormRow
        id={ids.description}
        label={t('fields.description')}
        required
        error={err('description')}
      >
        <Input
          id={ids.description}
          dir="auto"
          maxLength={500}
          value={form.description}
          onChange={(e) => set({ description: e.target.value })}
          aria-invalid={!!err('description')}
          aria-describedby={err('description') ? `${ids.description}-error` : undefined}
          className="h-10 md:text-[0.9375rem]"
        />
      </FormRow>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormRow id={ids.reference} label={t('voucher.reference')}>
          <Input
            id={ids.reference}
            dir="auto"
            maxLength={80}
            value={form.reference}
            onChange={(e) => set({ reference: e.target.value })}
            className="h-10 md:text-[0.9375rem]"
          />
        </FormRow>
        <FormRow id={ids.cheque} label={t('voucher.cheque')}>
          <Input
            id={ids.cheque}
            dir="ltr"
            maxLength={40}
            value={form.chequeNumber}
            onChange={(e) => set({ chequeNumber: e.target.value })}
            className={NUMBER_INPUT}
          />
        </FormRow>
      </div>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 font-semibold">{t('voucher.lines')}</legend>
        <ol className="flex flex-col gap-3">
          {form.lines.map((l, i) => (
            <VoucherLine
              key={l.key}
              line={l}
              index={i}
              currency={form.currency}
              type={form.type}
              errors={
                touched || server
                  ? { ...(touched ? check.lineErrors[l.key] : {}), ...server?.lineErrors[l.key] }
                  : undefined
              }
              onChange={(patch) => setLine(l.key, patch)}
              onRemove={() =>
                form.lines.length > 1
                  ? set({ lines: form.lines.filter((x) => x.key !== l.key) })
                  : toast.info(t('voucher.minLines'))
              }
            />
          ))}
        </ol>
        {err('lines') && (
          <p role="alert" className="text-sm text-destructive">
            {err('lines')}
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          className="h-10 self-start"
          onClick={() =>
            form.lines.length >= 50
              ? toast.info(t('voucher.maxLines'))
              : set({ lines: [...form.lines, emptyVoucherLine()] })
          }
        >
          <PlusIcon />
          {t('entry.addLine')}
        </Button>
      </fieldset>
    </FormDialog>
  );
}
