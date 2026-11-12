'use client';

import {
  PAYOUT_METHOD_LABELS,
  PAYSLIP_LINE_LABELS,
  SALARY_TYPE_LABELS,
  SESSION_STAGE_LABELS,
  type PayslipDto,
  type PayslipLineDto,
} from '@qarabic/shared';
import { Alert, AlertDescription, AlertTitle } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@qarabic/ui/components/table';
import { useQuery } from '@tanstack/react-query';
import {
  BanknoteIcon,
  CircleCheckIcon,
  FileXIcon,
  IdCardIcon,
  InfoIcon,
  PlusIcon,
  PrinterIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Section } from '@/components/billing/invoice-parts';
import { PageHeader } from '@/components/page-header';
import { KeyFacts } from '@/components/people/detail';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { fetchPayProfile, fetchPayslip, payrollKeys } from '@/lib/api/payroll';
import { can } from '@/lib/auth/use-me';
import { monthLabel } from '@/lib/billing/labels';
import { formatMoney } from '@/lib/billing/money';
import { clockIn, dayMonthIn, hoursLabel, splitLines } from '@/lib/payroll/labels';
import { formatDate } from '@/lib/time';
import { AdjustmentDialog, PaymentDialog, ProfileDialog } from './dialogs';
import { Hours, Money, PayslipStatusBadge, useIssueText } from './payroll-bits';

type Open = null | 'pay' | 'adjust' | 'profile';

/**
 * A payslip (docs/21 §13; the current app's `PayslipPage`): who and which month, status; earnings,
 * deductions and net; the lines (additions, deductions, totals) and the classes behind the hours;
 * warnings for payroll staff. Payroll staff add an item while the run is open and record the
 * payment once it is approved (recorded only, D140); the owner (teacher) sees the same lines.
 * «طباعة» prints this page (the API serves no printable payslip).
 */
