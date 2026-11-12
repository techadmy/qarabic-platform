'use client';

import type { PayRuleSetDto } from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Checkbox } from '@qarabic/ui/components/checkbox';
import { Input } from '@qarabic/ui/components/input';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@qarabic/ui/components/table';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, ScaleIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Section } from '@/components/billing/invoice-parts';
import { PageHeader } from '@/components/page-header';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { createPayRuleSet, fetchPayRuleSets, payrollKeys } from '@/lib/api/payroll';
import { can } from '@/lib/auth/use-me';
import { validateRuleSet, type RuleRow } from '@/lib/payroll/forms';
import { ACADEMY_TZ, zoneOffset } from '@/lib/payroll/labels';
import { dateKeyIn } from '@/lib/schedule-time';
import { formatInstant } from '@/lib/time';
import { FormDialog, FormRow, NUMBER_INPUT, usePayrollError } from './payroll-bits';

/** The set in force now: the newest one that has started. */
export function currentSet(sets: PayRuleSetDto[], now = Date.now()): PayRuleSetDto | null {
  return (
    [...sets]
      .filter((s) => Date.parse(s.effectiveFrom) <= now)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.id - a.id)[0] ?? null
  );
}

function RulesTable({ set, label }: { set: PayRuleSetDto; label: string }) {
  const t = useTranslations('payroll.rules');
  return (
    <div className="overflow-x-auto">
      <Table aria-label={label} className="tabular-nums">
        <TableHeader className="bg-subtle">
          <TableRow>
            <TableHead className="text-start">{t('key')}</TableHead>
            <TableHead className="text-start">{t('factor')}</TableHead>
            <TableHead className="text-start">{t('billable')}</TableHead>
            <TableHead className="text-start">{t('paidHolidayOnly')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Object.entries(set.rules).map(([key, r]) => (
            <TableRow key={key}>
              <TableCell className="text-start">
                <bdi dir="ltr" className="font-mono text-sm">
                  {key}
                </bdi>
              </TableCell>
              <TableCell className="text-start">
                <bdi dir="ltr">{r.factor}</bdi>
              </TableCell>
              <TableCell className="text-start">{r.billable ? t('yes') : t('no')}</TableCell>
              <TableCell className="text-start">{r.paidHolidayOnly ? t('yes') : t('no')}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * «قواعد الأجر» (D41, docs/14 §2.9; `settings.view`, new version with `settings.manage`): how many
 * pay hours each class earns by its status. Versions are never edited: a new one starts today or
 * later, so past classes keep the hours they were stamped with.
 */
export function PayRulesView() {
  const t = useTranslations('payroll.rules');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const allowed = can(me, 'settings.view');
  const [adding, setAdding] = useState(false);
  const list = useQuery({
    queryKey: payrollKeys.ruleSets,
    queryFn: ({ signal }) => fetchPayRuleSets(signal),
    enabled: allowed,
  });
  if (!allowed || isApiError(list.error, 403)) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }
  const sets = list.data ?? [];
  const current = currentSet(sets);
  const others = sets.filter((s) => s.id !== current?.id);
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          can(me, 'settings.manage') &&
          current && (
            <Button className="h-10" onClick={() => setAdding(true)}>
              <PlusIcon />
              {t('new')}
            </Button>
          )
        }
      />
      {list.isError ? (
        <ErrorState onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : !current ? (
        <EmptyState icon={ScaleIcon} title={t('none')} description={t('description')} />
      ) : (
        <>
          <Section title={t('current')}>
            <p className="mb-3 text-sm text-muted-foreground">
              {t('since', { date: formatInstant(current.effectiveFrom, tz, locale) ?? '' })}
              {current.note && (
                <>
                  {' · '}
                  <span dir="auto">{current.note}</span>
                </>
              )}
            </p>
            <RulesTable set={current} label={t('table')} />
          </Section>
          {others.length > 0 && (
            <Section title={t('versions')}>
              <ul aria-label={t('versionsTable')} className="flex flex-col divide-y">
                {others.map((s) => (
                  <li key={s.id} className="flex flex-col gap-1 py-3">
                    <span className="font-medium">
                      {t('since', { date: formatInstant(s.effectiveFrom, tz, locale) ?? '' })}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {s.createdBy && t('createdBy', { name: s.createdBy.name })}
                      {s.note && ` · ${s.note}`}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}
      {adding && current && <RuleSetDialog base={current} onClose={() => setAdding(false)} />}
    </>
  );
}

function RuleSetDialog({ base, onClose }: { base: PayRuleSetDto; onClose: () => void }) {
  const t = useTranslations('payroll');
  const queryClient = useQueryClient();
  const message = usePayrollError();
  const ids = { date: useId(), note: useId(), rows: useId() };
  const today = dateKeyIn(ACADEMY_TZ);
  const [effectiveOn, setEffectiveOn] = useState(today);
  const [note, setNote] = useState('');
  const [rows, setRows] = useState<RuleRow[]>(() =>
    Object.entries(base.rules).map(([key, r]) => ({
      key,
      factor: String(r.factor),
      billable: r.billable,
      paidHolidayOnly: !!r.paidHolidayOnly,
    })),
  );
  const [touched, setTouched] = useState(false);
  const save = useMutation({
    mutationFn: createPayRuleSet,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: payrollKeys.ruleSets });
      toast.success(t('rules.saved'));
      onClose();
    },
  });
  const check = validateRuleSet(
    { effectiveOn, rows, note },
    { today, zoneOffset: zoneOffset(ACADEMY_TZ, effectiveOn || today) },
  );
  const err = (k: keyof typeof check.errors) =>
    touched && check.errors[k] ? t(`form.${check.errors[k]}`) : null;
  const update = (i: number, patch: Partial<RuleRow>) =>
    setRows((old) => old.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <FormDialog
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title={t('rules.newTitle')}
      description={t('rules.newDescription')}
      submitLabel={t('rules.submit')}
      busy={save.isPending}
      error={save.isError ? message(save.error) : null}
      summary={touched && !check.body ? t('form.fixErrors') : null}
      onSubmit={() => {
        setTouched(true);
        if (check.body) save.mutate(check.body);
      }}
    >
      <FormRow id={ids.date} label={t('rules.effectiveOn')} required error={err('effectiveOn')}>
        <Input
          id={ids.date}
          type="date"
          dir="ltr"
          min={today}
          value={effectiveOn}
          onChange={(e) => setEffectiveOn(e.target.value)}
          aria-invalid={!!err('effectiveOn')}
          className={NUMBER_INPUT}
        />
      </FormRow>
      <fieldset
        className="flex min-w-0 flex-col gap-2"
        aria-describedby={err('rows') ? ids.rows : undefined}
      >
        <legend className="mb-2 text-sm font-medium">{t('rules.table')}</legend>
        <div className="overflow-x-auto">
          <Table className="min-w-[32rem]">
            <TableHeader className="bg-subtle">
              <TableRow>
                <TableHead className="text-start">{t('rules.key')}</TableHead>
                <TableHead className="text-start">{t('rules.factor')}</TableHead>
                <TableHead className="text-start">{t('rules.billable')}</TableHead>
                <TableHead className="text-start">{t('rules.paidHolidayOnly')}</TableHead>
                <TableHead className="text-start">
                  <span className="sr-only">{t('actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <Input
                      dir="ltr"
                      aria-label={`${t('rules.key')} ${i + 1}`}
                      value={r.key}
                      onChange={(e) => update(i, { key: e.target.value })}
                      className="h-9 font-mono text-sm"
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      dir="ltr"
                      inputMode="decimal"
                      aria-label={`${t('rules.factor')}: ${r.key || i + 1}`}
                      value={r.factor}
                      onChange={(e) => update(i, { factor: e.target.value })}
                      className="h-9 w-20 text-start"
                    />
                  </TableCell>
                  <TableCell>
                    <Checkbox
                      aria-label={`${t('rules.billable')}: ${r.key || i + 1}`}
                      checked={r.billable}
                      onCheckedChange={(c) => update(i, { billable: c === true })}
                    />
                  </TableCell>
                  <TableCell>
                    <Checkbox
                      aria-label={`${t('rules.paidHolidayOnly')}: ${r.key || i + 1}`}
                      checked={r.paidHolidayOnly}
                      onCheckedChange={(c) => update(i, { paidHolidayOnly: c === true })}
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-9"
                      aria-label={t('rules.removeRule', { key: r.key || String(i + 1) })}
                      onClick={() => setRows((old) => old.filter((_, j) => j !== i))}
                    >
                      <Trash2Icon />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {err('rows') && (
          <p id={ids.rows} role="alert" className="text-sm text-destructive">
            {err('rows')}
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          className="self-start"
          onClick={() =>
            setRows((old) => [
              ...old,
              { key: '', factor: '0', billable: false, paidHolidayOnly: false },
            ])
          }
        >
          <PlusIcon />
          {t('rules.addRule')}
        </Button>
      </fieldset>
      <FormRow id={ids.note} label={t('rules.note')} error={err('note')}>
        <Input
          id={ids.note}
          dir="auto"
          maxLength={255}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="h-10 md:text-body"
        />
      </FormRow>
    </FormDialog>
  );
}
