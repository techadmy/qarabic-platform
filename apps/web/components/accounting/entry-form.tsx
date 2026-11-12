'use client';

import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent } from '@qarabic/ui/components/card';
import { FieldGroup } from '@qarabic/ui/components/field';
import { Input } from '@qarabic/ui/components/input';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Textarea } from '@qarabic/ui/components/textarea';
import { cn } from '@qarabic/ui/lib/utils';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { useCurrentUser } from '@/components/shell/app-shell';
import { ForbiddenState } from '@/components/states';
import { accountingKeys, createJournalEntry } from '@/lib/api/accounting';
import { can } from '@/lib/auth/use-me';
import {
  academyToday,
  checkJournal,
  emptyLine,
  type JournalForm,
  type JournalLineForm,
} from '@/lib/accounting/forms';
import { formatMinor } from '@/lib/billing/money';
import { useUiLocale } from '@/components/sessions/times';
import {
  AccountPicker,
  CurrencySelect,
  FormRow,
  NUMBER_INPUT,
  useAccountingError,
} from './accounting-bits';

function LineRow({
  line,
  index,
  currency,
  errors,
  onChange,
  onRemove,
  canRemove,
}: {
  line: JournalLineForm;
  index: number;
  currency: string;
  errors: { accountId?: string; amount?: string } | undefined;
  onChange: (patch: Partial<JournalLineForm>) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const t = useTranslations('accounting');
  const n = index + 1;
  const ids = { account: useId(), debit: useId(), credit: useId(), desc: useId() };
  const amountError = errors?.amount ? t(`form.${errors.amount}`) : null;
  return (
    <li
      className="grid gap-3 border-b p-4 last:border-b-0 lg:grid-cols-[minmax(14rem,2fr)_8rem_8rem_minmax(10rem,1.5fr)_auto] lg:items-start"
      aria-label={t('entry.lineN', { n })}
    >
      <FormRow
        id={ids.account}
        label={<span className="lg:sr-only">{t('fields.account')}</span>}
        error={errors?.accountId ? t(`form.${errors.accountId}`) : null}
      >
        <AccountPicker
          id={ids.account}
          value={line.accountId}
          onChange={(accountId) => onChange({ accountId })}
          currency={currency}
          invalid={!!errors?.accountId}
          ariaLabel={`${t('fields.account')} · ${t('entry.lineN', { n })}`}
        />
      </FormRow>
      <FormRow id={ids.debit} label={<span className="lg:sr-only">{t('fields.debit')}</span>}>
        <Input
          id={ids.debit}
          inputMode="decimal"
          dir="ltr"
          autoComplete="off"
          value={line.debit}
          onChange={(e) =>
            onChange({ debit: e.target.value, ...(e.target.value ? { credit: '' } : {}) })
          }
          aria-invalid={!!amountError}
          aria-label={`${t('fields.debit')} · ${t('entry.lineN', { n })}`}
          className={NUMBER_INPUT}
        />
      </FormRow>
      <FormRow
        id={ids.credit}
        label={<span className="lg:sr-only">{t('fields.credit')}</span>}
        error={amountError}
      >
        <Input
          id={ids.credit}
          inputMode="decimal"
          dir="ltr"
          autoComplete="off"
          value={line.credit}
          onChange={(e) =>
            onChange({ credit: e.target.value, ...(e.target.value ? { debit: '' } : {}) })
          }
          aria-invalid={!!amountError}
          aria-describedby={amountError ? `${ids.credit}-error` : undefined}
          aria-label={`${t('fields.credit')} · ${t('entry.lineN', { n })}`}
          className={NUMBER_INPUT}
        />
      </FormRow>
      <FormRow id={ids.desc} label={<span className="lg:sr-only">{t('fields.description')}</span>}>
        <Input
          id={ids.desc}
          dir="auto"
          maxLength={500}
          value={line.description}
          onChange={(e) => onChange({ description: e.target.value })}
          aria-label={`${t('fields.description')} · ${t('entry.lineN', { n })}`}
          className="h-10 md:text-[0.9375rem]"
        />
      </FormRow>
      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        className="justify-self-end"
        disabled={!canRemove}
        onClick={onRemove}
        aria-label={t('entry.removeLine', { n })}
      >
        <Trash2Icon />
      </Button>
    </li>
  );
}

/**
 * «قيد يومية جديد» (M7, accounting.manage): date, currency, memo, then two or more lines of
 * account + debit or credit. The running totals and the difference show while typing; the entry
 * posts only when it balances (the API checks again, with the period and the account rules).
 * Posted entries are final: a mistake is fixed by reversing it.
 */
export function EntryForm() {
  const t = useTranslations('accounting');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const router = useRouter();
  const queryClient = useQueryClient();
  const message = useAccountingError();
  const ids = { date: useId(), currency: useId(), memo: useId() };
  const [form, setForm] = useState<JournalForm>(() => ({
    date: academyToday(),
    currency: 'USD',
    memo: '',
    lines: [emptyLine(), emptyLine()],
  }));
  const [touched, setTouched] = useState(false);
  const check = checkJournal(form);
  const save = useMutation({
    mutationFn: createJournalEntry,
    onSuccess: (e) => {
      void queryClient.invalidateQueries({ queryKey: accountingKeys.all });
      toast.success(t('entry.posted', { number: e.number }));
      router.push(`/accounting/journal/${e.id}`);
    },
  });
  const back = { href: '/accounting/journal', label: t('journal.title') };
  if (!can(me, 'accounting.manage')) {
    return (
      <>
        <PageHeader title={t('entry.newTitle')} back={back} />
        <ForbiddenState />
      </>
    );
  }
  const err = (k: keyof typeof check.errors) =>
    touched && check.errors[k] ? t(`form.${check.errors[k]}`) : null;
  const setLine = (key: string, patch: Partial<JournalLineForm>) =>
    setForm((f) => ({ ...f, lines: f.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  const money = (minor: number) => formatMinor(minor, form.currency, locale);
  const { debit, credit, difference } = check.totals;

  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (check.body) save.mutate(check.body);
  }

  return (
    <form
      noValidate
      onSubmit={submit}
      className="flex flex-col gap-4"
      aria-labelledby="entry-title"
    >
      <PageHeader
        title={<span id="entry-title">{t('entry.newTitle')}</span>}
        description={t('entry.newHint')}
        back={back}
      />
      <Card className="shadow-none">
        <CardContent>
          <FieldGroup className="grid gap-4 md:grid-cols-[12rem_10rem_1fr]">
            <FormRow id={ids.date} label={t('fields.date')} required error={err('date')}>
              <Input
                id={ids.date}
                type="date"
                dir="ltr"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
                aria-invalid={!!err('date')}
                className={NUMBER_INPUT}
              />
            </FormRow>
            <FormRow
              id={ids.currency}
              label={t('fields.currency')}
              required
              error={err('currency')}
            >
              <CurrencySelect
                id={ids.currency}
                value={form.currency}
                onChange={(currency) => setForm({ ...form, currency })}
              />
            </FormRow>
            <FormRow id={ids.memo} label={t('fields.memo')} required error={err('memo')}>
              <Textarea
                id={ids.memo}
                dir="auto"
                rows={1}
                maxLength={500}
                value={form.memo}
                onChange={(e) => setForm({ ...form, memo: e.target.value })}
                aria-invalid={!!err('memo')}
                aria-describedby={err('memo') ? `${ids.memo}-error` : undefined}
                className="min-h-10 md:text-[0.9375rem]"
              />
            </FormRow>
          </FieldGroup>
        </CardContent>
      </Card>
      <Card className="gap-0 py-0 shadow-none">
        <div
          aria-hidden
          className="hidden gap-3 border-b px-4 py-2 text-sm font-semibold text-muted-foreground lg:grid lg:grid-cols-[minmax(14rem,2fr)_8rem_8rem_minmax(10rem,1.5fr)_2.5rem]"
        >
          <span>{t('fields.account')}</span>
          <span>{t('fields.debit')}</span>
          <span>{t('fields.credit')}</span>
          <span>{t('fields.description')}</span>
        </div>
        <ol aria-label={t('entry.lines')}>
          {form.lines.map((l, i) => (
            <LineRow
              key={l.key}
              line={l}
              index={i}
              currency={form.currency}
              errors={touched ? check.lineErrors[l.key] : undefined}
              onChange={(patch) => setLine(l.key, patch)}
              onRemove={() =>
                setForm({ ...form, lines: form.lines.filter((x) => x.key !== l.key) })
              }
              canRemove={form.lines.length > 2}
            />
          ))}
        </ol>
        <div className="flex flex-col gap-3 border-t p-4 sm:flex-row sm:items-center sm:justify-between">
          <Button
            type="button"
            variant="outline"
            className="h-10 self-start"
            disabled={form.lines.length >= 100}
            onClick={() => setForm({ ...form, lines: [...form.lines, emptyLine()] })}
          >
            <PlusIcon />
            {t('entry.addLine')}
          </Button>
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm" aria-live="polite">
            <div className="flex gap-2">
              <dt className="text-muted-foreground">{t('entry.totalDebit')}</dt>
              <dd className="font-semibold tabular-nums">{money(debit)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">{t('entry.totalCredit')}</dt>
              <dd className="font-semibold tabular-nums">{money(credit)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">{t('entry.difference')}</dt>
              <dd className={cn('font-bold tabular-nums', difference !== 0 && 'text-destructive')}>
                {money(Math.abs(difference))}
              </dd>
            </div>
          </dl>
        </div>
      </Card>
      {err('lines') && (
        <Alert variant="destructive" role="alert">
          <AlertCircleIcon />
          <AlertDescription>{err('lines')}</AlertDescription>
        </Alert>
      )}
      {save.isError && (
        <Alert variant="destructive" role="alert">
          <AlertCircleIcon />
          <AlertDescription>{message(save.error)}</AlertDescription>
        </Alert>
      )}
      <p aria-live="polite" className="sr-only">
        {touched && !check.body ? t('form.fixErrors') : null}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-10"
          onClick={() => router.push('/accounting/journal')}
        >
          {t('cancel')}
        </Button>
        <Button type="submit" className="h-10" disabled={save.isPending}>
          {save.isPending && <Spinner />}
          {t('entry.post')}
        </Button>
      </div>
    </form>
  );
}
