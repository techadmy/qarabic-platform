'use client';

import {
  LEAD_STATUS_LABELS,
  type LeadAllowedAction,
  type LeadDetailDto,
  type LeadStatus,
} from '@qarabic/shared';
import {
  BanIcon,
  BriefcaseIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  CircleXIcon,
  PhoneIcon,
  StarIcon,
  TimerIcon,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ToneBadge, type Tone } from '@/components/sessions/badges';
import { useUiLocale } from '@/components/sessions/times';
import { isApiError } from '@/lib/api/client';

/** Status chips of the pipeline (D35: icon + text, never colour alone), hues of the current app. */
const STATUS: Record<LeadStatus, { icon: LucideIcon; tone: Tone }> = {
  new: { icon: CircleIcon, tone: 'lightBlue' },
  contacted: { icon: PhoneIcon, tone: 'amber' },
  trial_scheduled: { icon: StarIcon, tone: 'purple' },
  trial_done: { icon: CircleDotIcon, tone: 'purple' },
  converted: { icon: CircleCheckIcon, tone: 'green' },
  lost: { icon: CircleXIcon, tone: 'red' },
  spam: { icon: BanIcon, tone: 'grey' },
  job_applicant: { icon: BriefcaseIcon, tone: 'grey' },
};

export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  const locale = useUiLocale();
  const s = STATUS[status];
  return (
    <ToneBadge
      tone={s.tone}
      icon={s.icon}
      label={LEAD_STATUS_LABELS[status][locale]}
      title={LEAD_STATUS_LABELS[status].en}
    />
  );
}

/** «تجاوز مهلة التواصل»: a new lead nobody answered within the first-response time. */
export function OverdueBadge() {
  const t = useTranslations('crm');
  return <ToneBadge tone="red" icon={TimerIcon} label={t('overdue')} />;
}

/** Stage-driven primary action of the workbench (docs/26 §9.3): one contained button. */
export type PrimaryAction = 'contact' | 'book_trial' | 'record_outcome' | 'convert';

export function primaryAction(
  lead: Pick<LeadDetailDto, 'status' | 'allowedActions'>,
): PrimaryAction | null {
  const can = (a: LeadAllowedAction) => lead.allowedActions.includes(a);
  const canBook = can('book_trial') || can('create_account');
  switch (lead.status) {
    case 'new':
      return can('add_activity') ? 'contact' : null;
    case 'contacted':
      return canBook ? 'book_trial' : can('convert') ? 'convert' : null;
    case 'trial_scheduled':
      return can('record_outcome') ? 'record_outcome' : null;
    case 'trial_done':
      return can('convert') ? 'convert' : null;
    default:
      return null;
  }
}

/** CRM refusals (apps/api README N5) in the UI language; never the server's English text. */
export function useCrmError() {
  const t = useTranslations('crm.errors');
  return (error: unknown): string => {
    if (!isApiError(error)) return t('generic');
    const code = error.code ?? '';
    const errors = error.error?.errors ?? {};
    if (error.status === 429) return t('tooMany');
    if (error.status === 404) return t('notFound');
    if (error.status === 403) return t('forbidden');
    if (code === 'schedule_conflict') return t('conflict');
    if (code === 'warnings_not_acknowledged') return t('warnings');
    if (code === 'invalid_transition') return t('invalidTransition');
    if (code === 'already_has_family') return t('alreadyHasFamily');
    if (code === 'email_taken') return t('emailTaken');
    if (code === 'no_family') return t('noFamily');
    if (code === 'already_enrolled') return t('alreadyEnrolled');
    if (errors.localTime) return t('pastTime');
    if (errors.meetingUrl) return t('meetingUrl');
    if (errors.userId) return t('assignee');
    if (error.status === 422) return t('invalid');
    return t('generic');
  };
}
