'use client';

import { LEAD_SOURCE_LABELS, type LeadFunnelDto } from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { ToggleGroup, ToggleGroupItem } from '@qarabic/ui/components/toggle-group';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { DataTable } from '@/components/data-table';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { ErrorState } from '@/components/states';
import { crmKeys, fetchLeadFunnel } from '@/lib/api/crm';
import { dateKeyIn } from '@/lib/schedule-time';
import { intlLocale } from '@/lib/time';

type Row = LeadFunnelDto['total'] & { label: string };
const COLS = ['created', 'contacted', 'trial', 'converted', 'lost'] as const;

function monthRange(month: string) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}
function shiftMonth(month: string, by: number) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
}

/** «تقرير التحويل» (docs/26 §9.1): the month's leads by source or by staff member, with the rate. */
export function FunnelCard() {
  const t = useTranslations('crm.funnel');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const thisMonth = dateKeyIn(tz).slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [by, setBy] = useState<'source' | 'assignee'>('source');
  const range = monthRange(month);
  const funnel = useQuery({
    queryKey: crmKeys.funnel(range),
    queryFn: ({ signal }) => fetchLeadFunnel(range, signal),
  });
  const label = new Intl.DateTimeFormat(intlLocale(locale), {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${month}-01T00:00:00Z`));
  const data = funnel.data;
  const rows: Row[] = !data
    ? []
    : by === 'source'
      ? data.bySource.map((r) => ({ ...r, label: LEAD_SOURCE_LABELS[r.source][locale] }))
      : data.byAssignee.map((r) => ({ ...r, label: r.user?.name ?? t('unassigned') }));
  if (data && rows.length) rows.push({ ...data.total, label: t('total') });
  const rate = (r: Row) => (r.created ? `${Math.round((r.converted / r.created) * 100)}%` : '—');
  const columns: ColumnDef<Row, unknown>[] = [
    {
      id: 'label',
      header: by === 'source' ? t('source') : t('assignee'),
      cell: ({ row }) => row.original.label,
    },
    ...COLS.map((k): ColumnDef<Row, unknown> => ({
      id: k,
      header: t(k),
      meta: { numeric: true },
      cell: ({ row }) => <bdi>{row.original[k]}</bdi>,
    })),
    {
      id: 'rate',
      header: t('rate'),
      meta: { numeric: true },
      cell: ({ row }) => <bdi className="font-semibold">{rate(row.original)}</bdi>,
    },
  ];
  return (
    <Card className="gap-3 shadow-none">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-lg font-bold">
          <h2>{t('title')}</h2>
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            value={by}
            onValueChange={(v) => {
              if (v) setBy(v as typeof by);
            }}
            aria-label={t('groupBy')}
            className="bg-card"
          >
            <ToggleGroupItem value="source" className="h-9 px-3 data-[state=on]:bg-accent">
              {t('bySource')}
            </ToggleGroupItem>
            <ToggleGroupItem value="assignee" className="h-9 px-3 data-[state=on]:bg-accent">
              {t('byAssignee')}
            </ToggleGroupItem>
          </ToggleGroup>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('prevMonth')}
            onClick={() => setMonth(shiftMonth(month, -1))}
          >
            <ChevronRightIcon className="ltr:rotate-180" />
          </Button>
          <span className="min-w-28 text-center font-semibold" aria-live="polite">
            {label}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('nextMonth')}
            onClick={() => setMonth(shiftMonth(month, 1))}
          >
            <ChevronLeftIcon className="ltr:rotate-180" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {funnel.isError ? (
          <ErrorState onRetry={() => void funnel.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            data={rows}
            label={t('title')}
            emptyText={t('empty')}
            loading={funnel.isPending}
          />
        )}
      </CardContent>
    </Card>
  );
}
