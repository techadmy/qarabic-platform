'use client';

import {
  ADJUSTMENT_STATUS_LABELS,
  ATTENDANCE_STATUS_LABELS,
  LEAVE_STATUS_LABELS,
  PAYROLL_ERROR_MESSAGES,
  PAYSLIP_STATUS_LABELS,
  RUN_STATUS_LABELS,
  type AdjustmentStatus,
  type AttendanceStatus,
  type LeaveStatus,
  type PayslipIssue,
  type PayslipStatus,
  type RunStatus,
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
import { Spinner } from '@qarabic/ui/components/spinner';
import { cn } from '@qarabic/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircleIcon,
  BanIcon,
  CalendarOffIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  CircleMinusIcon,
  CircleXIcon,
  FilePenLineIcon,
  HourglassIcon,
  PlaneIcon,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Combobox } from '@/components/forms/fields';
import { ToneBadge, type Tone } from '@/components/sessions/badges';
import { useUiLocale } from '@/components/sessions/times';
import { isApiError } from '@/lib/api/client';
import { fetchPayrollPeople, payrollKeys } from '@/lib/api/payroll';
import { formatMoney } from '@/lib/billing/money';
import { monthLabel } from '@/lib/billing/labels';
import { hoursLabel } from '@/lib/payroll/labels';

export { FormRow, Money, NUMBER_INPUT } from '@/components/billing/billing-bits';

/**
 * Shared payroll pieces (docs/21 §13, the current app's `features/payroll/components`): status
 * chips (icon + text, D35), refusal messages in the UI language, the form dialog shell, the
 * person picker and the payslip issues. Built from shadcn components and the N6 money helpers.
 */

const RUN: Record<RunStatus, { icon: LucideIcon; tone: Tone }> = {
  draft: { icon: FilePenLineIcon, tone: 'grey' },
  reviewed: { icon: CircleDotIcon, tone: 'lightBlue' },
  approved: { icon: CircleCheckIcon, tone: 'amber' },
  paid: { icon: CircleCheckIcon, tone: 'green' },
};
const SLIP: Record<PayslipStatus, { icon: LucideIcon; tone: Tone }> = {
  draft: { icon: FilePenLineIcon, tone: 'grey' },
  approved: { icon: CircleCheckIcon, tone: 'amber' },
  paid: { icon: CircleCheckIcon, tone: 'green' },
};
const LEAVE: Record<LeaveStatus, { icon: LucideIcon; tone: Tone }> = {
  pending: { icon: HourglassIcon, tone: 'amber' },
  approved: { icon: CircleCheckIcon, tone: 'green' },
  rejected: { icon: CircleXIcon, tone: 'red' },
  cancelled: { icon: CircleMinusIcon, tone: 'grey' },
};
const ADJ: Record<AdjustmentStatus, { icon: LucideIcon; tone: Tone }> = {
  proposed: { icon: HourglassIcon, tone: 'amber' },
  approved: { icon: CircleCheckIcon, tone: 'green' },
  rejected: { icon: CircleXIcon, tone: 'red' },
  cancelled: { icon: BanIcon, tone: 'grey' },
};
const ATT: Record<AttendanceStatus, { icon: LucideIcon; tone: Tone }> = {
  present: { icon: CircleCheckIcon, tone: 'green' },
  absent: { icon: CircleXIcon, tone: 'red' },
  leave: { icon: PlaneIcon, tone: 'purple' },
  holiday: { icon: CalendarOffIcon, tone: 'lightBlue' },
};

function Chip({
  style,
  label,
}: {
  style: { icon: LucideIcon; tone: Tone };
  label: { ar: string; en: string };
}) {
  const locale = useUiLocale();
  return <ToneBadge tone={style.tone} icon={style.icon} label={label[locale]} title={label.en} />;
}

export const RunStatusBadge = ({ status }: { status: RunStatus }) => (
  <Chip style={RUN[status]} label={RUN_STATUS_LABELS[status]} />
);
export const PayslipStatusBadge = ({ status }: { status: PayslipStatus }) => (
  <Chip style={SLIP[status]} label={PAYSLIP_STATUS_LABELS[status]} />
);
export const LeaveStatusBadge = ({ status }: { status: LeaveStatus }) => (
  <Chip style={LEAVE[status]} label={LEAVE_STATUS_LABELS[status]} />
);
export const AdjustmentStatusBadge = ({ status }: { status: AdjustmentStatus }) => (
  <Chip style={ADJ[status]} label={ADJUSTMENT_STATUS_LABELS[status]} />
);
export const AttendanceStatusBadge = ({ status }: { status: AttendanceStatus }) => (
  <Chip style={ATT[status]} label={ATTENDANCE_STATUS_LABELS[status]} />
);
export const NoStatusBadge = ({ label }: { label: string }) => (
  <ToneBadge tone="grey" icon={CircleIcon} label={label} />
);

