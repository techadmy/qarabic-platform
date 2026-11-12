'use client';

import {
  ACCOUNTING_ERROR_MESSAGES,
  CURRENCIES,
  JOURNAL_SOURCE_LABELS,
  VOUCHER_STATUS_LABELS,
  VOUCHER_TYPE_LABELS,
  type JournalSource,
  type LedgerAccountDto,
  type VoucherStatus,
  type VoucherType,
} from '@qarabic/shared';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  BanIcon,
  BotIcon,
  CircleCheckIcon,
  PenLineIcon,
  ReceiptTextIcon,
  Undo2Icon,
  WalletIcon,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import { Label } from '@qarabic/ui/components/label';
import { DatePicker } from '@/components/forms/date-time';
import { Combobox } from '@/components/forms/fields';
import { ToneBadge, type Tone } from '@/components/sessions/badges';
import { useUiLocale } from '@/components/sessions/times';
import { accountingKeys, fetchAccounts } from '@/lib/api/accounting';
import { isApiError } from '@/lib/api/client';

export { Money, FormRow, NUMBER_INPUT } from '@/components/billing/billing-bits';

/** «1120 · البنك»: the code first (accountants search by it), then the name in the UI language. */
export function accountLabel(
  a: { code: string; nameAr: string; nameEn: string },
  locale: 'ar' | 'en',
) {
  return `${a.code} · ${locale === 'en' ? a.nameEn : a.nameAr}`;
}

/** Accounting refusals (apps/api `accounting/errors.ts`) in the UI language. */
export function useAccountingError() {
  const t = useTranslations('accounting.errors');
  const locale = useUiLocale();
  return (error: unknown): string => {
    if (!isApiError(error)) return t('generic');
    const code = error.code ?? '';
    if (code in ACCOUNTING_ERROR_MESSAGES) {
      return ACCOUNTING_ERROR_MESSAGES[code as keyof typeof ACCOUNTING_ERROR_MESSAGES][locale];
    }
    if (error.status === 429) return t('tooMany');
    if (error.status === 404) return t('notFound');
    if (error.status === 403) return t('forbidden');
    if (error.status === 422) return t('invalid');
    return t('generic');
  };
}

const SOURCE: Record<JournalSource, { icon: LucideIcon; tone: Tone }> = {
  manual: { icon: PenLineIcon, tone: 'neutral' },
  voucher: { icon: ReceiptTextIcon, tone: 'lightBlue' },
  billing: { icon: BotIcon, tone: 'teal' },
  payroll: { icon: WalletIcon, tone: 'indigo' },
  reversal: { icon: Undo2Icon, tone: 'purple' },
};

export function SourceBadge({ source }: { source: JournalSource }) {
  const locale = useUiLocale();
  const s = SOURCE[source];
  const label = JOURNAL_SOURCE_LABELS[source];
  return <ToneBadge tone={s.tone} icon={s.icon} label={label[locale]} title={label.en} />;
}

export function VoucherTypeBadge({ type }: { type: VoucherType }) {
  const locale = useUiLocale();
  const label = VOUCHER_TYPE_LABELS[type];
  return (
    <ToneBadge
      tone={type === 'receipt' ? 'green' : 'orange'}
      icon={type === 'receipt' ? ArrowDownLeftIcon : ArrowUpRightIcon}
      label={label[locale]}
      title={label.en}
    />
  );
}

export function VoucherStatusBadge({ status }: { status: VoucherStatus }) {
  const locale = useUiLocale();
  const label = VOUCHER_STATUS_LABELS[status];
  return (
    <ToneBadge
      tone={status === 'posted' ? 'green' : 'grey'}
      icon={status === 'posted' ? CircleCheckIcon : BanIcon}
      label={label[locale]}
      title={label.en}
    />
  );
}

