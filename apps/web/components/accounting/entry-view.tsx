'use client';

import type { JournalEntryDto } from '@qarabic/shared';
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
import { Undo2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { InfoSection, ProfileSkeleton } from '@/components/people/detail';
import { PageHeader } from '@/components/page-header';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { ErrorState, ForbiddenState } from '@/components/states';
import { accountingKeys, fetchJournalEntry, reverseJournalEntry } from '@/lib/api/accounting';
import { isApiError } from '@/lib/api/client';
import { can } from '@/lib/auth/use-me';
import { minorOf } from '@/lib/billing/money';
import { formatDate, formatInstant } from '@/lib/time';
import { accountLabel, Money, SourceBadge, useAccountingError } from './accounting-bits';

/** The lines of an entry: account, description, debit | credit, with the totals in the footer. */
export function EntryLines({ entry: e }: { entry: JournalEntryDto }) {
  const t = useTranslations('accounting');
  const locale = useUiLocale();
  const amount = (v: string) =>
    minorOf(v) ? <Money amount={v} currency={e.currency} /> : <span aria-hidden>—</span>;
  return (
    <Card className="gap-0 overflow-x-auto py-0 shadow-none">
      <Table aria-label={t('entry.lines')}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t('fields.account')}</TableHead>
            <TableHead>{t('fields.description')}</TableHead>
            <TableHead className="text-end">{t('fields.debit')}</TableHead>
            <TableHead className="text-end">{t('fields.credit')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {e.lines.map((l) => (
            <TableRow key={l.id}>
              <TableCell className="font-medium">
                <Link
                  href={`/accounting/accounts/${l.accountId}?currency=${e.currency}`}
                  className="text-primary hover:underline"
                >
                  {accountLabel(
                    { code: l.accountCode, nameAr: l.accountNameAr, nameEn: l.accountNameEn },
                    locale,
                  )}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground">{l.description ?? '—'}</TableCell>
              <TableCell className="text-end">{amount(l.debit)}</TableCell>
              <TableCell className="text-end">{amount(l.credit)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={2} className="font-semibold">
              {t('entry.totals')}
            </TableCell>
            <TableCell className="text-end">
              <Money amount={e.total} currency={e.currency} strong />
            </TableCell>
            <TableCell className="text-end">
              <Money amount={e.total} currency={e.currency} strong />
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </Card>
  );
}

/**
 * One journal entry (M7): header facts, the lines and where it came from (a voucher, a billing or
 * payroll event, the entry it reverses). Entries are never edited or deleted (append-only, D86):
 * «عكس القيد» posts the opposite entry with a reason; voucher entries are cancelled from the
 * voucher.
 */
export function EntryView({ id }: { id: number }) {
  const t = useTranslations('accounting');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const router = useRouter();
  const queryClient = useQueryClient();
  const message = useAccountingError();
  const [reversing, setReversing] = useState(false);
  const allowed = can(me, 'accounting.view');
  const query = useQuery({
    queryKey: accountingKeys.entry(id),
    queryFn: ({ signal }) => fetchJournalEntry(id, signal),
    enabled: allowed,
  });
  const reverse = useMutation({
    mutationFn: (reason: string) => reverseJournalEntry(id, { reason }),
    onSuccess: (rev) => {
      void queryClient.invalidateQueries({ queryKey: accountingKeys.all });
      setReversing(false);
      toast.success(t('entry.reversed', { number: rev.number }));
      router.push(`/accounting/journal/${rev.id}`);
    },
  });
  const back = { href: '/accounting/journal', label: t('journal.title') };

  if (!allowed || isApiError(query.error, 403)) {
    return (
      <>
        <PageHeader title={t('entry.title')} back={back} />
        <ForbiddenState />
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        <PageHeader title={t('entry.title')} back={back} />
        <ErrorState onRetry={() => void query.refetch()} />
      </>
    );
  }
  if (!query.data) return <ProfileSkeleton />;
  const e = query.data;
  const mayReverse =
    can(me, 'accounting.manage') && !e.reversedById && !e.voucherId && e.source !== 'reversal';
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
            {t('entry.titleNumber', { number: e.number })}
            <SourceBadge source={e.source} />
          </span>
        }
        description={e.memo}
        back={back}
        actions={
          mayReverse && (
            <Button variant="outline" className="h-10" onClick={() => setReversing(true)}>
              <Undo2Icon />
              {t('entry.reverse')}
            </Button>
          )
        }
      />
      <InfoSection
        title={t('entry.details')}
        rows={[
          { label: t('fields.date'), value: formatDate(e.date, locale) },
          { label: t('fields.currency'), value: <bdi>{e.currency}</bdi> },
          { label: t('fields.total'), value: <Money amount={e.total} currency={e.currency} /> },
          {
            label: t('entry.createdBy'),
            value: e.createdBy
              ? `${e.createdBy.name} · ${formatInstant(e.createdAt, tz, locale)}`
              : t('entry.automatic'),
          },
          ...(e.voucherId
            ? [
                {
                  label: t('entry.voucher'),
                  value: link(`/accounting/vouchers/${e.voucherId}`, t('entry.openVoucher')),
                },
              ]
            : []),
          ...(e.reversesId
            ? [
                {
                  label: t('entry.reverses'),
                  value: link(`/accounting/journal/${e.reversesId}`, t('entry.openOriginal')),
                },
              ]
            : []),
          ...(e.reversedById
            ? [
                {
                  label: t('entry.reversedBy'),
                  value: link(`/accounting/journal/${e.reversedById}`, t('entry.openReversal')),
                },
              ]
            : []),
          ...(e.sourceRef && !e.voucherId && !e.reversesId
            ? [{ label: t('entry.sourceRef'), value: <bdi dir="ltr">{e.sourceRef}</bdi> }]
            : []),
        ]}
      />
      <EntryLines entry={e} />
      <ReasonDialog
        open={reversing}
        onOpenChange={(o) => {
          setReversing(o);
          if (!o) reverse.reset();
        }}
        destructive
        title={t('entry.reverseTitle', { number: e.number })}
        description={t('entry.reverseHint')}
        confirmLabel={t('entry.reverse')}
        textLabel={t('reason')}
        textRequired
        textMin={3}
        busy={reverse.isPending}
        error={reverse.isError ? message(reverse.error) : null}
        onConfirm={({ text }) => reverse.mutate(text)}
      />
    </div>
  );
}