export function PayslipView({ id }: { id: number }) {
  const t = useTranslations('payroll');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const staff =
    can(me, 'payroll.manage') || can(me, 'payroll.review') || can(me, 'payroll.approve');
  const allowed = staff || can(me, 'payroll.view');
  const manage = can(me, 'payroll.manage');
  const [open, setOpen] = useState<Open>(null);
  const query = useQuery({
    queryKey: payrollKeys.payslip(id),
    queryFn: ({ signal }) => fetchPayslip(id, signal),
    enabled: allowed && Number.isInteger(id) && id > 0,
  });
  const slip = query.data;
  const back =
    staff && slip
      ? { href: `/payroll/runs/${slip.runId}`, label: t('slip.back') }
      : { href: '/payroll', label: staff ? t('run.back') : t('slip.backMine') };

  if (!allowed || isApiError(query.error, 403)) {
    return (
      <>
        <PageHeader title={t('slip.title')} back={back} />
        <ForbiddenState />
      </>
    );
  }
  if (isApiError(query.error, 404)) {
    return (
      <>
        <PageHeader title={t('slip.notFoundTitle')} back={back} />
        <EmptyState
          icon={FileXIcon}
          role="alert"
          title={t('slip.notFoundTitle')}
          description={t('slip.notFound')}
        />
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        <PageHeader title={t('slip.title')} back={back} />
        <ErrorState onRetry={() => void query.refetch()} />
      </>
    );
  }
  if (!slip) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  const month = monthLabel(slip.period, locale);
  const runOpen = slip.runStatus === 'draft' || slip.runStatus === 'reviewed';
  return (
    <>
      <PageHeader
        back={back}
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {staff ? t('slip.titleOf', { name: slip.user.name }) : t('slip.title')}
            <PayslipStatusBadge status={slip.status} />
          </span>
        }
        meta={`${t('slip.period', { month })} · ${SALARY_TYPE_LABELS[slip.salaryType][locale]}`}
        actions={
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            {manage && slip.status === 'approved' && (
              <Button className="h-10" onClick={() => setOpen('pay')}>
                <BanknoteIcon />
                {t('slip.pay')}
              </Button>
            )}
            {manage && runOpen && (
              <Button variant="outline" className="h-10" onClick={() => setOpen('adjust')}>
                <PlusIcon />
                {t('slip.addAdjustment')}
              </Button>
            )}
            {manage && (
              <Button variant="outline" className="h-10" onClick={() => setOpen('profile')}>
                <IdCardIcon />
                {t('slip.editProfile')}
              </Button>
            )}
            <Button variant="outline" className="h-10" onClick={() => window.print()}>
              <PrinterIcon />
              {t('slip.print')}
            </Button>
          </div>
        }
      />
      {slip.status === 'paid' && slip.paidOn && (
        <Alert>
          <CircleCheckIcon />
          <AlertDescription>
            <span>
              {t('slip.paidInfo', {
                date: formatDate(slip.paidOn, locale) ?? slip.paidOn,
                method: slip.paymentMethod ? PAYOUT_METHOD_LABELS[slip.paymentMethod][locale] : '—',
              })}
              {slip.paymentReference && (
                <>
                  {' · '}
                  {t('slip.reference')}:{' '}
                  <bdi dir="ltr" className="whitespace-nowrap">
                    {slip.paymentReference}
                  </bdi>
                </>
              )}
            </span>
          </AlertDescription>
        </Alert>
      )}
      {slip.status === 'draft' && (
        <Alert>
          <InfoIcon />
          <AlertDescription>{t('slip.draftHint')}</AlertDescription>
        </Alert>
      )}
      <Issues slip={slip} />
      <KeyFacts
        items={[
          {
            label: t('slip.earnings'),
            value: <Money amount={slip.earnings} currency={slip.currency} />,
          },
          {
            label: t('slip.deductions'),
            value: <Money amount={slip.deductions} currency={slip.currency} />,
          },
          { label: t('slip.net'), value: <Money amount={slip.net} currency={slip.currency} /> },
          slip.salaryType === 'per_class'
            ? { label: t('slip.classes'), value: <bdi>{slip.paidClasses}</bdi> }
            : { label: t('slip.hours'), value: <Hours value={slip.paidHours} /> },
        ]}
      />
      <div className="grid items-start gap-4 lg:grid-cols-12">
        <Section title={t('slip.lines')} className="lg:col-span-7">
          <Lines slip={slip} />
        </Section>
        <Section
          title={t('slip.sessions', { count: slip.sessions?.length ?? 0 })}
          className="lg:col-span-5"
        >
          <Sessions slip={slip} />
        </Section>
      </div>
      {open === 'pay' && (
        <PaymentDialog slip={slip} open onOpenChange={(o) => !o && setOpen(null)} />
      )}
      {open === 'adjust' && (
        <AdjustmentDialog
          open
          onOpenChange={(o) => !o && setOpen(null)}
          person={{ id: slip.user.id, name: slip.user.name, currency: slip.currency }}
          defaultDate={`${slip.period}-01`}
        />
      )}
      {open === 'profile' && <ProfileLoader person={slip.user} onClose={() => setOpen(null)} />}
    </>
  );
}

function ProfileLoader({
  person,
  onClose,
}: {
  person: { id: number; name: string };
  onClose: () => void;
}) {
  const profile = useQuery({
    queryKey: payrollKeys.profile(person.id),
    queryFn: ({ signal }) => fetchPayProfile(person.id, signal),
  });
  if (profile.isPending) return null;
  return (
    <ProfileDialog
      open
      onOpenChange={(o) => !o && onClose()}
      person={person}
      profile={profile.data ?? null}
    />
  );
}