/** Hours as Latin digits, isolated so they keep their order in Arabic text. */
export function Hours({ value }: { value: string }) {
  return (
    <bdi dir="ltr" className="whitespace-nowrap tabular-nums">
      {hoursLabel(value)}
    </bdi>
  );
}

/** Payroll refusals (apps/api README N7) in the UI language, never the server's English text. */
export function usePayrollError() {
  const t = useTranslations('payroll.errors');
  const locale = useUiLocale();
  return (error: unknown): string => {
    if (!isApiError(error)) return t('generic');
    const code = error.code ?? '';
    if (code in PAYROLL_ERROR_MESSAGES) {
      return PAYROLL_ERROR_MESSAGES[code as keyof typeof PAYROLL_ERROR_MESSAGES][locale];
    }
    if (code === 'stale_run') return t('stale');
    if (error.status === 429) return t('tooMany');
    if (error.status === 404) return t('notFound');
    if (error.status === 403) return t('forbidden');
    if (error.status === 422) return t('invalid');
    return t('generic');
  };
}

/** One payslip warning or error as a sentence (`docs/21` §7: warnings never block). */
export function useIssueText() {
  const t = useTranslations('payroll.issue');
  const locale = useUiLocale();
  return (issue: PayslipIssue, currency?: string) => {
    const n = (k: string) => (typeof issue[k] === 'number' ? Number(issue[k]) : 0);
    switch (issue.code) {
      case 'negative_net':
        return t('negative_net', {
          amount: formatMoney(String(issue.net ?? '0'), currency, locale),
        });
      case 'unmarked_sessions':
      case 'sessions_need_review':
      case 'fines_pending':
        return t(issue.code, { count: n('count') });
      case 'prior_period_changed':
        return t('prior_period_changed', {
          month: monthLabel(String(issue.period ?? ''), locale),
          delta: String(issue.deltaHours ?? ''),
        });
      case 'currency_mismatch':
      case 'no_teacher_link':
      case 'no_active_profile':
        return t(issue.code);
      default:
        return t('unknown', { code: issue.code });
    }
  };
}

/**
 * The dialog shell of every payroll form (as N6 `FormDialog`): the title names the action,
 * validation on submit (errors under the fields + an `aria-live` summary), a refusal stays inside
 * with the input kept, the submit button names the action.
 */
export function FormDialog({
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
  extraActions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  summary: string | null;
  onSubmit: () => void;
  wide?: boolean;
  children: ReactNode;
  extraActions?: ReactNode;
}) {
  const t = useTranslations('payroll.form');
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        className={cn('max-h-[90svh] overflow-y-auto', wide ? 'sm:max-w-2xl' : 'sm:max-w-md')}
        showCloseButton={false}
      >
        <form
          noValidate
          className="flex min-w-0 flex-col gap-4"
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
          <DialogFooter className="flex-wrap">
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                {t('cancel')}
              </Button>
            </DialogClose>
            {extraActions}
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

/** People with an active salary profile (`GET /payroll/people`), searched on the server. */
export function PersonPicker({
  id,
  value,
  onChange,
  invalid,
  placeholder,
  searchPlaceholder,
}: {
  id: string;
  value: number | null;
  onChange: (person: { id: number; name: string; currency: string } | null) => void;
  invalid?: boolean;
  placeholder: string;
  searchPlaceholder: string;
}) {
  const [q, setQ] = useState('');
  const people = useQuery({
    queryKey: payrollKeys.people(q),
    queryFn: ({ signal }) => fetchPayrollPeople(q || undefined, signal),
  });
  const [picked, setPicked] = useState<{ id: number; name: string; currency: string } | null>(null);
  const found = people.data ?? [];
  // The chosen person stays labelled while the search shows other names.
  const rows = picked && !found.some((p) => p.id === picked.id) ? [picked, ...found] : found;
  return (
    <Combobox
      id={id}
      value={value ? String(value) : null}
      onChange={(v) => {
        const next = rows.find((p) => String(p.id) === v) ?? null;
        setPicked(next);
        onChange(next);
      }}
      options={rows.map((p) => ({ value: String(p.id), label: p.name, hint: p.currency }))}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      invalid={invalid}
      shouldFilter={false}
      onSearch={setQ}
      loading={people.isPending}
    />
  );
}
