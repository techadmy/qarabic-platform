'use client';

import type { HolidayDto } from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import { Field, FieldError, FieldGroup, FieldLabel } from '@qarabic/ui/components/field';
import { Input } from '@qarabic/ui/components/input';
import { Switch } from '@qarabic/ui/components/switch';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import {
  CalendarOffIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { DataTable } from '@/components/data-table';
import { DatePicker } from '@/components/forms/date-time';
import { PageHeader } from '@/components/page-header';
import { ToneBadge } from '@/components/sessions/badges';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import {
  createHoliday,
  deleteHoliday,
  fetchHolidays,
  scheduleKeys,
  updateHoliday,
} from '@/lib/api/schedule';
import { can } from '@/lib/auth/use-me';
import { useListParams } from '@/lib/list-params';
import { refreshClasses } from '@/lib/sessions/cache';
import { useClassError } from '@/lib/sessions/errors';
import { dateKeyIn } from '@/lib/schedule-time';
import { formatDate } from '@/lib/time';

/**
 * «العطلات الرسمية» (schedule.view; manage with schedule.manage): the year's public holidays in
 * the academy's dates with a year switcher; add / edit in a dialog, delete confirmed. Saving
 * cancels or restores the classes on those days (apps/api README, N2).
 */
export function HolidaysView() {
  const t = useTranslations('holidays');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const params = useListParams();
  const queryClient = useQueryClient();
  const message = useClassError();
  const thisYear = Number(dateKeyIn(tz).slice(0, 4));
  const year = Number(params.get('year')) || thisYear;
  const [editing, setEditing] = useState<HolidayDto | 'new' | null>(null);
  const [removing, setRemoving] = useState<HolidayDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const allowed = can(me, 'schedule.view');
  const canManage = can(me, 'schedule.manage');
  const query = useQuery({
    queryKey: scheduleKeys.holidays(year),
    queryFn: ({ signal }) => fetchHolidays(year, signal),
    enabled: allowed,
  });
  const remove = useMutation({
    mutationFn: (h: HolidayDto) => deleteHoliday(h.id),
    onSuccess: () => {
      refreshClasses(queryClient);
      setRemoving(null);
      toast.success(t('removed'));
    },
    onError: (e) => setError(message(e)),
  });
  if (!allowed || isApiError(query.error, 403)) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }
  const range = (h: HolidayDto) =>
    h.endsOn && h.endsOn !== h.date
      ? t('range', {
          from: formatDate(h.date, locale) ?? '',
          to: formatDate(h.endsOn, locale) ?? '',
        })
      : formatDate(h.date, locale);
  const columns: ColumnDef<HolidayDto, unknown>[] = [
    {
      id: 'name',
      header: t('name'),
      cell: ({ row }) => <span className="font-semibold">{row.original.name}</span>,
    },
    { id: 'date', header: t('date'), cell: ({ row }) => range(row.original) },
    {
      id: 'paid',
      header: t('paid'),
      cell: ({ row }) =>
        row.original.paid ? (
          <ToneBadge tone="green" label={t('paidYes')} />
        ) : (
          <ToneBadge tone="grey" label={t('paidNo')} />
        ),
    },
    ...(canManage
      ? [
          {
            id: 'actions',
            header: () => <span className="sr-only">{t('actions')}</span>,
            cell: ({ row }) => (
              <div className="flex justify-end gap-1">
                <Button variant="ghost" size="sm" onClick={() => setEditing(row.original)}>
                  <PencilIcon />
                  {t('edit')}
                  <span className="sr-only">: {row.original.name}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => {
                    setError(null);
                    setRemoving(row.original);
                  }}
                >
                  <Trash2Icon />
                  {t('delete')}
                  <span className="sr-only">: {row.original.name}</span>
                </Button>
              </div>
            ),
            meta: { className: 'text-end' },
          } satisfies ColumnDef<HolidayDto, unknown>,
        ]
      : []),
  ];
  const rows = query.data ?? [];

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-lg"
                aria-label={t('prevYear')}
                onClick={() => params.set({ year: year - 1 })}
              >
                <ChevronRightIcon className="ltr:rotate-180" />
              </Button>
              <span
                className="min-w-14 text-center text-lg font-bold tabular-nums"
                aria-live="polite"
              >
                {year}
              </span>
              <Button
                variant="ghost"
                size="icon-lg"
                aria-label={t('nextYear')}
                onClick={() => params.set({ year: year + 1 })}
              >
                <ChevronLeftIcon className="ltr:rotate-180" />
              </Button>
            </div>
            {canManage && (
              <Button className="h-10 px-4" onClick={() => setEditing('new')}>
                <PlusIcon />
                {t('add')}
              </Button>
            )}
          </>
        }
      />
      <Card className="gap-0 py-0 shadow-none">
        {query.isError ? (
          <div className="p-4">
            <ErrorState onRetry={() => void query.refetch()} />
          </div>
        ) : !query.isPending && rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={CalendarOffIcon}
              title={t('empty', { year })}
              description={t('emptyHint')}
            />
          </div>
        ) : (
          <DataTable
            bare
            columns={columns}
            data={rows}
            label={t('title')}
            emptyText={t('empty', { year })}
            loading={query.isPending}
          />
        )}
      </Card>
      {editing && (
        <HolidayDialog
          holiday={editing === 'new' ? null : editing}
          defaultDate={`${year}-${dateKeyIn(tz).slice(5)}`}
          onClose={() => setEditing(null)}
        />
      )}
      <ReasonDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        destructive
        title={t('deleteTitle', { name: removing?.name ?? '' })}
        description={t('deleteBody')}
        confirmLabel={t('delete')}
        busy={remove.isPending}
        error={error}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </>
  );
}

