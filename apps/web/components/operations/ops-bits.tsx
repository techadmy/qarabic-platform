'use client';

import {
  OPERATIONS_ERROR_MESSAGES,
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  type TaskPriority,
  type TaskStatus,
} from '@qarabic/shared';
import { useQuery } from '@tanstack/react-query';
import {
  AlarmClockIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BanIcon,
  CircleCheckIcon,
  CircleDotIcon,
  HourglassIcon,
  MinusIcon,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Combobox } from '@/components/forms/fields';
import { ToneBadge, type Tone } from '@/components/sessions/badges';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { dayAndClock } from '@/lib/schedule-time';
import { cityOf } from '@/lib/time';
import { cn } from '@qarabic/ui/lib/utils';
import { isApiError } from '@/lib/api/client';
import { fetchTaskAssignees, operationsKeys } from '@/lib/api/operations';

/** Operations refusals (apps/api `operations/errors.ts`) in the UI language. */
export function useOperationsError() {
  const t = useTranslations('operations.errors');
  const locale = useUiLocale();
  return (error: unknown): string => {
    if (!isApiError(error)) return t('generic');
    const code = error.code ?? '';
    if (code in OPERATIONS_ERROR_MESSAGES) {
      return OPERATIONS_ERROR_MESSAGES[code as keyof typeof OPERATIONS_ERROR_MESSAGES][locale];
    }
    if (error.status === 404) return t('notFound');
    if (error.status === 403) return t('forbidden');
    if (error.status === 422) return t('invalid');
    return t('generic');
  };
}

const STATUS: Record<TaskStatus, { icon: LucideIcon; tone: Tone }> = {
  pending: { icon: CircleDotIcon, tone: 'lightBlue' },
  awaiting: { icon: HourglassIcon, tone: 'amber' },
  completed: { icon: CircleCheckIcon, tone: 'green' },
  closed: { icon: BanIcon, tone: 'grey' },
};

export function TaskStatusBadge({ status, overdue }: { status: TaskStatus; overdue?: boolean }) {
  const t = useTranslations('operations.tasks');
  const locale = useUiLocale();
  if (overdue) return <ToneBadge tone="red" icon={AlarmClockIcon} label={t('overdue')} />;
  const s = STATUS[status];
  return (
    <ToneBadge
      tone={s.tone}
      icon={s.icon}
      label={TASK_STATUS_LABELS[status][locale]}
      title={TASK_STATUS_LABELS[status].en}
    />
  );
}

const PRIORITY: Record<TaskPriority, { icon: LucideIcon; tone: Tone }> = {
  high: { icon: ArrowUpIcon, tone: 'orange' },
  normal: { icon: MinusIcon, tone: 'neutral' },
  low: { icon: ArrowDownIcon, tone: 'grey' },
};

export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  const locale = useUiLocale();
  const p = PRIORITY[priority];
  return (
    <ToneBadge
      tone={p.tone}
      icon={p.icon}
      label={TASK_PRIORITY_LABELS[priority][locale]}
      title={TASK_PRIORITY_LABELS[priority].en}
    />
  );
}

/**
 * An instant in the viewer's zone with the zone named (D30, docs/15 §5.12):
 * «الجمعة، 13 نوفمبر، 10:30 ص (القاهرة)».
 */
export function ViewerTime({ at, className }: { at: string; className?: string }) {
  const locale = useUiLocale();
  const tz = useViewerTz();
  return (
    <span className={cn('whitespace-nowrap', className)}>
      <bdi>{dayAndClock(at, tz, locale)}</bdi>{' '}
      <span className="text-muted-foreground">({cityOf(tz, locale)})</span>
    </span>
  );
}

/** Active staff to give a task to (`GET /tasks/assignees`, searched on the server). */
export function AssigneePicker({
  id,
  value,
  onChange,
  invalid,
}: {
  id: string;
  value: { id: number; name: string } | null;
  onChange: (v: { id: number; name: string } | null) => void;
  invalid?: boolean;
}) {
  const t = useTranslations('operations.tasks');
  const [q, setQ] = useState('');
  const list = useQuery({
    queryKey: operationsKeys.assignees(q),
    queryFn: ({ signal }) => fetchTaskAssignees(q, signal),
  });
  const options = (list.data ?? []).map((p) => ({
    value: String(p.id),
    label: p.name,
    hint: p.role ?? undefined,
  }));
  if (value && !options.some((o) => o.value === String(value.id))) {
    options.unshift({ value: String(value.id), label: value.name, hint: undefined });
  }
  return (
    <Combobox
      id={id}
      value={value ? String(value.id) : null}
      onChange={(v) => {
        const p = list.data?.find((x) => String(x.id) === v);
        onChange(p ? { id: p.id, name: p.name } : null);
      }}
      options={options}
      invalid={invalid}
      shouldFilter={false}
      onSearch={setQ}
      loading={list.isPending}
      placeholder={t('pickAssignee')}
      searchPlaceholder={t('searchAssignee')}
    />
  );
}
