'use client';

import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent } from '@qarabic/ui/components/card';
import { FieldGroup } from '@qarabic/ui/components/field';
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
import { Input } from '@qarabic/ui/components/input';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Textarea } from '@qarabic/ui/components/textarea';
import { cn } from '@qarabic/ui/lib/utils';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent, type MouseEvent } from 'react';
import { DatePicker } from '@/components/forms/date-time';
import { useBeforeUnload } from '@/lib/forms/use-unsaved-guard';
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
  serverFieldErrors,
  type JournalForm,
  type JournalLineForm,
  type PlacedErrors,
} from '@/lib/accounting/forms';
import { formatMinor } from '@/lib/billing/money';
import { useUiLocale } from '@/components/sessions/times';
import {
  AccountPicker,
  CurrencySelect,
  FormRow,
  NUMBER_INPUT,
  useAccountingError,
  useFormMessage,
} from './accounting-bits';

function LineRow({
  line,
  index,
  currency,
  errors,
  onChange,
  onRemove,
}: {
  line: JournalLineForm;
  index: number;
  currency: string;
  errors: { accountId?: string; amount?: string; description?: string } | undefined;
  onChange: (patch: Partial<JournalLineForm>) => void;
  onRemove: () => void;
}) {
  const t = useTranslations('accounting');
  const msg = useFormMessage();
  const n = index + 1;
  const of = (field: string) => t('entry.fieldOfLine', { field: t(`fields.${field}`), n });
  const ids = { account: useId(), debit: useId(), credit: useId(), desc: useId() };
  const amountError = errors?.amount ? msg(errors.amount) : null;
  return (
    <li
      className="grid gap-3 border-b p-4 last:border-b-0 lg:grid-cols-[minmax(14rem,2fr)_8rem_8rem_minmax(10rem,1.5fr)_auto] lg:items-start"
      aria-label={t('entry.lineN', { n })}
    >
      <FormRow
        id={ids.account}
        label={<span className="lg:sr-only">{t('fields.account')}</span>}
        error={errors?.accountId ? msg(errors.accountId) : null}
      >
        <AccountPicker
          id={ids.account}
          value={line.accountId}
          onChange={(accountId) => onChange({ accountId })}
          currency={currency}
          invalid={!!errors?.accountId}
          ariaLabel={of('account')}
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
          aria-label={of('debit')}
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
          aria-label={of('credit')}
          className={NUMBER_INPUT}
        />
      </FormRow>
      <FormRow
        id={ids.desc}
        label={<span className="lg:sr-only">{t('fields.description')}</span>}
        error={errors?.description ? msg(errors.description) : null}
      >
        <Input
          id={ids.desc}
          dir="auto"
          maxLength={500}
          value={line.description}
          onChange={(e) => onChange({ description: e.target.value })}
          aria-label={of('description')}
          className="h-10 md:text-[0.9375rem]"
        />
      </FormRow>
      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        className="justify-self-end"
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
  const [server, setServer] = useState<PlacedErrors | null>(null);
  const [leaving, setLeaving] = useState(false);
  const msg = useFormMessage();
  const check = checkJournal(form);
  const dirty =
    !!form.memo.trim() ||
    form.lines.some(
      (l) => l.accountId || l.debit.trim() || l.credit.trim() || l.description.trim(),
    );
  useBeforeUnload(dirty);
  const edit = (next: JournalForm) => {
    setServer(null);
    setForm(next);
  };
  const save = useMutation({
    mutationFn: createJournalEntry,
    onSuccess: (e) => {
      void queryClient.invalidateQueries({ queryKey: accountingKeys.all });
      toast.success(t('entry.posted', { number: e.number }));
      router.push(`/accounting/journal/${e.id}`);
    },
    onError: (e) => setServer(serverFieldErrors(e, check.lineKeys)),
  });
  const leave = (event?: MouseEvent<HTMLAnchorElement>) => {
    if (!dirty) return router.push('/accounting/journal');
    event?.preventDefault();
    setLeaving(true);
  };
  const back = { href: '/accounting/journal', label: t('journal.title'), onClick: leave };
  if (!can(me, 'accounting.manage')) {
    return (
      <>
        <PageHeader title={t('entry.newTitle')} back={back} />
        <ForbiddenState />
      </>
    );
  }
  const err = (k: keyof typeof check.errors) => {
    const key = touched ? (check.errors[k] ?? server?.errors[k]) : server?.errors[k];
    return key ? msg(key) : null;
  };
  const setLine = (key: string, patch: Partial<JournalLineForm>) => {
    setServer(null);
    setForm((f) => ({ ...f, lines: f.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  };
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
              <DatePicker
                id={ids.date}
                value={form.date}
                onChange={(date) => edit({ ...form, date })}
                invalid={!!err('date')}
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
                onChange={(currency) => edit({ ...form, currency })}
              />
            </FormRow>
            <FormRow id={ids.memo} label={t('fields.memo')} required error={err('memo')}>
              <Textarea
                id={ids.memo}
                dir="auto"
                rows={1}
                maxLength={500}
                value={form.memo}
                onChange={(e) => edit({ ...form, memo: e.target.value })}
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
              errors={
                touched || server
                  ? { ...(touched ? check.lineErrors[l.key] : {}), ...server?.lineErrors[l.key] }
                  : undefined
              }
              onChange={(patch) => setLine(l.key, patch)}
              onRemove={() =>
                // An entry needs two lines: say so instead of a dead button.
                form.lines.length > 2
                  ? edit({ ...form, lines: form.lines.filter((x) => x.key !== l.key) })
                  : toast.info(t('entry.minLines'))
              }
            />
          ))}
        </ol>
        <div className="flex flex-col gap-3 border-t p-4 sm:flex-row sm:items-center sm:justify-between">
          <Button
            type="button"
            variant="outline"
            className="h-10 self-start"
            onClick={() =>
              form.lines.length >= 100
                ? toast.info(t('entry.maxLines'))
                : edit({ ...form, lines: [...form.lines, emptyLine()] })
            }
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
      {save.isError && !server && (
        <Alert variant="destructive" role="alert">
          <AlertCircleIcon />
          <AlertDescription>{message(save.error)}</AlertDescription>
        </Alert>
      )}
      <p aria-live="polite" className="sr-only">
        {touched && !check.body ? t('form.fixErrors') : null}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" className="h-10" onClick={() => leave()}>
          {t('cancel')}
        </Button>
        <Button type="submit" className="h-10" disabled={save.isPending}>
          {save.isPending && <Spinner />}
          {t('entry.post')}
        </Button>
      </div>
      <AlertDialog open={leaving} onOpenChange={setLeaving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('entry.discardTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('entry.discardHint')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('entry.keepEditing')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => router.push('/accounting/journal')}
            >
              {t('entry.discard')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