function HolidayDialog({
  holiday,
  defaultDate,
  onClose,
}: {
  holiday: HolidayDto | null;
  defaultDate: string;
  onClose: () => void;
}) {
  const t = useTranslations('holidays');
  const queryClient = useQueryClient();
  const message = useClassError();
  const [name, setName] = useState(holiday?.name ?? '');
  const [date, setDate] = useState(holiday?.date ?? defaultDate);
  const [endsOn, setEndsOn] = useState(holiday?.endsOn ?? '');
  const [paid, setPaid] = useState(holiday?.paid ?? true);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), date, endsOn: endsOn || null, paid };
      return holiday ? updateHoliday(holiday.id, body) : createHoliday(body);
    },
    onSuccess: () => {
      refreshClasses(queryClient);
      onClose();
      toast.success(holiday ? t('updated') : t('added'));
    },
    onError: (e) => setError(message(e)),
  });
  const endsInvalid = !!endsOn && endsOn < date;
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={holiday ? t('editTitle') : t('addTitle')}
      description={t('dialogHint')}
      confirmLabel={holiday ? t('save') : t('add')}
      busy={save.isPending}
      error={error}
      extra={
        <FieldGroup>
          <Field data-invalid={touched && !name.trim()}>
            <FieldLabel htmlFor="holiday-name">
              {t('name')}
              <span aria-hidden className="text-destructive">
                *
              </span>
            </FieldLabel>
            <Input
              id="holiday-name"
              className="h-10"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={touched && !name.trim()}
            />
            {touched && !name.trim() && <FieldError>{t('nameRequired')}</FieldError>}
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="holiday-date">{t('from')}</FieldLabel>
              <DatePicker id="holiday-date" value={date} onChange={setDate} className="w-full" />
            </Field>
            <Field data-invalid={endsInvalid}>
              <FieldLabel htmlFor="holiday-ends">{t('to')}</FieldLabel>
              <DatePicker
                id="holiday-ends"
                value={endsOn}
                onChange={setEndsOn}
                min={date}
                invalid={endsInvalid}
                className="w-full"
              />
              {endsInvalid && <FieldError>{t('endsInvalid')}</FieldError>}
            </Field>
          </div>
          <Field orientation="horizontal">
            <Switch id="holiday-paid" checked={paid} onCheckedChange={setPaid} />
            <FieldLabel htmlFor="holiday-paid" className="font-normal">
              {t('paidLabel')}
            </FieldLabel>
          </Field>
        </FieldGroup>
      }
      onConfirm={() => {
        setTouched(true);
        if (!name.trim() || endsInvalid) return;
        save.mutate();
      }}
    />
  );
}