function Issues({ slip }: { slip: PayslipDto }) {
  const t = useTranslations('payroll.slip');
  const text = useIssueText();
  if (!slip.errors.length && !slip.warnings.length) return null;
  return (
    <>
      {slip.errors.length > 0 && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>{t('errors')}</AlertTitle>
          <AlertDescription>
            <ul className="list-inside list-disc">
              {slip.errors.map((x, i) => (
                <li key={i}>{text(x, slip.currency)}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {slip.warnings.length > 0 && (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>{t('warnings')}</AlertTitle>
          <AlertDescription>
            <ul className="list-inside list-disc">
              {slip.warnings.map((x, i) => (
                <li key={i}>{text(x, slip.currency)}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}

function Lines({ slip }: { slip: PayslipDto }) {
  const t = useTranslations('payroll.slip');
  const locale = useUiLocale();
  const { additions, deductions } = splitLines(slip.lines ?? []);
  const detail = (line: PayslipLineDto): string => {
    if (line.adjustment) return line.adjustment.reason;
    if (line.code === 'leave_deduction' && line.quantity)
      return t('days', { count: line.quantity });
    if (line.quantity && line.rate) {
      return t('rate', {
        qty: hoursLabel(line.quantity),
        rate: formatMoney(line.rate, slip.currency, locale),
      });
    }
    return line.quantity ? hoursLabel(line.quantity) : '';
  };
  if (!additions.length && !deductions.length) {
    return <p className="text-muted-foreground">{t('noLines')}</p>;
  }
  const row = (l: PayslipLineDto, i: number) => (
    <TableRow key={`${l.code}-${i}`}>
      <TableCell className="text-start font-medium whitespace-normal">
        {PAYSLIP_LINE_LABELS[l.code][locale]}
      </TableCell>
      <TableCell className="text-start whitespace-normal text-muted-foreground" dir="auto">
        {detail(l)}
      </TableCell>
      <TableCell className={l.sign === -1 ? 'text-end text-destructive' : 'text-end'}>
        <Money amount={l.sign === -1 ? `-${l.amount}` : l.amount} currency={slip.currency} />
      </TableCell>
    </TableRow>
  );
  return (
    <div className="overflow-x-auto">
      <Table aria-label={t('linesTable')} className="tabular-nums">
        <TableHeader className="bg-subtle">
          <TableRow>
            <TableHead className="text-start">{t('item')}</TableHead>
            <TableHead className="text-start">{t('detail')}</TableHead>
            <TableHead className="text-end">{t('amount')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {additions.map(row)}
          <TableRow className="bg-subtle/50">
            <TableCell colSpan={2} className="text-start font-semibold">
              {t('totalEarnings')}
            </TableCell>
            <TableCell className="text-end font-semibold">
              <Money amount={slip.earnings} currency={slip.currency} />
            </TableCell>
          </TableRow>
          {deductions.map(row)}
          {deductions.length > 0 && (
            <TableRow className="bg-subtle/50">
              <TableCell colSpan={2} className="text-start font-semibold">
                {t('totalDeductions')}
              </TableCell>
              <TableCell className="text-end font-semibold text-destructive">
                <Money amount={`-${slip.deductions}`} currency={slip.currency} />
              </TableCell>
            </TableRow>
          )}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={2} className="text-start text-base font-bold">
              {t('net')}
            </TableCell>
            <TableCell className="text-end text-base">
              <Money amount={slip.net} currency={slip.currency} strong />
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}

function Sessions({ slip }: { slip: PayslipDto }) {
  const t = useTranslations('payroll.slip');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const rows = slip.sessions ?? [];
  if (!rows.length) return <p className="text-muted-foreground">{t('noSessions')}</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">{t('sessionsHint')}</p>
      <div className="max-h-96 overflow-auto">
        <Table aria-label={t('sessionsTable')} className="tabular-nums">
          <TableHeader className="sticky top-0 bg-subtle">
            <TableRow>
              <TableHead className="text-start">{t('classTime')}</TableHead>
              <TableHead className="text-start">{t('classStage')}</TableHead>
              <TableHead className="text-end">{t('payHours')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s) => (
              <TableRow key={s.sessionId}>
                <TableCell className="text-start whitespace-normal">
                  {s.startsAt ? (
                    <>
                      <span className="whitespace-nowrap">
                        {dayMonthIn(s.startsAt, tz, locale)}
                      </span>
                      {' · '}
                      <bdi className="whitespace-nowrap">{clockIn(s.startsAt, tz, locale)}</bdi>
                    </>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell className="text-start">
                  {SESSION_STAGE_LABELS[s.stage][locale]}
                </TableCell>
                <TableCell className="text-end">
                  <bdi dir="ltr">{hoursLabel(s.payHours)}</bdi>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
