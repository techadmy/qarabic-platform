'use client';

import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@qarabic/ui/components/table';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BanIcon, PrinterIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { InfoSection, ProfileSkeleton } from '@/components/people/detail';
import { PageHeader } from '@/components/page-header';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { ErrorState, ForbiddenState } from '@/components/states';
import { accountingKeys, fetchVoucher, voidVoucher } from '@/lib/api/accounting';
import { isApiError } from '@/lib/api/client';
import { can } from '@/lib/auth/use-me';
import { formatDate, formatInstant } from '@/lib/time';
import {
  accountLabel,
  Money,
  useAccountingError,
  VoucherStatusBadge,
  VoucherTypeBadge,
} from './accounting-bits';

/**
 * One voucher (M7): who, the cash account, the lines and the journal entry it posted. «إلغاء
 * السند» (accounting.manage) asks for a reason and posts the reversing entry; the voucher stays
 * listed as «ملغى». «طباعة» uses the browser's print (the page prints without the app chrome).
 */
export function VoucherView({ id }: { id: number }) {
  const t = useTranslations('accounting');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const message = useAccountingError();
  const [voiding, setVoiding] = useState(false);
  const allowed = can(me, 'accounting.view');
  const query = useQuery({
    queryKey: accountingKeys.voucher(id),
    queryFn: ({ signal }) => fetchVoucher(id, signal),
    enabled: allowed,
  });
  const cancel = useMutation({
    mutationFn: (reason: string) => voidVoucher(id, reason),
    onSuccess: (v) => {
      void queryClient.invalidateQueries({ queryKey: accountingKeys.all });
      setVoiding(false);
      toast.success(t('voucher.voided', { number: v.number }));
    },
  });
  const back = { href: '/accounting/vouchers', label: t('vouchers.title') };
  if (!allowed || isApiError(query.error, 403)) {
    return (
      <>
        <PageHeader title={t('voucher.title')} back={back} />
        <ForbiddenState />
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        <PageHeader title={t('voucher.title')} back={back} />
        <ErrorState onRetry={() => void query.refetch()} />
      </>
    );
  }
  if (!query.data) return <ProfileSkeleton />;
  const v = query.data;
  const receipt = v.type === 'receipt';
  const link = (href: string, text: string) => (
    <Link href={href} className="font-semibold text-primary hover:underline">
      {text}
    </Link>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <bdi>{v.number}</bdi>
            <VoucherTypeBadge type={v.type} />
            <VoucherStatusBadge status={v.status} />
          </span>
        }
        description={v.description}
        back={back}
        actions={
          <div className="flex flex-wrap gap-2 print:hidden">
            <Button variant="outline" className="h-10" onClick={() => window.print()}>
              <PrinterIcon />
              {t('voucher.print')}
            </Button>
            {can(me, 'accounting.manage') && v.status === 'posted' && (
              <Button variant="outline" className="h-10" onClick={() => setVoiding(true)}>
                <BanIcon />
                {t('voucher.void')}
              </Button>
            )}
          </div>
        }
      />
      {v.status === 'void' && (
        <Alert>
          <BanIcon />
          <AlertDescription>
            {t('voucher.voidNote', {
              when: formatInstant(v.voidedAt, tz, locale) ?? '',
              reason: v.voidReason ?? '',
            })}
          </AlertDescription>
        </Alert>
      )}
      <InfoSection
        title={t('voucher.details')}
        rows={[
          { label: t('fields.date'), value: formatDate(v.date, locale) },
          {
            label: receipt ? t('voucher.payer') : t('voucher.payee'),
            value: v.party,
          },
          {
            label: t('fields.amount'),
            value: <Money amount={v.amount} currency={v.currency} strong />,
          },
          {
            label: receipt ? t('voucher.cashIn') : t('voucher.cashOut'),
            value: accountLabel(v.cashAccount, locale),
          },
          { label: t('voucher.reference'), value: v.reference },
          {
            label: t('voucher.cheque'),
            value: v.chequeNumber && <bdi dir="ltr">{v.chequeNumber}</bdi>,
          },
          {
            label: t('entry.createdBy'),
            value: v.createdBy && `${v.createdBy.name} · ${formatInstant(v.createdAt, tz, locale)}`,
          },
          {
            label: t('voucher.entry'),
            value: link(`/accounting/journal/${v.journalEntryId}`, t('entry.openEntry')),
          },
          ...(v.voidEntryId
            ? [
                {
                  label: t('voucher.voidEntry'),
                  value: link(`/accounting/journal/${v.voidEntryId}`, t('entry.openReversal')),
                },
              ]
            : []),
        ]}
      />
      <Card className="gap-0 overflow-x-auto py-0 shadow-none">
        <Table aria-label={t('voucher.lines')}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t('fields.account')}</TableHead>
              <TableHead>{t('fields.description')}</TableHead>
              <TableHead className="text-end">{t('fields.amount')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {v.lines.map((l, i) => (
              <TableRow key={i}>
                <TableCell className="font-medium">
                  {accountLabel(
                    { code: l.accountCode, nameAr: l.accountNameAr, nameEn: l.accountNameEn },
                    locale,
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{l.description ?? '—'}</TableCell>
                <TableCell className="text-end">
                  <Money amount={l.amount} currency={v.currency} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={2} className="font-semibold">
                {t('entry.totals')}
              </TableCell>
              <TableCell className="text-end">
                <Money amount={v.amount} currency={v.currency} strong />
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </Card>
      <ReasonDialog
        open={voiding}
        onOpenChange={(o) => {
          setVoiding(o);
          if (!o) cancel.reset();
        }}
        destructive
        title={t('voucher.voidTitle', { number: v.number })}
        description={t('voucher.voidHint')}
        confirmLabel={t('voucher.void')}
        textLabel={t('reason')}
        textRequired
        textMin={3}
        busy={cancel.isPending}
        error={cancel.isError ? message(cancel.error) : null}
        onConfirm={({ text }) => cancel.mutate(text)}
      />
    </div>
  );
}
