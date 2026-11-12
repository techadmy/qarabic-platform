'use client';

import {
  BILLING_ERROR_MESSAGES,
  INVOICE_STATUS_LABELS,
  INVOICE_TAB_LABELS,
  PAYMENT_STATUS_LABELS,
  type InvoiceStatus,
  type PaymentStatus,
} from '@qarabic/shared';
import { Field, FieldError, FieldLabel } from '@qarabic/ui/components/field';
import { cn } from '@qarabic/ui/lib/utils';
import {
  AlarmClockIcon,
  BanIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  CircleMinusIcon,
  CircleXIcon,
  FilePenLineIcon,
  HourglassIcon,
  SplitIcon,
  Undo2Icon,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { ToneBadge, type Tone } from '@/components/sessions/badges';
import { useUiLocale } from '@/components/sessions/times';
import { isApiError } from '@/lib/api/client';
import { moneyChunks } from '@/lib/billing/money';

/**
 * An amount in its currency: tabular figures, never wrapped, the number and the symbol each
 * isolated so the order holds in right-to-left text (docs/15 §5.13): "60.00 US$" in Arabic,
 * "US$60.00" in English.
 */
export function Money({
  amount,
  currency,
  strong,
  className,
}: {
  amount: string;
  currency: string | null | undefined;
  strong?: boolean;
  className?: string;
}) {
  const locale = useUiLocale();
  const chunks = moneyChunks(amount, currency, locale);
  return (
    <bdi
      dir={locale === 'ar' ? 'rtl' : 'ltr'}
      className={cn('whitespace-nowrap tabular-nums', strong && 'font-bold', className)}
    >
      {chunks
        ? chunks.map((c, i) =>
            c.kind === 'num' ? (
              <bdi key={i} dir="ltr">
                {c.text}
              </bdi>
            ) : c.kind === 'cur' ? (
              <bdi key={i}>{c.text}</bdi>
            ) : (
              c.text
            ),
          )
        : amount}
    </bdi>
  );
}

const STATUS: Record<InvoiceStatus, { icon: LucideIcon; tone: Tone }> = {
  draft: { icon: FilePenLineIcon, tone: 'grey' },
  issued: { icon: CircleIcon, tone: 'lightBlue' },
  partially_paid: { icon: CircleDotIcon, tone: 'amber' },
  paid: { icon: CircleCheckIcon, tone: 'green' },
  void: { icon: BanIcon, tone: 'grey' },
  split: { icon: SplitIcon, tone: 'purple' },
};

/** One chip per invoice: an open invoice past its due date reads «متأخرة» (icon + text, D35). */
export function InvoiceStatusBadge({
  invoice,
}: {
  invoice: { status: InvoiceStatus; isOverdue: boolean };
}) {
  const locale = useUiLocale();
  if (invoice.isOverdue) {
    const label = INVOICE_TAB_LABELS.overdue;
    return <ToneBadge tone="red" icon={AlarmClockIcon} label={label[locale]} title={label.en} />;
  }
  const s = STATUS[invoice.status];
  const label = INVOICE_STATUS_LABELS[invoice.status];
  return <ToneBadge tone={s.tone} icon={s.icon} label={label[locale]} title={label.en} />;
}

const PAYMENT: Record<PaymentStatus, { icon: LucideIcon; tone: Tone }> = {
  pending: { icon: HourglassIcon, tone: 'amber' },
  succeeded: { icon: CircleCheckIcon, tone: 'green' },
  failed: { icon: CircleXIcon, tone: 'red' },
  cancelled: { icon: CircleMinusIcon, tone: 'grey' },
  refunded: { icon: Undo2Icon, tone: 'purple' },
};

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  const locale = useUiLocale();
  const s = PAYMENT[status];
  const label = PAYMENT_STATUS_LABELS[status];
  return <ToneBadge tone={s.tone} icon={s.icon} label={label[locale]} title={label.en} />;
}

/** Billing refusals (apps/api README N6) in the UI language, never the server's English text. */
export function useBillingError() {
  const t = useTranslations('billing.errors');
  const locale = useUiLocale();
  return (error: unknown): string => {
    if (!isApiError(error)) return t('generic');
    const code = error.code ?? '';
    if (code in BILLING_ERROR_MESSAGES) {
      return BILLING_ERROR_MESSAGES[code as keyof typeof BILLING_ERROR_MESSAGES][locale];
    }
    if (code === 'reminder_not_sent') return t('reminderNotSent');
    if (error.status === 429) return t('tooMany');
    if (error.status === 404) return t('notFound');
    if (error.status === 403) return t('forbidden');
    if (error.status === 422) return t('invalid');
    return t('generic');
  };
}

/** A labelled control with its error under it (`billing.form.*` message keys). */
export function FormRow({
  id,
  label,
  required,
  error,
  hint,
  className,
  children,
}: {
  id: string;
  label: ReactNode;
  required?: boolean;
  error?: string | null;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const t = useTranslations('form');
  return (
    <Field data-invalid={!!error} className={className}>
      <FieldLabel htmlFor={id}>
        {label}
        {required && (
          <span className="text-destructive" aria-label={t('required')}>
            *
          </span>
        )}
      </FieldLabel>
      {children}
      {hint && !error && <p className="text-sm text-muted-foreground">{hint}</p>}
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </Field>
  );
}

/** Classes for money/number inputs: left-to-right digits, start-aligned in both directions. */
export const NUMBER_INPUT = 'h-10 text-start md:text-[0.9375rem]';
