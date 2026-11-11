'use client';

import {
  ATTENTION_LABELS,
  BOARD_COUNTER_LABELS,
  ENROLLMENT_STATUS_LABELS,
  REQUEST_STATUS_LABELS,
  REQUEST_TYPE_LABELS,
  SESSION_KIND_LABELS,
  SESSION_STAGE_LABELS,
  type AttentionCode,
  type EnrollmentStatus,
  type RequestStatus,
  type RequestType,
  type SessionDto,
  type SessionKind,
} from '@qarabic/shared';
import { Badge } from '@qarabic/ui/components/badge';
import { cn } from '@qarabic/ui/lib/utils';
import {
  AlarmClockIcon,
  ArrowLeftRightIcon,
  BanIcon,
  CalendarClockIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  CircleMinusIcon,
  CirclePauseIcon,
  CirclePlusIcon,
  CircleXIcon,
  FilePenLineIcon,
  HourglassIcon,
  PlaneIcon,
  RefreshCwIcon,
  StarIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from 'lucide-react';
import { useLocale } from 'next-intl';
import { displayStage, type DisplayStage } from '@/lib/sessions/board';

/**
 * Class chips (docs/15 §5.14, D35): the old system's hues, always icon + text, the English term in
 * the tooltip. shadcn `Badge` (outline) with the same tints as the People status chips.
 */
export const TONES = {
  green:
    'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300',
  amber:
    'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
  orange:
    'border-orange-200 bg-orange-50 text-orange-900 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-300',
  red: 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300',
  darkRed:
    'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300',
  purple:
    'border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-300',
  lightBlue:
    'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300',
  brown:
    'border-amber-300 bg-orange-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
  indigo:
    'border-indigo-200 bg-indigo-50 text-indigo-800 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-300',
  teal: 'border-teal-200 bg-teal-50 text-teal-800 dark:border-teal-900 dark:bg-teal-950 dark:text-teal-300',
  neutral: 'border-border bg-muted text-foreground',
  grey: 'border-border bg-muted text-muted-foreground',
} as const;
export type Tone = keyof typeof TONES;

const STAGE: Record<DisplayStage, { icon: LucideIcon; tone: Tone }> = {
  scheduled: { icon: CircleIcon, tone: 'neutral' },
  activated: { icon: CircleDotIcon, tone: 'amber' },
  in_progress: { icon: CircleDotIcon, tone: 'amber' },
  ended: { icon: FilePenLineIcon, tone: 'orange' },
  taken: { icon: CircleCheckIcon, tone: 'green' },
  absent: { icon: CircleXIcon, tone: 'red' },
  declined: { icon: BanIcon, tone: 'lightBlue' },
  leave: { icon: PlaneIcon, tone: 'purple' },
  cancelled: { icon: CircleMinusIcon, tone: 'grey' },
  moved_out: { icon: ArrowLeftRightIcon, tone: 'grey' },
  late: { icon: AlarmClockIcon, tone: 'orange' },
  suspended: { icon: CirclePauseIcon, tone: 'darkRed' },
};

const KIND: Record<SessionKind, { icon: LucideIcon; tone: Tone }> = {
  regular: { icon: CircleIcon, tone: 'neutral' },
  trial: { icon: StarIcon, tone: 'brown' },
  rescheduled: { icon: RefreshCwIcon, tone: 'teal' },
  advance: { icon: CalendarClockIcon, tone: 'indigo' },
  extra: { icon: CirclePlusIcon, tone: 'green' },
};

function useUiLocale() {
  return useLocale() === 'en' ? 'en' : 'ar';
}

export function ToneBadge({
  tone,
  icon: Icon,
  label,
  title,
  className,
}: {
  tone: Tone;
  icon?: LucideIcon;
  label: string;
  title?: string;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      title={title}
      className={cn('h-6 rounded-md px-2 text-[0.8125rem] font-medium', TONES[tone], className)}
    >
      {Icon && <Icon aria-hidden />}
      {label}
    </Badge>
  );
}

export function StageBadge({
  session,
}: {
  session: Pick<SessionDto, 'stage' | 'stageReason' | 'attention'>;
}) {
  const locale = useUiLocale();
  const shown = displayStage(session);
  const style = STAGE[shown];
  const labels =
    shown === 'late' || shown === 'suspended'
      ? BOARD_COUNTER_LABELS[shown]
      : SESSION_STAGE_LABELS[shown];
  return <ToneBadge tone={style.tone} icon={style.icon} label={labels[locale]} title={labels.en} />;
}

/** The class kind; «منتظمة» is left out unless `showRegular` (it is the usual case). */
export function KindBadge({ kind, showRegular }: { kind: SessionKind; showRegular?: boolean }) {
  const locale = useUiLocale();
  if (kind === 'regular' && !showRegular) return null;
  const style = KIND[kind];
  const label = SESSION_KIND_LABELS[kind];
  return <ToneBadge tone={style.tone} icon={style.icon} label={label[locale]} title={label.en} />;
}

const ATTENTION_TONE: Partial<Record<AttentionCode, Tone>> = {
  late: 'orange',
  late_activation: 'orange',
  report_missing: 'orange',
  needs_entry: 'amber',
  pending_request: 'amber',
  dst_adjusted: 'lightBlue',
};

/** A follow-up marker on a row (`ATTENTION_CODES`). */
export function AttentionBadge({ code }: { code: string }) {
  const locale = useUiLocale();
  const label = ATTENTION_LABELS[code as AttentionCode];
  if (!label) return null;
  return (
    <ToneBadge
      tone={ATTENTION_TONE[code as AttentionCode] ?? 'red'}
      icon={code === 'pending_request' ? HourglassIcon : TriangleAlertIcon}
      label={label[locale]}
      title={label.en}
    />
  );
}

const ENROLLMENT_TONE: Record<EnrollmentStatus, { tone: Tone; icon: LucideIcon }> = {
  active: { tone: 'green', icon: CircleCheckIcon },
  paused: { tone: 'darkRed', icon: CirclePauseIcon },
  ended: { tone: 'grey', icon: CircleMinusIcon },
};

export function EnrollmentStatusBadge({ status }: { status: EnrollmentStatus }) {
  const locale = useUiLocale();
  const label = ENROLLMENT_STATUS_LABELS[status];
  const style = ENROLLMENT_TONE[status];
  return <ToneBadge tone={style.tone} icon={style.icon} label={label[locale]} title={label.en} />;
}

const REQUEST_TONE: Record<RequestStatus, { tone: Tone; icon: LucideIcon }> = {
  pending: { tone: 'amber', icon: HourglassIcon },
  approved: { tone: 'green', icon: CircleCheckIcon },
  auto_approved: { tone: 'green', icon: CircleCheckIcon },
  rejected: { tone: 'red', icon: CircleXIcon },
  cancelled: { tone: 'grey', icon: CircleMinusIcon },
  expired: { tone: 'grey', icon: AlarmClockIcon },
};

export function RequestStatusBadge({ status }: { status: RequestStatus }) {
  const locale = useUiLocale();
  const label = REQUEST_STATUS_LABELS[status];
  const style = REQUEST_TONE[status];
  return <ToneBadge tone={style.tone} icon={style.icon} label={label[locale]} title={label.en} />;
}

const REQUEST_TYPE_TONE: Record<RequestType, Tone> = {
  leave: 'purple',
  reschedule: 'teal',
  advance: 'indigo',
  extra: 'green',
};

export function RequestTypeBadge({ type }: { type: RequestType }) {
  const locale = useUiLocale();
  const label = REQUEST_TYPE_LABELS[type];
  return <ToneBadge tone={REQUEST_TYPE_TONE[type]} label={label[locale]} title={label.en} />;
}