/** A currency code (the books are kept per currency, nothing is converted). */
export function CurrencySelect({
  id,
  value,
  onChange,
  allowAll,
  ariaLabel,
  className,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  /** Adds «كل العملات» with the empty value. */
  allowAll?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const t = useTranslations('accounting');
  const ALL = '__all__';
  return (
    <Select
      value={value || (allowAll ? ALL : '')}
      onValueChange={(v) => onChange(v === ALL ? '' : v)}
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        className={className ?? 'h-10! w-full bg-card md:text-[0.9375rem]'}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        {allowAll && <SelectItem value={ALL}>{t('allCurrencies')}</SelectItem>}
        {CURRENCIES.map((c) => (
          <SelectItem key={c} value={c}>
            <bdi>{c}</bdi>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The active, non-group accounts (`only=postable`), cached for every picker on the page. */
export function usePostableAccounts() {
  return useQuery({
    queryKey: accountingKeys.accounts({ only: 'postable' }),
    queryFn: ({ signal }) => fetchAccounts({ only: 'postable' }, signal),
    staleTime: 60_000,
  });
}

/**
 * Pick a postable account by code or name (shadcn Combobox). `filter` narrows the list (the cash
 * accounts of a voucher); accounts restricted to another currency are left out.
 */
export function AccountPicker({
  id,
  value,
  onChange,
  invalid,
  currency,
  filter,
  ariaLabel,
}: {
  id: string;
  value: number | null;
  onChange: (id: number | null) => void;
  invalid?: boolean;
  currency?: string;
  filter?: (a: LedgerAccountDto) => boolean;
  ariaLabel?: string;
}) {
  const t = useTranslations('accounting');
  const locale = useUiLocale();
  const accounts = usePostableAccounts();
  const options = (accounts.data ?? [])
    .filter((a) => !currency || !a.currency || a.currency === currency)
    .filter((a) => !filter || filter(a))
    .map((a) => ({
      value: String(a.id),
      label: accountLabel(a, locale),
      keywords: [a.code, a.nameAr, a.nameEn],
    }));
  return (
    <Combobox
      id={id}
      value={value ? String(value) : null}
      onChange={(v) => onChange(v ? Number(v) : null)}
      options={options}
      invalid={invalid}
      loading={accounts.isPending}
      ariaLabel={ariaLabel}
      placeholder={t('pickAccount')}
      searchPlaceholder={t('searchAccount')}
    />
  );
}

/**
 * A from / to pair of shadcn date pickers in a toolbar (kept in the URL as `from` / `to`): month
 * names (D32), the week from Saturday. A start after the end is said under the pair; the screen
 * does not query until it is fixed.
 */
export function DateRangeFilters({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (v: { from?: string | null; to?: string | null }) => void;
}) {
  const t = useTranslations('accounting');
  const ids = { from: useId(), to: useId(), error: useId() };
  const bad = !!from && !!to && from > to;
  return (
    <>
      <div className="flex min-w-40 flex-col gap-2">
        <Label htmlFor={ids.from} className="text-sm text-muted-foreground">
          {t('from')}
        </Label>
        <DatePicker
          id={ids.from}
          value={from}
          invalid={bad}
          onChange={(v) => onChange({ from: v || null })}
        />
      </div>
      <div className="flex min-w-40 flex-col gap-2">
        <Label htmlFor={ids.to} className="text-sm text-muted-foreground">
          {t('to')}
        </Label>
        <DatePicker
          id={ids.to}
          value={to}
          invalid={bad}
          onChange={(v) => onChange({ to: v || null })}
        />
      </div>
      {bad && (
        <p id={ids.error} role="alert" className="basis-full text-sm text-destructive">
          {t('badRange')}
        </p>
      )}
    </>
  );
}

/**
 * A field error key as copy: `server.*` keys come from a 422 and use the shared `validation`
 * messages; the others are the accounting form's own (`accounting.form.*`).
 */
export function useFormMessage() {
  const t = useTranslations('accounting.form');
  const tv = useTranslations('validation');
  return (key: string) => (key.startsWith('server.') ? tv(key.slice(7)) : t(key));
}
