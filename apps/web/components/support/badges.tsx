'use client';

import {
  TICKET_PRIORITY_LABELS,
  TICKET_QUEUE_LABELS,
  TICKET_STATUS_LABELS,
  type SlaState,
  type TicketPriority,
  type TicketQueue,
  type TicketStatus,
} from '@qarabic/shared';
import {
  AlarmClockIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleHelpIcon,
  CircleIcon,
  CircleMinusIcon,
  LockIcon,
  TimerIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ToneBadge, type Tone } from '@/components/sessions/badges';
import { useNow, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { dayAndClock } from '@/lib/schedule-time';
import { durationParts } from '@/lib/support/labels';

/** Ticket chips (docs/15 §5.14): icon + text, the English term in the tooltip. */
const STATUS: Record<TicketStatus, { icon: LucideIcon; tone: Tone }> = {
  new: { icon: CircleIcon, tone: 'lightBlue' },
  triaged: { icon: CircleDotIcon, tone: 'indigo' },
  in_progress: { icon: WrenchIcon, tone: 'amber' },
  needs_info: { icon: CircleHelpIcon, tone: 'orange' },
  fixed: { icon: CircleCheckIcon, tone: 'teal' },
  verified: { icon: CircleCheckIcon, tone: 'green' },
  wont_fix: { icon: CircleMinusIcon, tone: 'grey' },
};

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  const locale = useUiLocale();
  const label = TICKET_STATUS_LABELS[status];
  const s = STATUS[status];
  return <ToneBadge tone={s.tone} icon={s.icon} label={label[locale]} title={label.en} />;
}

const PRIORITY: Record<TicketPriority, Tone> = {
  p0: 'darkRed',
  p1: 'orange',
  p2: 'neutral',
  p3: 'grey',
};

export function PriorityBadge({ priority }: { priority: TicketPriority | null }) {
  const t = useTranslations('support');
  const locale = useUiLocale();
  if (!priority) return <ToneBadge tone="grey" label={t('priorityNone')} />;
  return (
    <ToneBadge
      tone={PRIORITY[priority]}
      label={TICKET_PRIORITY_LABELS[priority][locale]}
      title={TICKET_PRIORITY_LABELS[priority].en}
    />
  );
}

export function QueueBadge({ queue }: { queue: TicketQueue }) {
  const locale = useUiLocale();
  return <ToneBadge tone="neutral" label={TICKET_QUEUE_LABELS[queue][locale]} />;
}

export function RestrictedBadge() {
  const t = useTranslations('support.ticket');
  return <ToneBadge tone="purple" icon={LockIcon} label={t('restricted')} />;
}

/** «3 س 20 د» */
export function useDuration() {
  const t = useTranslations('support.sla');
  return (minutes: number) => {
    const { d, h, m } = durationParts(minutes);
    if (d > 0) return t('days', { d, h });
    if (h > 0) return t('hours', { h, m });
    return t('minutes', { m });
  };
}

/**
 * The first-reply timer (docs/32 §5): time left, or how long it is overdue (red); the exact due
 * time in the viewer's zone in the tooltip (D30). Nothing once closed or without a deadline.
 */
export function SlaBadge({ dueAt, state }: { dueAt: string | null; state: SlaState }) {
  const t = useTranslations('support.sla');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const now = useNow(30_000);
  const duration = useDuration();
  if (!dueAt || state === 'none') return null;
  if (state === 'met') return <ToneBadge tone="green" icon={CircleCheckIcon} label={t('met')} />;
  const left = (Date.parse(dueAt) - now.getTime()) / 60_000;
  const breached = state === 'breached' || left < 0;
  return (
    <ToneBadge
      tone={breached ? 'red' : state === 'due_soon' ? 'amber' : 'neutral'}
      icon={breached ? AlarmClockIcon : TimerIcon}
      label={
        breached ? t('overdue', { time: duration(-left) }) : t('due', { time: duration(left) })
      }
      title={`${t('label')}: ${dayAndClock(dueAt, tz, locale)}`}
      className={breached ? 'font-semibold' : undefined}
    />
  );
}

/** The «طلباتي» dot: a ticket changed since the requester last opened it. */
export function UpdateDot({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary">
      <span aria-hidden className="size-2.5 rounded-full bg-primary" />
      {label}
    </span>
  );
}
