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
 * the tooltip. shadcn `Badge` (outline) with the `--status-*` tones (globals.css; one place for both themes).
 */
export const TONES = {
  green: 'border-status-green-border bg-status-green text-status-green-foreground',
  amber: 'border-status-amber-border bg-status-amber text-status-amber-foreground',
  orange: 'border-status-orange-border bg-status-orange text-status-orange-foreground',
  red: 'border-status-red-border bg-status-red text-status-red-foreground',
  darkRed: 'border-status-rose-border bg-status-rose text-status-rose-foreground',
  purple: 'border-status-violet-border bg-status-violet text-status-violet-foreground',
  lightBlue: 'border-status-sky-border bg-status-sky text-status-sky-foreground',
  brown: 'border-status-brown-border bg-status-brown text-status-brown-foreground',
  indigo: 'border-status-indigo-border bg-status-indigo text-status-indigo-foreground',
  teal: 'border-status-teal-border bg-status-teal text-status-teal-foreground',
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
      className={cn('h-6 rounded-md px-2 text-caption font-medium', TONES[tone], className)}
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
